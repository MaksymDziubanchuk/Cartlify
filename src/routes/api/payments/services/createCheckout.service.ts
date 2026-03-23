import { prisma } from '@db/client.js';
import stripe from '@config/stripe.js';
import { setOrderPaymentSessionLink } from '@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js';

import { setUserContext } from '@db/dbContext.service.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  isAppError,
} from '@utils/errors.js';

import {
  buildCheckoutSessionPayload,
  mapCreatedCheckoutSession,
} from './helpers/checkoutSession.helper.js';

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

  try {
    const orderSnapshot = await prisma.$transaction(async (db) => {
      // set rls session context
      await setUserContext(db, { userId: actorId, role: actorRole });

      // load order snapshot for checkout create
      const order = await db.order.findUnique({
        where: { id: Number(orderId) },
        select: {
          id: true,
          status: true,
          confirmed: true,
          reservationExpiresAt: true,
          total: true,
          items: {
            select: {
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

      // ensure all item products still exist
      const hasInvalidProduct = order.items.some((item) => !item.product || item.product.deletedAt);

      if (hasInvalidProduct) {
        throw new NotFoundError('PRODUCT_NOT_FOUND');
      }

      // validate order total
      const totalRaw = Number(order.total);

      if (!Number.isFinite(totalRaw) || totalRaw <= 0) {
        throw new BadRequestError('ORDER_TOTAL_INVALID');
      }

      return {
        orderId: order.id,
        total: totalRaw,
      };
    });

    // build checkout payload for stripe
    const checkoutSessionPayload = buildCheckoutSessionPayload({
      orderId: orderSnapshot.orderId,
      total: orderSnapshot.total,
    });

    // create checkout session in stripe
    const session = await stripe.checkout.sessions.create(checkoutSessionPayload);

    // set sessionId & orderId connection to Redis for expiration
    await setOrderPaymentSessionLink(orderSnapshot.orderId, session.id);

    // map stripe session into api dto
    return mapCreatedCheckoutSession(session, orderSnapshot.orderId);
  } catch (err) {
    // preserve known app errors
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PAYMENTS_CREATE_CHECKOUT_SESSION_UNEXPECTED' }, err);
  }
}
