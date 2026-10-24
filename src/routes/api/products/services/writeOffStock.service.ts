import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { isRetryableTxError, tx } from '@db/client.js';
import { shopToday } from '@helpers/shopDay.js';
import { setUserContext } from '@db/dbContext.service.js';
import { expiredUnitsOf } from '@db/expiredStock.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { InternalError, ResourceBusyError, isAppError } from '@utils/errors.js';

import {
  assertWriteOffFits,
  normalizeWriteOffInput,
  stockErrorOf,
  stockSummaryOf,
  writeOffSteps,
  withProductIds,
} from './helpers/index.js';

import type {
  WriteOffStockDto,
  WriteOffStockResponseDto,
  WriteOffTakenDto,
} from 'types/dto/products.dto.js';
import type { ProductId } from 'types/ids.js';

type Taken = { batchId: number; quantity: number; unitCost: string };

// writes off free units, all of the items or none: from the batch an item names, or from the
// batches in the order of a sale (the one that ends first, then the oldest). The units the waiting
// orders hold are not written off. The database takes the units out
// (cartlify.write_off_product_stock, db/05) and keeps a line in the admin log for each item with
// the reason, the batches and their costs. A product removed from the catalog keeps its units
// until they are written off, so it is written off too
export async function writeOffStock(dto: WriteOffStockDto): Promise<WriteOffStockResponseDto> {
  const { actorId, actorRole } = dto;
  assertAdminActor(actorId, actorRole);

  const writeOff = normalizeWriteOffInput({
    ...dto,
    items: await withProductIds(dto.items, dto),
  });
  const writeOffId = randomUUID();
  const productIds = [...new Set(writeOff.items.map((item) => item.productId))].sort(
    (a, b) => a - b,
  );
  const batchIds = [
    ...new Set(writeOff.items.flatMap((item) => (item.batchId === null ? [] : [item.batchId]))),
  ];

  try {
    return await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // the products are locked by id, as every step of the stock locks them: their batches
        // cannot change until the end of the request
        const products = await db.$queryRaw<{ id: number; stock: number; reservedStock: number }[]>`
          select id, stock, "reservedStock"
          from cartlify.products
          where id = any(${productIds}::int[])
          order by id
          for update
        `;
        const batches = batchIds.length
          ? await db.productBatch.findMany({
              where: { id: { in: batchIds } },
              select: { id: true, productId: true, remaining: true, expiresAt: true },
            })
          : [];

        // a batch is over once its last good day is behind the day of the shop
        const today = shopToday();
        assertWriteOffFits({
          items: writeOff.items,
          products: new Map(products.map((row) => [row.id, row])),
          batches: new Map(
            batches.map((row) => [
              row.id,
              {
                productId: row.productId,
                remaining: row.remaining,
                expired: row.expiresAt !== null && row.expiresAt.toISOString().slice(0, 10) < today,
              },
            ]),
          ),
          expired: await expiredUnitsOf(db, productIds),
        });

        const taken: Taken[][] = [];
        for (const { item, index } of writeOffSteps(writeOff.items)) {
          try {
            const [row] = await db.$queryRaw<{ taken: Taken[] }[]>`
              select cartlify.write_off_product_stock(
                ${writeOffId}::uuid,
                ${item.productId}::int,
                ${item.batchId}::int,
                ${item.quantity}::int,
                ${writeOff.reason}::text,
                ${writeOff.note}::text
              ) as taken
            `;
            taken[index] = row!.taken;
          } catch (err) {
            throw stockErrorOf(err, item) ?? err;
          }
        }

        const after = await db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, stock: true, reservedStock: true },
        });

        return {
          writeOffId,
          items: writeOff.items.map((item, index) => ({
            productId: item.productId as ProductId,
            quantity: item.quantity,
            batches: taken[index]!.map((line): WriteOffTakenDto => ({
              batchId: line.batchId,
              quantity: line.quantity,
              unitCost: Number(line.unitCost),
            })),
          })),
          products: stockSummaryOf(
            after,
            await expiredUnitsOf(
              db,
              after.map((row) => row.id),
            ),
          ),
        };
      },
      {
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );
  } catch (err) {
    if (isAppError(err)) throw err;

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) throw new ResourceBusyError();

    throw new InternalError({ reason: 'STOCK_WRITE_OFF_UNEXPECTED' }, err);
  }
}
