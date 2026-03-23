import env from '@config/env.js';
import { InternalError, isAppError } from '@utils/errors.js';
import stripe from '@config/stripe.js';

import type Stripe from 'stripe';
import type { CheckoutSessionResponseDto } from 'types/dto/payments.dto.js';

type BuildCheckoutSessionPayloadArgs = {
  orderId: number;
  total: number;
};

type ExpireCheckoutSessionArgs = {
  sessionId: string;
};

// build stripe checkout session payload
function buildCheckoutSessionPayload({
  orderId,
  total,
}: BuildCheckoutSessionPayloadArgs): Stripe.Checkout.SessionCreateParams {
  // build success return url
  const successUrl = new URL(env.STRIPE_SUCCESS_URL);
  successUrl.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');

  // build cancel return url
  const cancelUrl = new URL(env.STRIPE_CANCEL_URL);
  cancelUrl.searchParams.set('orderId', String(orderId));

  return {
    mode: 'payment',
    payment_method_types: ['card'],
    client_reference_id: String(orderId),
    metadata: {
      entityType: 'order',
      entityId: String(orderId),
    },
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: env.STRIPE_CURRENCY,
          unit_amount: Math.round(total * 100),
          product_data: {
            name: `Cartlify order #${orderId}`,
          },
        },
      },
    ],
    success_url: successUrl.toString(),
    cancel_url: cancelUrl.toString(),
  };
}

// get order id from stripe checkout session metadata
function getOrderIdFromCheckoutSession(session: Stripe.Checkout.Session): number {
  const entityType = session.metadata?.entityType;
  const entityIdRaw = session.metadata?.entityId;

  // require order entity type
  if (entityType !== 'order') {
    throw new InternalError({
      reason: 'STRIPE_CHECKOUT_SESSION_ENTITY_TYPE_INVALID',
      entityType,
    });
  }

  // require entity id in metadata
  if (!entityIdRaw) {
    throw new InternalError({
      reason: 'STRIPE_CHECKOUT_SESSION_ENTITY_ID_MISSING',
    });
  }

  const orderId = Number(entityIdRaw);

  // require valid numeric order id
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new InternalError({
      reason: 'STRIPE_CHECKOUT_SESSION_ENTITY_ID_INVALID',
      entityId: entityIdRaw,
    });
  }

  return orderId;
}

// map created stripe checkout session into api dto
function mapCreatedCheckoutSession(
  session: Stripe.Checkout.Session,
  orderId: number,
): CheckoutSessionResponseDto {
  // require session expiry from stripe
  if (!session.expires_at) {
    throw new InternalError({
      reason: 'PAYMENTS_CHECKOUT_SESSION_EXPIRES_AT_MISSING',
      orderId,
      sessionId: session.id,
    });
  }

  // guard expected payment mode
  if (session.mode !== 'payment') {
    throw new InternalError({
      reason: 'PAYMENTS_CHECKOUT_SESSION_MODE_INVALID',
      orderId,
      sessionId: session.id,
      mode: session.mode,
    });
  }

  // require non-null session status
  if (!session.status) {
    throw new InternalError({
      reason: 'PAYMENTS_CHECKOUT_SESSION_STATUS_MISSING',
      orderId,
      sessionId: session.id,
    });
  }

  return {
    checkoutSession: {
      sessionId: session.id,
      url: session.url ?? null,
      mode: session.mode,
      status: session.status,
      paymentStatus: session.payment_status,
      expiresAt: new Date(session.expires_at * 1000).toISOString(),
    },
  };
}

async function expireCheckoutSession({ sessionId }: ExpireCheckoutSessionArgs): Promise<void> {
  // require non-empty stripe checkout session id
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new InternalError({
      reason: 'STRIPE_CHECKOUT_SESSION_ID_INVALID',
    });
  }

  try {
    // expire open checkout session in stripe
    const session = await stripe.checkout.sessions.expire(sessionId);

    // require expired status after expire call
    if (session.status !== 'expired') {
      throw new InternalError({
        reason: 'STRIPE_CHECKOUT_SESSION_EXPIRE_FAILED',
        sessionId,
        status: session.status,
      });
    }
  } catch (err) {
    // preserve known app errors
    if (isAppError(err)) throw err;

    throw new InternalError(
      {
        reason: 'STRIPE_CHECKOUT_SESSION_EXPIRE_UNEXPECTED',
        sessionId,
      },
      err,
    );
  }
}

export {
  buildCheckoutSessionPayload,
  getOrderIdFromCheckoutSession,
  mapCreatedCheckoutSession,
  expireCheckoutSession,
};
