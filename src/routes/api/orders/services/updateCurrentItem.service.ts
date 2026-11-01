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
  orderTargetSql,
} from './helpers/index.js';

import { visibleVariantWhere } from '@routes/api/products/services/helpers/variant.helper.js';

import type { CurrentUpdateItemDto, OrderResponseDto } from 'types/dto/orders.dto.js';

// changes an item of the cart, or, with orderId, of an own unconfirmed order
export async function updateCurrentItem({
  actorId,
  actorRole,
  itemId,
  quantity,
  orderId,
}: CurrentUpdateItemDto): Promise<OrderResponseDto> {
  // enforce user-only cart writes
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  const itemIdRaw = Number(itemId);
  const actorIdRaw = Number(actorId);

  try {
    return await tx(
      async (db) => {
        // set rls session context
        await setUserContext(db, { userId: actorId, role: actorRole });

        // bound lock wait
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // lock item row and ensure it belongs to the actor cart, or to the given own unconfirmed order
        const locked = await db.$queryRaw<{ id: number }[]>`
          SELECT oi.id
          FROM cartlify.order_items oi
          JOIN cartlify.orders o ON o.id = oi."orderId"
          WHERE oi.id = ${itemIdRaw}
            AND o."userId" = ${actorIdRaw}
            AND o.confirmed = false
            AND ${orderTargetSql(orderId)}
          FOR UPDATE OF oi
        `;
        if (!locked.length) throw new NotFoundError('ORDER_ITEM_NOT_FOUND', { itemId: itemIdRaw });

        // load item refs (orderId + variantId)
        const item = await db.orderItem.findUnique({
          where: { id: itemIdRaw },
          select: { id: true, orderId: true, variantId: true },
        });
        if (!item) throw new NotFoundError('ORDER_ITEM_NOT_FOUND', { itemId: itemIdRaw });

        // load the variant of the item, its price and availability; a variant a buyer does not see
        // any more is not found
        const variant = await db.productVariant.findFirst({
          where: { id: item.variantId, ...visibleVariantWhere, product: { deletedAt: null } },
          select: { id: true, price: true, stock: true, reservedStock: true },
        });
        if (!variant) throw new NotFoundError('VARIANT_NOT_FOUND', { variantId: item.variantId });

        // check availability: the stock less what the waiting orders hold and what is over
        const expired = await expiredUnitsOf(db, [variant.id]);
        const available = freeUnits(
          variant.stock,
          variant.reservedStock,
          expired.get(variant.id) ?? 0,
        );
        if (quantity > available) {
          throw new ConflictError('OUT_OF_STOCK', {
            variantId: variant.id,
            available,
            requested: quantity,
          });
        }

        // always store latest variant price
        await db.orderItem.update({
          where: { id: itemIdRaw },
          data: { quantity, unitPrice: variant.price as any },
          select: { id: true },
        });

        // bring the other items to current variant prices too, the order also loses the items of
        // variants a buyer does not see; confirm refuses an order with outdated prices, so the
        // order must show what will be confirmed
        await dropHiddenVariantItems(db, actorIdRaw, [item.orderId]);
        await db.$executeRaw`select cartlify.refresh_order_prices(${item.orderId}::int)`;

        // totals are maintained by db triggers; fetch current order
        const order = await readOrderResponse(db, item.orderId);

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_UPDATE' });

        return mapOrderRowToResponse(order, await orderContextOf(db, [order]));
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    // map lock/tx contention errors to a stable 409 for clients
    if (isRetryableTxError(err)) {
      throw new ResourceBusyError();
    }

    // another request confirmed the cart while this one changed it
    if (isOrderNotEditable(err)) throw new ConflictError('ORDER_NOT_EDITABLE');

    throw new InternalError({ reason: 'ORDERS_CURRENT_UPDATE_ITEM_UNEXPECTED' }, err);
  }
}
