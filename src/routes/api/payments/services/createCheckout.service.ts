import { prisma } from '@db/client.js';
import env from '@config/env.js';
import { MIN_CHECKOUT_TOTAL } from '@config/limits.js';
import stripe from '@config/stripe.js';
import { assertRedisReady } from '@redis/client.js';
import { setOrderPaymentSessionLink } from '@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js';

import { setUserContext } from '@db/dbContext.service.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ServiceUnavailableError,
  isAppError,
} from '@utils/errors.js';

import {
  buildCheckoutIdempotencyKey,
  buildCheckoutSessionPayload,
  isStripeUnavailable,
  mapCreatedCheckoutSession,
} from './helpers/checkoutSession.helper.js';

import type Stripe from 'stripe';
import type { UnavailableOrderItem } from '@routes/api/orders/services/helpers/confirmOrder.helper.js';
import type {
  CreateCheckoutSessionDto,
  CheckoutSessionResponseDto,
} from 'types/dto/payments.dto.js';

export async function createCheckoutSession({
  actorId,
  actorRole,
  orderId,
}: CreateCheckoutSessionDto): Promise<CheckoutSessionResponseDto> {
  // enforce user-only checkout create
  if (actorRole !== 'USER') throw new ForbiddenError('FORBIDDEN_ROLE');

  // refuse early so no stripe session is created while redis is down
  assertRedisReady();

  try {
    const orderSnapshot = await prisma.$transaction(async (db) => {
      // set rls session context
      await setUserContext(db, { userId: actorId, role: actorRole });

      // load order snapshot for checkout create
      const order = await db.order.findUnique({
        where: { id: Number(orderId) },
        select: {
          id: true,
          userId: true,
          status: true,
          confirmed: true,
          reservationExpiresAt: true,
          total: true,
          items: {
            orderBy: { id: 'asc' },
            select: {
              id: true,
              productId: true,
              quantity: true,
              product: {
                select: {
                  deletedAt: true,
                },
              },
            },
          },
        },
      });

      if (!order) {
        throw new NotFoundError('ORDER_NOT_FOUND', { orderId: Number(orderId) });
      }

      // require confirmed order
      if (!order.confirmed) {
        throw new ConflictError('ORDER_NOT_CONFIRMED');
      }

      // block already paid order
      if (order.status === 'paid') {
        throw new ConflictError('ORDER_ALREADY_PAID');
      }

      // allow checkout only from waiting status
      if (order.status !== 'waiting') {
        throw new ConflictError('ORDER_STATUS_NOT_WAITING');
      }

      // require active reservation deadline
      if (!order.reservationExpiresAt) {
        throw new ConflictError('ORDER_RESERVATION_MISSING');
      }

      // block expired reservation
      if (order.reservationExpiresAt.getTime() <= Date.now()) {
        throw new ConflictError('ORDER_RESERVATION_EXPIRED');
      }

      // require at least one order item
      if (!Array.isArray(order.items) || order.items.length === 0) {
        throw new BadRequestError('ORDER_ITEMS_REQUIRED');
      }

      // an item removed from the catalog after the confirmation is named the way the confirmation
      // names it: the buyer cancels the payment, changes the order and confirms it again. Its own
      // reservation is in the stock numbers, so only a removed product is unavailable here
      const removed: UnavailableOrderItem[] = order.items
        .filter((item) => item.product.deletedAt)
        .map((item) => ({
          itemId: item.id,
          productId: item.productId,
          reason: 'deleted',
          available: 0,
          requested: item.quantity,
        }));

      if (removed.length > 0) {
        throw new ConflictError('ORDER_ITEMS_UNAVAILABLE', { items: removed });
      }

      // validate order total
      const totalRaw = Number(order.total);

      if (!Number.isFinite(totalRaw) || totalRaw <= 0) {
        throw new BadRequestError('ORDER_TOTAL_INVALID');
      }

      // stripe refuses a smaller payment, the page tells the buyer the smallest total
      if (totalRaw < MIN_CHECKOUT_TOTAL) {
        throw new BadRequestError('ORDER_TOTAL_BELOW_MINIMUM', {
          minimum: MIN_CHECKOUT_TOTAL,
          currency: env.STRIPE_CURRENCY,
        });
      }

      return {
        orderId: order.id,
        userId: order.userId,
        total: totalRaw,
        reservationExpiresAt: order.reservationExpiresAt,
      };
    });

    // build checkout payload for stripe
    const checkoutSessionPayload = buildCheckoutSessionPayload({
      orderId: orderSnapshot.orderId,
      userId: orderSnapshot.userId,
      total: orderSnapshot.total,
    });

    // create checkout session in stripe
    // repeated request for the same order and reservation gets the same session, not a second payment
    let session: Stripe.Checkout.Session;

    try {
      session = await stripe.checkout.sessions.create(checkoutSessionPayload, {
        idempotencyKey: buildCheckoutIdempotencyKey(
          orderSnapshot.orderId,
          orderSnapshot.reservationExpiresAt,
        ),
      });
    } catch (err) {
      // nothing is opened, the page asks the buyer to try again a bit later
      if (isStripeUnavailable(err)) {
        throw new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE', undefined, err);
      }

      throw err;
    }

    // set sessionId & orderId connection to Redis for expiration
    // session is not expired when this fails: the retry gets the same session back and links it
    await setOrderPaymentSessionLink(orderSnapshot.orderId, session.id);

    // map stripe session into api dto
    return mapCreatedCheckoutSession(
      session,
      orderSnapshot.orderId,
      orderSnapshot.reservationExpiresAt,
    );
  } catch (err) {
    // preserve known app errors
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PAYMENTS_CREATE_CHECKOUT_SESSION_UNEXPECTED' }, err);
  }
}
