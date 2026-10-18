import env from '@config/env.js';
import { InternalError, isAppError } from '@utils/errors.js';
import stripe from '@config/stripe.js';

import type Stripe from 'stripe';
import type {
  CheckoutSessionResponseDto,
  StripeCheckoutPaymentStatus,
  StripeCheckoutSessionStatus,
} from 'types/dto/payments.dto.js';

// the values the response schema allows
const SESSION_STATUSES: readonly StripeCheckoutSessionStatus[] = ['open', 'complete', 'expired'];
const PAYMENT_STATUSES: readonly StripeCheckoutPaymentStatus[] = [
  'paid',
  'unpaid',
  'no_payment_required',
];

type BuildCheckoutSessionPayloadArgs = {
  orderId: number;
  userId: number;
  total: number;
};

type ExpireCheckoutSessionArgs = {
  sessionId: string;
};

// build stripe idempotency key for checkout session create
// same order with the same reservation gets the same session back, so a double click does not open a second payment
// a new confirmation has a new reservation time, so it gets a new session
function buildCheckoutIdempotencyKey(orderId: number, reservationExpiresAt: Date): string {
  return `checkout:order:${orderId}:${reservationExpiresAt.getTime()}`;
}

// build stripe checkout session payload
function buildCheckoutSessionPayload({
  orderId,
  userId,
  total,
}: BuildCheckoutSessionPayloadArgs): Stripe.Checkout.SessionCreateParams {
  // build success return url; stripe replaces only the literal {CHECKOUT_SESSION_ID} with the
  // session id, while URLSearchParams encodes the braces, so they are put back after encoding
  const successUrl = new URL(env.STRIPE_SUCCESS_URL);
  successUrl.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  const successUrlText = successUrl
    .toString()
    .replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}');

  // build cancel return url
  const cancelUrl = new URL(env.STRIPE_CANCEL_URL);
  cancelUrl.searchParams.set('orderId', String(orderId));

  return {
    mode: 'payment',
    // stripe 23 renamed payment_method_types to allowed_payment_method_types
    allowed_payment_method_types: ['card'],
    client_reference_id: String(orderId),
    // keep order owner in metadata: webhook needs it when the order row is already deleted
    metadata: {
      entityType: 'order',
      entityId: String(orderId),
      userId: String(userId),
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
    success_url: successUrlText,
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

// get order owner id from stripe checkout session metadata
function getUserIdFromCheckoutSession(session: Stripe.Checkout.Session): number | null {
  const userId = Number(session.metadata?.userId);

  // sessions created before owner id was added to metadata do not have it
  return Number.isInteger(userId) && userId > 0 ? userId : null;
}

// get payment intent id from paid stripe checkout session
function getPaymentIntentIdFromCheckoutSession(session: Stripe.Checkout.Session): string {
  const paymentIntent = session.payment_intent;
  const paymentIntentId = typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id;

  // require payment intent for paid checkout
  if (!paymentIntentId) {
    throw new InternalError({
      reason: 'STRIPE_CHECKOUT_SESSION_PAYMENT_INTENT_MISSING',
      sessionId: session.id,
    });
  }

  return paymentIntentId;
}

// get paid amount from stripe checkout session in the same units as order total
function getPaidAmountFromCheckoutSession(session: Stripe.Checkout.Session): string {
  const amountTotal = session.amount_total;

  // require non-negative integer amount in minor units
  if (typeof amountTotal !== 'number' || !Number.isInteger(amountTotal) || amountTotal < 0) {
    throw new InternalError({
      reason: 'STRIPE_CHECKOUT_SESSION_AMOUNT_INVALID',
      sessionId: session.id,
    });
  }

  // build decimal string without float math, mirrors unit_amount in checkout payload
  return `${Math.trunc(amountTotal / 100)}.${String(amountTotal % 100).padStart(2, '0')}`;
}

// map created stripe checkout session into api dto
function mapCreatedCheckoutSession(
  session: Stripe.Checkout.Session,
  orderId: number,
  reservationExpiresAt: Date | null,
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

  // stripe types leave room for values stripe adds later, our api promises only the known ones
  const status = session.status;
  if (!SESSION_STATUSES.includes(status as StripeCheckoutSessionStatus)) {
    throw new InternalError({
      reason: 'PAYMENTS_CHECKOUT_SESSION_STATUS_UNKNOWN',
      orderId,
      sessionId: session.id,
      status,
    });
  }

  const paymentStatus = session.payment_status;
  if (!PAYMENT_STATUSES.includes(paymentStatus as StripeCheckoutPaymentStatus)) {
    throw new InternalError({
      reason: 'PAYMENTS_CHECKOUT_SESSION_PAYMENT_STATUS_UNKNOWN',
      orderId,
      sessionId: session.id,
      paymentStatus,
    });
  }

  // payment is possible until our reservation ends or stripe closes the session, whichever comes first
  // worker expires the stripe session at reservation end, so stripe own expiry alone would show a later time
  const stripeExpiresAtMs = session.expires_at * 1000;
  const expiresAtMs = reservationExpiresAt
    ? Math.min(reservationExpiresAt.getTime(), stripeExpiresAtMs)
    : stripeExpiresAtMs;

  return {
    checkoutSession: {
      sessionId: session.id,
      url: session.url ?? null,
      // the mode is checked above
      mode: 'payment',
      status: status as StripeCheckoutSessionStatus,
      paymentStatus: paymentStatus as StripeCheckoutPaymentStatus,
      expiresAt: new Date(expiresAtMs).toISOString(),
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

// the state of a checkout session at stripe: open (can still be paid), complete or expired, and
// whether the money is taken; a session that could not be expired tells this way what happened.
// A complete session of a delayed payment method is not paid yet, the bank may still refuse it
async function readCheckoutSessionStatus(
  sessionId: string,
): Promise<{ status: 'open' | 'complete' | 'expired'; paid: boolean }> {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    // stripe types leave room for values stripe adds later, only the known ones are answered
    const status = (['open', 'complete', 'expired'] as const).find(
      (known) => known === session.status,
    );

    if (status) return { status, paid: session.payment_status === 'paid' };

    throw new InternalError({ reason: 'STRIPE_CHECKOUT_SESSION_STATUS_UNKNOWN', sessionId });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'STRIPE_CHECKOUT_SESSION_READ_UNEXPECTED', sessionId }, err);
  }
}

export {
  readCheckoutSessionStatus,
  buildCheckoutIdempotencyKey,
  buildCheckoutSessionPayload,
  getOrderIdFromCheckoutSession,
  getUserIdFromCheckoutSession,
  getPaymentIntentIdFromCheckoutSession,
  getPaidAmountFromCheckoutSession,
  mapCreatedCheckoutSession,
  expireCheckoutSession,
};
