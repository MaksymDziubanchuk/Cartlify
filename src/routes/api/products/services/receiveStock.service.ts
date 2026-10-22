import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { isRetryableTxError, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { expiredUnitsOf } from '@db/expiredStock.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { InternalError, ResourceBusyError, isAppError } from '@utils/errors.js';

import {
  deliverySteps,
  normalizeDeliveryInput,
  stockErrorOf,
  stockSummaryOf,
} from './helpers/index.js';

import type {
  ProductBatchDto,
  ReceiveStockDto,
  ReceiveStockResponseDto,
  StockSourceName,
} from 'types/dto/products.dto.js';
import type { ProductId } from 'types/ids.js';

// takes in a delivery: a batch of each item at its cost, all of them or none. The database takes
// each batch in (cartlify.receive_product_batch, db/05): the stock grows by it and the admin log
// keeps a line for it with the delivery, the supplier, the invoice and the note, in the name of
// the admin. A product removed from the catalog takes in nothing
export async function receiveStock(dto: ReceiveStockDto): Promise<ReceiveStockResponseDto> {
  const { actorId, actorRole } = dto;
  assertAdminActor(actorId, actorRole);

  const delivery = normalizeDeliveryInput(dto);
  const deliveryId = randomUUID();

  try {
    return await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // the rows of the products are locked by the id of the product, in every request
        const batchIds: number[] = [];
        for (const { item, index } of deliverySteps(delivery.items)) {
          try {
            const [row] = await db.$queryRaw<{ id: number }[]>`
              select cartlify.receive_product_batch(
                ${deliveryId}::uuid,
                ${item.productId}::int,
                ${delivery.source}::cartlify."StockSource",
                ${item.quantity}::int,
                ${item.unitCost}::numeric,
                ${item.expiresAt}::date,
                ${item.supplierBatchNumber}::text,
                ${delivery.supplier}::text,
                ${delivery.document}::text,
                ${delivery.note}::text
              ) as id
            `;
            batchIds[index] = row!.id;
          } catch (err) {
            throw stockErrorOf(err, item) ?? err;
          }
        }

        const batches = await db.productBatch.findMany({
          where: { id: { in: batchIds } },
          select: {
            id: true,
            productId: true,
            source: true,
            supplierBatchNumber: true,
            unitCost: true,
            quantity: true,
            remaining: true,
            expiresAt: true,
            createdAt: true,
          },
        });
        const byId = new Map(batches.map((batch) => [batch.id, batch]));

        const products = await db.product.findMany({
          where: { id: { in: [...new Set(delivery.items.map((item) => item.productId))] } },
          select: { id: true, stock: true, reservedStock: true },
        });

        return {
          deliveryId,
          batches: batchIds.map((id): ProductBatchDto => {
            const batch = byId.get(id)!;
            return {
              id: batch.id,
              productId: batch.productId as ProductId,
              source: batch.source as StockSourceName,
              supplierBatchNumber: batch.supplierBatchNumber,
              unitCost: decimalToNumber(batch.unitCost),
              quantity: batch.quantity,
              remaining: batch.remaining,
              expiresAt: batch.expiresAt ? batch.expiresAt.toISOString().slice(0, 10) : null,
              createdAt: batch.createdAt,
            };
          }),
          products: stockSummaryOf(
            products,
            await expiredUnitsOf(
              db,
              products.map((row) => row.id),
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
    if (isRetryableTxError(err)) throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');

    throw new InternalError({ reason: 'STOCK_DELIVERY_UNEXPECTED' }, err);
  }
}
