import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { InternalError, isAppError, ServiceUnavailableError } from '@utils/errors.js';
import stripe from '@config/stripe.js';
import { webPageUrl } from '@helpers/webOrigin.js';
import { MAX_ID } from '@schemas/idPathParam.js';

import type Stripe from 'stripe';
import type { PaymentPageReading, PaymentPageShipping } from '../types.js';
import type {
  CheckoutPaymentStatus,
  CheckoutSessionResponseDto,
  CheckoutSessionStatus,
} from 'types/dto/payments.dto.js';

// the values the response schema allows
const SESSION_STATUSES: readonly CheckoutSessionStatus[] = ['open', 'complete', 'expired'];
const PAYMENT_STATUSES: readonly CheckoutPaymentStatus[] = [
  'paid',
  'unpaid',
  'no_payment_required',
];

type BuildCheckoutSessionPayloadArgs = {
  orderId: number;
  userId: number;
  total: number;
  reservationExpiresAt: Date;
  items: { name: string; unitPrice: number; quantity: number }[];
  // what the buyer pays for the delivery, a line of its own when it is above 0
  deliveryPrice?: number;
  // where and to whom the order goes: the payment carries it, it helps Stripe tell a fraud
  shipping?: PaymentPageShipping | null;
  customerEmail: string | null;
  // the language of the buyer (mailLocaleOf); the page opens in it when Stripe has it
  locale: string;
};

// the languages Checkout itself can open in (Stripe.Checkout.SessionCreateParams.Locale, minus
// "auto" and the open-ended OtherString Stripe leaves room for its own future additions); not
// every language the shop answers in is one of these (Ukrainian is not, at the time of writing)
const STRIPE_CHECKOUT_LOCALES: readonly Stripe.Checkout.SessionCreateParams.Locale[] = [
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'en',
  'en-GB',
  'es',
  'es-419',
  'et',
  'fi',
  'fil',
  'fr',
  'fr-CA',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'lt',
  'lv',
  'ms',
  'mt',
  'nb',
  'nl',
  'pl',
  'pt',
  'pt-BR',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'th',
  'tr',
  'vi',
  'zh',
  'zh-HK',
  'zh-TW',
];

// Checkout's own locale, when it has the buyer's; "auto" (the browser's own) otherwise, the same
// as leaving it unset
const stripeLocaleOf = (locale: string): Stripe.Checkout.SessionCreateParams.Locale =>
  (STRIPE_CHECKOUT_LOCALES as readonly string[]).includes(locale)
    ? (locale as Stripe.Checkout.SessionCreateParams.Locale)
    : 'auto';

// money in cents without float math: 10.15 * 100 is 1014.9999999999999
const centsOf = (value: number) => Math.round(Math.round(value * 1000) / 10);

// a sum of stripe in cents as the app writes money, digits with two decimals, signed below 0
// ("-10.00" for what a dispute takes), without float math
function amountOfCents(cents: number): string {
  if (!Number.isSafeInteger(cents)) {
    throw new InternalError({ reason: 'STRIPE_AMOUNT_INVALID', cents });
  }

  const whole = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}${Math.trunc(whole / 100)}.${String(whole % 100).padStart(2, '0')}`;
}

// the ways to pay the page offers; the buyer picks one on the page of stripe, which shows each
// only where it can take the payment: a card, with Google Pay and Apple Pay as wallets of it (they
// need no type of their own), PayPal (its money is settled on the balance of stripe) and Bizum
// (buyers in Spain, EUR, 0.50 to 5000)
const PAYMENT_METHOD_TYPES: Stripe.Checkout.SessionCreateParams.AllowedPaymentMethodType[] = [
  'card',
  'paypal',
  'bizum',
];

// how long after the reservation stripe closes the page itself (stripePageMinutes, 30 unless
// root set one, the least stripe takes). The timer closes it at the end of the reservation; when
// it cannot (stripe out of reach), this keeps a late payment within these minutes instead of a day
const pageExpiresAfterReservationMs = () => shopSettings().stripePageMinutes * 60_000;

type ExpireCheckoutSessionArgs = {
  sessionId: string;
};

// build stripe idempotency key for checkout session create
// same order with the same reservation gets the same session back, so a double click does not open a second payment
// a new confirmation has a new reservation time, so it gets a new session; so does a page opened
// after the app closed one of the order for another provider, stripe would give the closed one back
function buildCheckoutIdempotencyKey(
  orderId: number,
  reservationExpiresAt: Date,
  pageClosedAt: Date | null = null,
): string {
  const key = `checkout:order:${orderId}:${reservationExpiresAt.getTime()}`;
  return pageClosedAt ? `${key}:closed:${pageClosedAt.getTime()}` : key;
}

// build stripe checkout session payload
function buildCheckoutSessionPayload({
  orderId,
  userId,
  total,
  reservationExpiresAt,
  items,
  deliveryPrice = 0,
  shipping = null,
  customerEmail,
  locale,
}: BuildCheckoutSessionPayloadArgs): Stripe.Checkout.SessionCreateParams {
  // a line for each item and one for the delivery when it costs something; the webhook takes the
  // paid amount for the total of the order, so the lines add up to it to the cent, or the page is
  // not opened
  const lines = [
    ...items.map((item) => ({
      quantity: item.quantity,
      price_data: {
        currency: env.STRIPE_CURRENCY,
        unit_amount: centsOf(item.unitPrice),
        product_data: { name: item.name },
      },
    })),
    ...(deliveryPrice > 0
      ? [
          {
            quantity: 1,
            price_data: {
              currency: env.STRIPE_CURRENCY,
              unit_amount: centsOf(deliveryPrice),
              product_data: { name: 'Delivery' },
            },
          },
        ]
      : []),
  ];
  const linesTotal = lines.reduce(
    (sum, line) => sum + line.price_data.unit_amount * line.quantity,
    0,
  );
  if (linesTotal !== centsOf(total)) {
    throw new InternalError({ reason: 'STRIPE_LINES_TOTAL_MISMATCH', orderId });
  }

  // build success return url; stripe replaces only the literal {CHECKOUT_SESSION_ID} with the
  // session id, while URLSearchParams encodes the braces, so they are put back after encoding
  // the frontend pages the payment page returns the buyer to (WEB_PAGE_CHECKOUT_SUCCESS,
  // WEB_PAGE_CHECKOUT_CANCEL) on WEB_ORIGIN
  const successUrlText = webPageUrl(env.WEB_PAGE_CHECKOUT_SUCCESS, {
    query: { session_id: '{CHECKOUT_SESSION_ID}' },
  }).replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}');

  // build cancel return url
  const cancelUrlText = webPageUrl(env.WEB_PAGE_CHECKOUT_CANCEL, {
    query: { orderId: String(orderId) },
  });

  return {
    mode: 'payment',
    // stripe 23 renamed payment_method_types to allowed_payment_method_types
    allowed_payment_method_types: [...PAYMENT_METHOD_TYPES],
    client_reference_id: String(orderId),
    // keep order owner in metadata: webhook needs it when the order row is already deleted
    metadata: {
      entityType: 'order',
      entityId: String(orderId),
      userId: String(userId),
    },
    line_items: lines,
    // the payment names the shop and the order, the bank statement and the dashboard show it
    payment_intent_data: {
      description: `${shopSettings().shopName} order #${orderId}`,
      ...(shipping
        ? {
            shipping: {
              name: shipping.name,
              phone: shipping.phone,
              address: {
                line1: shipping.address.line1,
                ...(shipping.address.line2 ? { line2: shipping.address.line2 } : {}),
                city: shipping.address.city,
                ...(shipping.address.postalCode
                  ? { postal_code: shipping.address.postalCode }
                  : {}),
                country: shipping.address.country,
              },
            },
          }
        : {}),
    },
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    locale: stripeLocaleOf(locale),
    success_url: successUrlText,
    cancel_url: cancelUrlText,
    // from the reservation, not the clock: a repeated request with the same key sends the same values
    expires_at: Math.floor(
      (reservationExpiresAt.getTime() + pageExpiresAfterReservationMs()) / 1000,
    ),
  };
}

// stripe could not be reached or could not answer now (its own failure, too many requests): the
// request may work later, unlike a refusal of what was asked
const STRIPE_UNAVAILABLE_TYPES = new Set([
  'StripeConnectionError',
  'StripeAPIError',
  'StripeRateLimitError',
]);

function isStripeUnavailable(err: unknown): boolean {
  const type = (err as { type?: unknown } | null)?.type;
  return typeof type === 'string' && STRIPE_UNAVAILABLE_TYPES.has(type);
}

// stripe refused a key it already used with other values: the session of the key exists, made
// from what the request carried the first time
function isStripeIdempotencyConflict(err: unknown): boolean {
  return (err as { type?: unknown } | null)?.type === 'StripeIdempotencyError';
}

// stripe has no such object: an id it never made, or one of another account or mode. For a
// checkout session stripe answers 404 without a code, other objects come with resource_missing
function isStripeResourceMissing(err: unknown): boolean {
  const e = err as { type?: unknown; code?: unknown; statusCode?: unknown } | null;
  return (
    e?.type === 'StripeInvalidRequestError' &&
    (e.statusCode === 404 || e.code === 'resource_missing')
  );
}

// whether the page is one the app opened for an order: the same stripe account may hold pages of
// other tools (a dev server, the stripe cli), the app leaves those and their money alone
function isOrderCheckoutSession(session: Stripe.Checkout.Session): boolean {
  const entityId = session.metadata?.entityId;

  return (
    session.metadata?.entityType === 'order' &&
    typeof entityId === 'string' &&
    /^[1-9][0-9]*$/.test(entityId) &&
    Number(entityId) <= MAX_ID
  );
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
  return amountOfCents(amountTotal);
}

// what a page is, read the way the webhook reads its payment event: a page of another tool first,
// then whether the money is taken, then the order, its owner and the payment. The same for the
// event and for a page the reservation timer found paid at stripe
function paymentPageReadingOf(session: Stripe.Checkout.Session): PaymentPageReading {
  if (!isOrderCheckoutSession(session)) return { state: 'foreign', pageId: session.id };

  const orderId = getOrderIdFromCheckoutSession(session);

  if (session.payment_status !== 'paid') return { state: 'unpaid', pageId: session.id, orderId };

  const paymentId = getPaymentIntentIdFromCheckoutSession(session);
  const amount = getPaidAmountFromCheckoutSession(session);

  // a page that takes a payment always names its currency
  if (!session.currency) {
    throw new InternalError({
      reason: 'STRIPE_CHECKOUT_SESSION_CURRENCY_MISSING',
      sessionId: session.id,
    });
  }

  return {
    state: 'paid',
    pageId: session.id,
    orderId,
    userId: getUserIdFromCheckoutSession(session),
    paymentId,
    amount,
    currency: session.currency,
  };
}

// a page as it is at stripe now, read as its payment event is: for a page the timer found paid
// whose event did not come. Stripe out of reach is PAYMENT_PROVIDER_UNAVAILABLE (ask again
// later); a page it has no record of is a server error
async function readStripePaidPage(sessionId: string): Promise<PaymentPageReading> {
  let session: Stripe.Checkout.Session;

  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch (err) {
    if (isStripeUnavailable(err)) {
      throw new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE', undefined, err);
    }

    if (isStripeResourceMissing(err)) {
      throw new InternalError({ reason: 'STRIPE_CHECKOUT_SESSION_NOT_FOUND', sessionId }, err);
    }

    throw err;
  }

  return paymentPageReadingOf(session);
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
  if (!SESSION_STATUSES.includes(status as CheckoutSessionStatus)) {
    throw new InternalError({
      reason: 'PAYMENTS_CHECKOUT_SESSION_STATUS_UNKNOWN',
      orderId,
      sessionId: session.id,
      status,
    });
  }

  const paymentStatus = session.payment_status;
  if (!PAYMENT_STATUSES.includes(paymentStatus as CheckoutPaymentStatus)) {
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
      provider: 'stripe',
      sessionId: session.id,
      url: session.url ?? null,
      // the mode is checked above
      mode: 'payment',
      status: status as CheckoutSessionStatus,
      paymentStatus: paymentStatus as CheckoutPaymentStatus,
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
  amountOfCents,
  isOrderCheckoutSession,
  isStripeIdempotencyConflict,
  isStripeResourceMissing,
  isStripeUnavailable,
  paymentPageReadingOf,
  readCheckoutSessionStatus,
  readStripePaidPage,
  buildCheckoutIdempotencyKey,
  buildCheckoutSessionPayload,
  getOrderIdFromCheckoutSession,
  getUserIdFromCheckoutSession,
  getPaymentIntentIdFromCheckoutSession,
  getPaidAmountFromCheckoutSession,
  mapCreatedCheckoutSession,
  expireCheckoutSession,
};
