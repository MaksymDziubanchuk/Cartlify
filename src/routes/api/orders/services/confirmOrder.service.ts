import env from '@config/env.js';
import type { DeliveryMethodName } from '@config/deliveryMethods.js';
import { expiredUnitsOf } from '@db/expiredStock.helper.js';
import { Prisma } from '@prisma/client';
import { getPgMessage, prisma, tx, isRetryableTxError } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import {
  assertAcceptedForOrder,
  recordConsents,
} from '@routes/api/legal/services/helpers/legalDocuments.helper.js';
import { deliveryPriceOf } from '@helpers/deliveryPrice.js';
import { currentPrice } from '@helpers/productSale.js';
import { assertRedisReady } from '@redis/client.js';
import { lowestMinimumTotal, shopCurrency } from '@routes/api/payments/providers/index.js';
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
  buildDeliveryData,
  assertDeliveryOfShop,
  findUnavailableItems,
  mapOrderRowToResponse,
  expiredOfOrders,
  readOrderResponse,
  scheduleOrderReservationExpiry,
} from './helpers/index.js';

import type { ConfirmCurrentOrderDto, OrderResponseDto } from 'types/dto/orders.dto.js';
import type { UserId } from 'types/ids.js';

// the items of an unconfirmed order of the user the order cannot be confirmed with now
async function unavailableItemsOf(actorId: UserId, orderId: number) {
  return prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: actorId, role: 'USER' });
    const items = await db.orderItem.findMany({
      where: { orderId, order: { userId: actorId as any, confirmed: false } },
      select: {
        id: true,
        productId: true,
        quantity: true,
        product: { select: { deletedAt: true, stock: true, reservedStock: true } },
      },
      orderBy: { id: 'asc' },
    });
    return findUnavailableItems(
      items,
      await expiredUnitsOf(
        db,
        items.map((item) => item.productId),
      ),
    );
  });
}

// what the delivery of an unconfirmed order of the user costs now, by the items it has: the price
// a confirmation that the buyer saw another price for names. The method is the one sent with the
// confirmation, else the one the order has
async function deliveryPriceNowOf(
  actorId: UserId,
  orderId: number,
  method: DeliveryMethodName | undefined,
): Promise<number> {
  return prisma.$transaction(async (db) => {
    await setUserContext(db, { userId: actorId, role: 'USER' });
    const order = await db.order.findFirst({
      where: { id: orderId, userId: actorId as any, confirmed: false },
      select: {
        delivery: { select: { method: true } },
        items: { select: { totalPrice: true } },
      },
    });

    const chosen = method ?? order?.delivery?.method;
    if (!order || !chosen) return 0;

    const itemsCents = order.items.reduce(
      (sum, item) => sum + Math.round(Number(item.totalPrice) * 100),
      0,
    );
    return deliveryPriceOf(chosen, itemsCents / 100);
  });
}

export async function confirmOrder({
  actorId,
  actorRole,
  orderId,
  delivery,
  expectedDeliveryPrice,
}: ConfirmCurrentOrderDto): Promise<OrderResponseDto> {
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  // check the delivery before anything is written; a delivery that is not sent leaves the one the
  // order already has
  const deliveryData = delivery ? buildDeliveryData(delivery) : null;

  // refuse early so nothing is confirmed in db while redis is down
  assertRedisReady();

  try {
    const result = await tx(
      async (db) => {
        await setUserContext(db, { userId: actorId, role: actorRole });
        await db.$executeRawUnsafe(`SET LOCAL lock_timeout = '1500ms'`);

        // only a customer who accepted the versions of the terms and of the contract in force
        // confirms an order; the order keeps them for the mail after the payment
        const legalVersions = await assertAcceptedForOrder(db, Number(actorId));

        // write where the order goes before the confirmation, the database refuses to confirm an
        // order without it; rls lets the owner write it only for an own unconfirmed order, any
        // other case is reported by confirm_order
        if (deliveryData) {
          const cart = await db.order.findFirst({
            where: { id: Number(orderId), userId: actorId as any, confirmed: false },
            select: { id: true },
          });
          if (cart) {
            await db.orderDelivery.upsert({
              where: { orderId: cart.id },
              create: { orderId: cart.id, ...deliveryData },
              update: deliveryData,
            });
          }
        } else {
          // no delivery sent: the one the order has, written before, goes on if the shop still
          // offers it
          const written = await db.orderDelivery.findFirst({
            where: {
              orderId: Number(orderId),
              order: { userId: actorId as any, confirmed: false },
            },
            select: { method: true, country: true },
          });
          if (written) assertDeliveryOfShop(written.method, written.country);
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
            product: {
              select: {
                deletedAt: true,
                stock: true,
                reservedStock: true,
                price: true,
                salePrice: true,
                saleEndsAt: true,
              },
            },
          },
          orderBy: { id: 'asc' },
        });

        const unavailable = findUnavailableItems(
          items,
          await expiredUnitsOf(
            db,
            items.map((item) => item.productId),
          ),
        );
        if (unavailable.length) {
          throw new ConflictError('ORDER_ITEMS_UNAVAILABLE', { items: unavailable });
        }

        // no payment provider takes a smaller payment: refused before the stock is held, the page
        // tells the buyer the smallest total. The buyer picks the provider after this, so only a
        // total below the minimum of every one of them is refused here; the payment page checks the
        // one picked. The total is what the buyer pays: the items at the prices the products sell
        // at now (the sale price while a sale lasts), the ones confirm_order takes, and the
        // delivery by the settings of the shop. An empty order is left to confirm_order
        // (ORDER_ITEMS_REQUIRED), an order without a delivery too (ORDER_DELIVERY_REQUIRED)
        const minimum = lowestMinimumTotal();
        const itemsCents = items.reduce(
          (sum, item) => sum + Math.round(currentPrice(item.product) * 100) * item.quantity,
          0,
        );
        const method =
          deliveryData?.method ??
          (
            await db.orderDelivery.findUnique({
              where: { orderId: Number(orderId) },
              select: { method: true },
            })
          )?.method;
        const deliveryCents = method
          ? Math.round(deliveryPriceOf(method, itemsCents / 100) * 100)
          : 0;
        if (items.length > 0 && itemsCents + deliveryCents < Math.round(minimum * 100)) {
          throw new BadRequestError('ORDER_TOTAL_BELOW_MINIMUM', {
            minimum,
            currency: shopCurrency(),
          });
        }

        // confirm in db; the order holds its units ORDER_RESERVATION_MINUTES (15 unless set) and
        // its delivery is priced by the rule of the shop
        await db.$executeRaw`select cartlify.confirm_order(
          ${Number(orderId)}::int,
          ${`${env.ORDER_RESERVATION_MINUTES} minutes`}::interval,
          ${env.DELIVERY_FLAT_PRICE}::numeric,
          ${env.DELIVERY_FREE_FROM}::numeric,
          ${expectedDeliveryPrice}::numeric
        )`;

        const order = await readOrderResponse(db, orderId);

        if (!order) throw new InternalError({ reason: 'ORDER_NOT_FOUND_AFTER_CONFIRM' });

        await recordConsents(db, Number(actorId), legalVersions, 'consent.order', order.id);

        const response = mapOrderRowToResponse(order, await expiredOfOrders(db, [order]));

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
      throw new ResourceBusyError();
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

      // the order has no delivery and the request did not bring one
      if (msg.includes('ORDER_DELIVERY_REQUIRED')) throw new BadRequestError('DELIVERY_REQUIRED');

      // the price of the delivery the buyer saw is not the one the shop asks now: the buyer sees
      // the new one and confirms again
      if (msg.includes('ORDER_DELIVERY_PRICE_CHANGED')) {
        throw new ConflictError('DELIVERY_PRICE_CHANGED', {
          price: await deliveryPriceNowOf(actorId, Number(orderId), delivery?.method),
        });
      }

      // some item price differs from current product price
      // nothing is reserved; client reloads the order to get fresh prices and confirms again
      if (msg.includes('ORDER_PRICES_CHANGED')) throw new ConflictError('ORDER_PRICES_CHANGED');
      // another buyer took the last free units between the check and the reserve: the items are
      // named the way the check names them, from a fresh read
      if (msg.includes('INSUFFICIENT_AVAILABLE_STOCK')) {
        throw new ConflictError('ORDER_ITEMS_UNAVAILABLE', {
          items: await unavailableItemsOf(actorId, Number(orderId)),
        });
      }
      if (msg.includes('PRODUCT_NOT_FOUND')) throw new NotFoundError('PRODUCT_NOT_FOUND');
      if (msg.includes('ORDER_RESERVATION_DURATION_INVALID'))
        throw new BadRequestError('ORDER_RESERVATION_DURATION_INVALID');
    }

    throw new InternalError({ reason: 'ORDERS_CURRENT_CONFIRM_UNEXPECTED' }, err);
  }
}
