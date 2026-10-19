import { Prisma } from '@prisma/client';
import env from '@config/env.js';
import { MIN_CHECKOUT_TOTAL } from '@config/limits.js';
import { getPgMessage, tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertRedisReady } from '@redis/client.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
  isAppError,
} from '@utils/errors.js';
import {
  buildConfirmOrderData,
  findUnavailableItems,
  mapOrderRowToResponse,
  orderResponseSelect,
  scheduleOrderReservationExpiry,
} from './helpers/index.js';

import type { ConfirmCurrentOrderDto, OrderResponseDto } from 'types/dto/orders.dto.js';

const DEFAULT_RESERVE_FOR = '15 minutes';

export async function confirmOrder({
  actorId,
  actorRole,
  orderId,
  ...shipping
}: ConfirmCurrentOrderDto): Promise<OrderResponseDto> {
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  // check the shipping data before anything is written; a field that is not sent keeps
  // what the order already has
  const shippingData = buildConfirmOrderData(shipping);

  // refuse early so nothing is confirmed in db while redis is down
  assertRedisReady();

  try {
    const result = await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // store shipping data before confirm, db refuses to confirm an order without the address
        // and the recipient; rls lets the owner change only an own unconfirmed order, any other
        // case is reported by confirm_order
        if (Object.keys(shippingData).length) {
          await db.order.updateMany({
            where: { id: Number(orderId), confirmed: false },
            data: shippingData,
          });
        }

        // name every item the order cannot be confirmed with, a product deleted from the catalog or
        // not enough free stock: the page shows them, the owner changes the order and confirms
        // again. The database refuses such an order on its own, this only says which items.
        // A confirmed order is left to confirm_order, its own reservation is in the stock numbers
        const items = await db.orderItem.findMany({
          where: { orderId: Number(orderId), order: { userId: actorId as any, confirmed: false } },
          select: {
            id: true,
            productId: true,
            quantity: true,
            product: { select: { deletedAt: true, stock: true, reservedStock: true, price: true } },
          },
          orderBy: { id: 'asc' },
        });

        const unavailable = findUnavailableItems(items);
        if (unavailable.length) {
          throw new ConflictError('ORDER_ITEMS_UNAVAILABLE', { items: unavailable });
        }

        // stripe takes no smaller payment: refused before the stock is held, the page tells the
        // buyer the smallest total. The total at the prices of the catalog, the ones confirm_order
        // takes; an empty order is left to confirm_order (ORDER_ITEMS_REQUIRED)
        const totalCents = items.reduce(
          (sum, item) => sum + Math.round(Number(item.product.price) * 100) * item.quantity,
          0,
        );
        if (items.length > 0 && totalCents < Math.round(MIN_CHECKOUT_TOTAL * 100)) {
          throw new BadRequestError('ORDER_TOTAL_BELOW_MINIMUM', {
            minimum: MIN_CHECKOUT_TOTAL,
            currency: env.STRIPE_CURRENCY,
          });
        }

        // confirm in db
        await db.$executeRaw`select cartlify.confirm_order(
          ${Number(orderId)}::int,
          ${DEFAULT_RESERVE_FOR}::interval
        )`;

        const order = await db.order.findUnique({
          where: { id: orderId },
          select: orderResponseSelect,
        });

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_CONFIRM' });

        const response = mapOrderRowToResponse(order);

        // schedule expiry before commit so a redis failure rolls the confirmation back
        await scheduleOrderReservationExpiry(response.id, order.reservationExpiresAt);

        return response;
      },
      {
        // keep default isolation and retry only transient lock/conflict errors
        maxRetries: 3,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        maxWait: 1500,
        timeout: 10_000,
      },
    );

    return result;
  } catch (err) {
    if (isAppError(err)) throw err;

    if (isRetryableTxError(err)) {
      throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
    }

    // db function errors come as P2010
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
      const msg = String(getPgMessage(err) ?? err.message);

      if (msg.includes('ORDER_NOT_FOUND')) throw new NotFoundError('ORDER_NOT_FOUND');
      if (msg.includes('ORDER_CONFIRM_FORBIDDEN'))
        throw new ForbiddenError('ORDER_CONFIRM_FORBIDDEN');
      if (msg.includes('ORDER_ALREADY_CONFIRMED'))
        throw new ConflictError('ORDER_ALREADY_CONFIRMED');
      if (msg.includes('ORDER_STATUS_NOT_ALLOWED'))
        throw new ConflictError('ORDER_STATUS_NOT_ALLOWED');
      if (msg.includes('ORDER_ITEMS_REQUIRED')) throw new BadRequestError('ORDER_ITEMS_REQUIRED');

      // order has no shipping data and the request did not bring it
      if (msg.includes('ORDER_SHIPPING_ADDRESS_REQUIRED'))
        throw new BadRequestError('SHIPPING_ADDRESS_REQUIRED');
      if (msg.includes('ORDER_RECIPIENT_FIRST_NAME_REQUIRED'))
        throw new BadRequestError('RECIPIENT_FIRST_NAME_REQUIRED');
      if (msg.includes('ORDER_RECIPIENT_LAST_NAME_REQUIRED'))
        throw new BadRequestError('RECIPIENT_LAST_NAME_REQUIRED');
      if (msg.includes('ORDER_RECIPIENT_PHONE_REQUIRED'))
        throw new BadRequestError('RECIPIENT_PHONE_REQUIRED');

      // some item price differs from current product price
      // nothing is reserved; client reloads the order to get fresh prices and confirms again
      if (msg.includes('ORDER_PRICES_CHANGED')) throw new ConflictError('ORDER_PRICES_CHANGED');
      if (msg.includes('INSUFFICIENT_AVAILABLE_STOCK'))
        throw new ConflictError('INSUFFICIENT_AVAILABLE_STOCK');
      if (msg.includes('PRODUCT_NOT_FOUND')) throw new NotFoundError('PRODUCT_NOT_FOUND');
      if (msg.includes('ORDER_RESERVATION_DURATION_INVALID'))
        throw new BadRequestError('ORDER_RESERVATION_DURATION_INVALID');
    }

    throw new InternalError({ reason: 'ORDERS_CURRENT_CONFIRM_UNEXPECTED' }, err);
  }
}
