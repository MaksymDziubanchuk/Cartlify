import { expiredUnitsOf, freeUnits } from '@db/expiredStock.helper.js';
import { Prisma } from '@prisma/client';
import { tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  isAppError,
  ResourceBusyError,
} from '@utils/errors.js';
import {
  dropHiddenVariantItems,
  isOrderNotEditable,
  mapOrderRowToResponse,
  orderContextOf,
  readOrderResponse,
} from './helpers/index.js';

import { visibleVariantWhere } from '@routes/api/products/services/helpers/variant.helper.js';

import type { CurrentAddItemDto, OrderResponseDto } from 'types/dto/orders.dto.js';

// adds a variant to the cart, or, with orderId, to an own order that lost its reservation
// (unconfirmed): its items can change before it is confirmed again. The same variant again adds the
// units to its position. A variant a buyer does not see (taken out of sale, its product removed,
// no picture) is not found
export async function addCurrentItem({
  actorId,
  actorRole,
  variantId,
  quantity,
  orderId: unconfirmedOrderId,
}: CurrentAddItemDto): Promise<OrderResponseDto> {
  // enforce user-only cart writes
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  try {
    return await tx(
      async (db) => {
        // set rls session context
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        let orderId: number;

        if (unconfirmedOrderId !== undefined) {
          // an own unconfirmed order, any other is not found
          const order = await db.order.findFirst({
            where: {
              id: Number(unconfirmedOrderId),
              userId: actorId as any,
              confirmed: false,
              status: 'unconfirmed',
            },
            select: { id: true },
          });
          if (!order) throw new NotFoundError('ORDER_NOT_FOUND', { orderId: unconfirmedOrderId });

          orderId = order.id;
        } else {
          // load or create current open order
          const existingOrder = await db.order.findFirst({
            where: { userId: actorId as any, confirmed: false, status: 'pending' },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          });

          orderId = existingOrder
            ? existingOrder.id
            : (
                await db.order.create({
                  data: {
                    userId: actorId as any,
                    total: new Prisma.Decimal(0),
                    confirmed: false,
                    status: 'pending',
                  },
                  select: { id: true },
                })
              ).id;
        }

        // load the variant, its price and availability; the one a buyer does not see is not found
        const variant = await db.productVariant.findFirst({
          where: { id: variantId, ...visibleVariantWhere, product: { deletedAt: null } },
          select: { id: true, productId: true, price: true, stock: true, reservedStock: true },
        });

        if (!variant) throw new NotFoundError('VARIANT_NOT_FOUND', { variantId });

        // check availability: the stock less what the waiting orders hold and what is over
        const expired = await expiredUnitsOf(db, [variant.id]);
        const available = freeUnits(
          variant.stock,
          variant.reservedStock,
          expired.get(variant.id) ?? 0,
        );

        // upsert item in open order: one position for a variant
        const existingItem = await db.orderItem.findFirst({
          where: { orderId, variantId: variant.id },
          select: { id: true, quantity: true },
        });

        const nextQty = (existingItem?.quantity ?? 0) + quantity;
        if (nextQty > available) {
          throw new ConflictError('OUT_OF_STOCK', { variantId, available, requested: nextQty });
        }

        // always store latest variant price
        const unitPrice = variant.price;

        if (existingItem) {
          await db.orderItem.update({
            where: { id: existingItem.id },
            data: { quantity: nextQty, unitPrice: unitPrice as any },
            select: { id: true },
          });
        } else {
          // totalPrice is required by prisma model; db trigger overwrites it
          await db.orderItem.create({
            data: {
              orderId,
              productId: variant.productId,
              variantId: variant.id,
              quantity: nextQty,
              unitPrice: unitPrice as any,
              totalPrice: new Prisma.Decimal(0),
            },
            select: { id: true },
          });
        }

        // bring the other items to current variant prices too, the order also loses the items of
        // variants a buyer does not see; confirm refuses an order with outdated prices, so the
        // order must show what will be confirmed
        await dropHiddenVariantItems(db, Number(actorId), [orderId]);
        await db.$executeRaw`select cartlify.refresh_order_prices(${orderId}::int)`;

        // totals are maintained by db triggers; fetch current order
        const order = await readOrderResponse(db, orderId);

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_UPDATE' });

        return mapOrderRowToResponse(order, await orderContextOf(db, [order]));
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 10_000,
        timeout: 10_000,
      },
    );
  } catch (err) {
    if (isAppError(err)) throw err;

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) {
      throw new ResourceBusyError();
    }

    // another request confirmed the cart while this one changed it
    if (isOrderNotEditable(err)) throw new ConflictError('ORDER_NOT_EDITABLE');

    throw new InternalError({ reason: 'ORDERS_CURRENT_ADD_ITEM_UNEXPECTED' }, err);
  }
}
