import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { isRetryableTxError, tx } from '@db/client.js';
import { shopToday } from '@helpers/shopDay.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeStockOperationAuditLog } from '@db/adminAudit.helper.js';
import { expiredUnitsOf } from '@db/expiredStock.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { InternalError, ResourceBusyError, isAppError } from '@utils/errors.js';

import {
  assertWriteOffFits,
  normalizeWriteOffInput,
  stockErrorOf,
  stockRefsOf,
  stockSummaryOf,
  withVariantIds,
  writeOffSteps,
  type WriteOffItem,
} from './helpers/index.js';

import type {
  WriteOffStockDto,
  WriteOffStockResponseDto,
  WriteOffTakenDto,
} from 'types/dto/products.dto.js';

type Taken = { batchId: number; quantity: number; unitCost: string };

// writes off free units, all of the items or none: from the batch an item names, or from the
// batches in the order of a sale (the one that ends first, then the oldest). An item names its
// variant by its id, its article number or its barcode. The units the waiting orders hold are not
// written off. The database takes the units out (cartlify.write_off_variant_stock, db/05) and
// keeps a line in the stock log for each item with the reason, the batches and their costs. The
// admin log keeps one line for the whole write-off, with the same id of the write-off. A variant
// taken out of sale keeps its units until they are written off, so it is written off too
export async function writeOffStock(dto: WriteOffStockDto): Promise<WriteOffStockResponseDto> {
  const { actorId, actorRole } = dto;
  assertAdminActor(actorId, actorRole);

  const writeOff = normalizeWriteOffInput(dto);
  const items: WriteOffItem[] = await withVariantIds(writeOff.items, dto, { deleted: true });
  const variantIds = [...new Set(items.map((item) => item.variantId))].sort((a, b) => a - b);
  const writeOffId = randomUUID();
  const batchIds = [
    ...new Set(items.flatMap((item) => (item.batchId === null ? [] : [item.batchId]))),
  ];

  try {
    return await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // the variants are locked by id, as every step of the stock locks them: their batches
        // cannot change until the end of the request
        const variants = await db.$queryRaw<
          { id: number; productId: number; stock: number; reservedStock: number }[]
        >`
          select id, "productId", stock, "reservedStock"
          from cartlify.product_variants
          where id = any(${variantIds}::int[])
          order by id
          for update
        `;
        const batches = batchIds.length
          ? await db.productBatch.findMany({
              where: { id: { in: batchIds } },
              select: { id: true, variantId: true, remaining: true, expiresAt: true },
            })
          : [];

        // a batch is over once its last good day is behind the day of the shop
        const today = shopToday();
        assertWriteOffFits({
          items,
          variants: new Map(variants.map((row) => [row.id, row])),
          batches: new Map(
            batches.map((row) => [
              row.id,
              {
                variantId: row.variantId,
                remaining: row.remaining,
                expired: row.expiresAt !== null && row.expiresAt.toISOString().slice(0, 10) < today,
              },
            ]),
          ),
          expired: await expiredUnitsOf(db, variantIds),
        });

        const taken: Taken[][] = [];
        for (const { item, index } of writeOffSteps(items)) {
          try {
            const [row] = await db.$queryRaw<{ taken: Taken[] }[]>`
              select cartlify.write_off_variant_stock(
                ${writeOffId}::uuid,
                ${item.variantId}::int,
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

        // one line of the admin log for the whole write-off, the id of it among its changes
        await writeStockOperationAuditLog(db, {
          actorId,
          actorRole,
          kind: 'write_off',
          operationId: writeOffId,
          variantIds,
          quantity: items.reduce((sum, item) => sum + item.quantity, 0),
          details: [
            { field: 'reason', value: writeOff.reason },
            { field: 'note', value: writeOff.note },
          ],
        });

        const refs = await stockRefsOf(db, variantIds);
        const after = await db.productVariant.findMany({
          where: { id: { in: variantIds } },
          select: { id: true, productId: true, stock: true, reservedStock: true },
        });

        return {
          writeOffId,
          items: items.map((item, index) => ({
            ...refs.get(item.variantId)!,
            quantity: item.quantity,
            batches: taken[index]!.map((line): WriteOffTakenDto => ({
              batchId: line.batchId,
              quantity: line.quantity,
              unitCost: Number(line.unitCost),
            })),
          })),
          variants: stockSummaryOf(after, await expiredUnitsOf(db, variantIds)),
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
