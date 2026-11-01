import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

import { isRetryableTxError, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeStockOperationAuditLog } from '@db/adminAudit.helper.js';
import { expiredUnitsOf } from '@db/expiredStock.helper.js';
import { assertAdminActor } from '@helpers/roleGuard.js';
import { decimalToNumber } from '@helpers/safeNormalizer.js';
import { InternalError, ResourceBusyError, isAppError } from '@utils/errors.js';

import {
  deliverySteps,
  normalizeDeliveryInput,
  stockErrorOf,
  stockRefsOf,
  stockSummaryOf,
  withVariantIds,
  type DeliveryItem,
} from './helpers/index.js';

import type {
  ProductBatchDto,
  ReceiveStockDto,
  ReceiveStockResponseDto,
  StockSourceName,
} from 'types/dto/products.dto.js';

// takes in a delivery: a batch of each item at its cost, all of them or none. An item names its
// variant by its id, its article number or its barcode; the cost and the last good day of the
// delivery stand in for the item that has none of its own. The database takes each batch in
// (cartlify.receive_variant_batch, db/05): the stock of the variant grows by it and the stock log
// keeps a line for it with the delivery, the batch, the supplier, the invoice and the note, in the
// name of the admin. The admin log keeps one line for the whole delivery, with the same id of the
// delivery. A variant taken out of sale takes in nothing
export async function receiveStock(dto: ReceiveStockDto): Promise<ReceiveStockResponseDto> {
  const { actorId, actorRole } = dto;
  assertAdminActor(actorId, actorRole);

  const delivery = normalizeDeliveryInput(dto);
  const items: DeliveryItem[] = await withVariantIds(delivery.items, dto, { deleted: false });
  const deliveryId = randomUUID();

  try {
    return await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // the rows of the variants are locked by the id of the variant, in every request
        const batchIds: number[] = [];
        for (const { item, index } of deliverySteps(items)) {
          try {
            const [row] = await db.$queryRaw<{ id: number }[]>`
              select cartlify.receive_variant_batch(
                ${deliveryId}::uuid,
                ${item.variantId}::int,
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

        // one line of the admin log for the whole delivery, the id of it among its changes
        await writeStockOperationAuditLog(db, {
          actorId,
          actorRole,
          kind: 'delivery',
          operationId: deliveryId,
          variantIds: [...new Set(items.map((item) => item.variantId))],
          quantity: items.reduce((sum, item) => sum + item.quantity, 0),
          details: [
            { field: 'source', value: delivery.source },
            { field: 'supplier', value: delivery.supplier },
            { field: 'document', value: delivery.document },
            { field: 'note', value: delivery.note },
          ],
        });

        const batches = await db.productBatch.findMany({
          where: { id: { in: batchIds } },
          select: {
            id: true,
            variantId: true,
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

        const variantIds = [...new Set(items.map((item) => item.variantId))];
        const refs = await stockRefsOf(db, variantIds);
        const variants = await db.productVariant.findMany({
          where: { id: { in: variantIds } },
          select: { id: true, productId: true, stock: true, reservedStock: true },
        });

        return {
          deliveryId,
          batches: batchIds.map((id): ProductBatchDto => {
            const batch = byId.get(id)!;
            return {
              ...refs.get(batch.variantId)!,
              id: batch.id,
              source: batch.source as StockSourceName,
              supplierBatchNumber: batch.supplierBatchNumber,
              unitCost: decimalToNumber(batch.unitCost),
              quantity: batch.quantity,
              remaining: batch.remaining,
              expiresAt: batch.expiresAt ? batch.expiresAt.toISOString().slice(0, 10) : null,
              createdAt: batch.createdAt,
            };
          }),
          variants: stockSummaryOf(variants, await expiredUnitsOf(db, variantIds)),
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

    throw new InternalError({ reason: 'STOCK_DELIVERY_UNEXPECTED' }, err);
  }
}
