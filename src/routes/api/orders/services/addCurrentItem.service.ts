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
} from './helpers/index.js';

import type { CurrentAddItemDto, OrderResponseDto } from 'types/dto/orders.dto.js';

// adds an item to the cart, or, with orderId, to an own order that lost its reservation
// (unconfirmed): its items can change before it is confirmed again
export async function addCurrentItem({
  actorId,
  actorRole,
  productId,
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

        // load product price and availability
        const product = await db.product.findFirst({
          where: { id: productId as any, deletedAt: null },
          select: { id: true, price: true, stock: true, reservedStock: true },
        });

        if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND', { productId });

        // check availability (real stock = stock - reservedStock)
        const available = product.stock - product.reservedStock;

        // upsert item in open order
        const existingItem = await db.orderItem.findFirst({
          where: { orderId, productId: productId as any },
          select: { id: true, quantity: true },
        });

        const nextQty = (existingItem?.quantity ?? 0) + quantity;
        if (nextQty > available) {
          throw new ConflictError('OUT_OF_STOCK', { productId, available, requested: nextQty });
        }

        // always store latest product price
        const unitPrice = product.price;

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
              productId: productId as any,
              quantity: nextQty,
              unitPrice: unitPrice as any,
              totalPrice: new Prisma.Decimal(0),
            },
            select: { id: true },
          });
        }

        // bring the other items to current product prices too, the order also loses the items of
        // products deleted from the catalog; confirm refuses an order with outdated prices, so the
        // order must show what will be confirmed
        await dropDeletedProductItems(db, Number(actorId), [orderId]);
        await db.$executeRaw`select cartlify.refresh_order_prices(${orderId}::int)`;

        // totals are maintained by db triggers; fetch current order
        const order = await db.order.findUnique({
          where: { id: orderId },
          select: orderResponseSelect,
        });

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_UPDATE' });

        return mapOrderRowToResponse(order);
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
      throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
    }

    // another request confirmed the cart while this one changed it
    if (isOrderNotEditable(err)) throw new ConflictError('ORDER_NOT_EDITABLE');

    throw new InternalError({ reason: 'ORDERS_CURRENT_ADD_ITEM_UNEXPECTED' }, err);
  }
}
