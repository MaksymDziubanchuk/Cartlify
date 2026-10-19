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
  dropDeletedProductItems,
  isOrderNotEditable,
  mapOrderRowToResponse,
  orderResponseSelect,
  orderTargetSql,
} from './helpers/index.js';

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

        // load item refs (orderId + productId)
        const item = await db.orderItem.findUnique({
          where: { id: itemIdRaw },
          select: { id: true, orderId: true, productId: true },
        });
        if (!item) throw new NotFoundError('ORDER_ITEM_NOT_FOUND', { itemId: itemIdRaw });

        // load product price and availability
        const product = await db.product.findFirst({
          where: { id: item.productId, deletedAt: null },
          select: { id: true, price: true, stock: true, reservedStock: true },
        });
        if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND', { productId: item.productId });

        // check availability (real stock = stock - reservedStock)
        const available = product.stock - product.reservedStock;
        if (quantity > available) {
          throw new ConflictError('OUT_OF_STOCK', {
            productId: product.id,
            available,
            requested: quantity,
          });
        }

        // always store latest product price
        await db.orderItem.update({
          where: { id: itemIdRaw },
          data: { quantity, unitPrice: product.price as any },
          select: { id: true },
        });

        // bring the other items to current product prices too, the order also loses the items of
        // products deleted from the catalog; confirm refuses an order with outdated prices, so the
        // order must show what will be confirmed
        await dropDeletedProductItems(db, actorIdRaw, [item.orderId]);
        await db.$executeRaw`select cartlify.refresh_order_prices(${item.orderId}::int)`;

        // totals are maintained by db triggers; fetch current order
        const order = await db.order.findUnique({
          where: { id: item.orderId },
          select: orderResponseSelect,
        });

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_UPDATE' });

        return mapOrderRowToResponse(order);
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
      throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
    }

    // another request confirmed the cart while this one changed it
    if (isOrderNotEditable(err)) throw new ConflictError('ORDER_NOT_EDITABLE');

    throw new InternalError({ reason: 'ORDERS_CURRENT_UPDATE_ITEM_UNEXPECTED' }, err);
  }
}
