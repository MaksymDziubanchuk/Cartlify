import { prisma } from '@db/client.js';
import stripe from '@config/stripe.js';
import env from '@config/env.js';

import { setUserContext } from '@db/dbContext.service.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  isAppError,
} from '@utils/errors.js';

import type Stripe from 'stripe';
import type {
  CreateCheckoutSessionDto,
  CheckoutSessionResponseDto,
} from 'types/dto/payments.dto.js';

async function createCheckoutSession({
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

    // build success return url
    const successUrl = new URL('/checkout/success', env.WEB_ORIGIN);
    successUrl.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');

    // build cancel return url
    const cancelUrl = new URL('/checkout/cancel', env.WEB_ORIGIN);
    cancelUrl.searchParams.set('orderId', String(orderSnapshot.orderId));

    // build checkout session payload
    const checkoutSessionPayload: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      payment_method_types: ['card'],
      client_reference_id: String(orderSnapshot.orderId),
      metadata: {
        entityType: 'order',
        entityId: String(orderSnapshot.orderId),
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: Math.round(orderSnapshot.total * 100),
            product_data: {
              name: `Cartlify order #${orderSnapshot.orderId}`,
            },
          },
        },
      ],
      success_url: successUrl.toString(),
      cancel_url: cancelUrl.toString(),
    };

    // create checkout session in stripe
    const session = await stripe.checkout.sessions.create(checkoutSessionPayload);

    // require redirect url from stripe
    if (!session.url) {
      throw new InternalError({
        reason: 'PAYMENTS_CHECKOUT_SESSION_URL_MISSING',
        orderId: orderSnapshot.orderId,
        sessionId: session.id,
      });
    }

    // require session expiry from stripe
    if (!session.expires_at) {
      throw new InternalError({
        reason: 'PAYMENTS_CHECKOUT_SESSION_EXPIRES_AT_MISSING',
        orderId: orderSnapshot.orderId,
        sessionId: session.id,
      });
    }

    // guard expected payment mode
    if (session.mode !== 'payment') {
      throw new InternalError({
        reason: 'PAYMENTS_CHECKOUT_SESSION_MODE_INVALID',
        orderId: orderSnapshot.orderId,
        sessionId: session.id,
        mode: session.mode,
      });
    }

    // require non-null session status
    if (!session.status) {
      throw new InternalError({
        reason: 'PAYMENTS_CHECKOUT_SESSION_STATUS_MISSING',
        orderId: orderSnapshot.orderId,
        sessionId: session.id,
      });
    }

    // map stripe session into api dto
    return {
      checkoutSession: {
        sessionId: session.id,
        url: session.url,
        mode: session.mode,
        status: session.status,
        paymentStatus: session.payment_status,
        expiresAt: new Date(session.expires_at * 1000).toISOString(),
      },
    };
  } catch (err) {
    // preserve known app errors
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PAYMENTS_CREATE_CHECKOUT_SESSION_UNEXPECTED' }, err);
  }
}

export const paymentsServices = {
  createCheckoutSession,
};
