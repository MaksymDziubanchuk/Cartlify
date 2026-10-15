import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import type Stripe from 'stripe';

import { rejectedBy, thrownBy } from '../../../../../../helpers/errors.js';
import { importWithEnv } from '../../../../../../helpers/freshImport.js';

type Helper = typeof import('@routes/api/payments/services/helpers/checkoutSession.helper.js');
type StripeClient = (typeof import('@config/stripe.js'))['default'];

// synthetic return pages, the module reads them at import
const CONFIG = {
  STRIPE_SUCCESS_URL: 'https://shop.cartlify.test/checkout/success?from=stripe',
  STRIPE_CANCEL_URL: 'https://shop.cartlify.test/checkout/cancel',
  STRIPE_CURRENCY: 'eur',
};

let helper: Helper;
let stripe: StripeClient;

beforeAll(async () => {
  helper = await importWithEnv<Helper>(
    '@routes/api/payments/services/helpers/checkoutSession.helper.js',
    CONFIG,
  );
  // the same module registry, so this is the client the helper uses
  stripe = (await import('@config/stripe.js')).default;
});

afterEach(() => {
  jest.restoreAllMocks();
});

const session = (patch: Partial<Stripe.Checkout.Session> = {}) =>
  ({
    id: 'cs_test_1',
    mode: 'payment',
    status: 'open',
    payment_status: 'unpaid',
    url: 'https://checkout.stripe.test/c/pay/cs_test_1',
    expires_at: 1_780_000_000,
    metadata: { entityType: 'order', entityId: '12', userId: '3' },
    payment_intent: 'pi_test_1',
    amount_total: 1999,
    ...patch,
  }) as Stripe.Checkout.Session;

describe('buildCheckoutIdempotencyKey', () => {
  const reservation = new Date('2026-06-01T10:15:00.000Z');

  it('gives the same key to a repeated click on the same confirmed order', () => {
    expect(helper.buildCheckoutIdempotencyKey(12, reservation)).toBe(
      helper.buildCheckoutIdempotencyKey(12, new Date(reservation)),
    );
  });

  it('gives a new key after a new confirmation, which has a new reservation time', () => {
    expect(helper.buildCheckoutIdempotencyKey(12, reservation)).not.toBe(
      helper.buildCheckoutIdempotencyKey(12, new Date(reservation.getTime() + 1000)),
    );
  });

  it('never shares a key between two orders', () => {
    expect(helper.buildCheckoutIdempotencyKey(12, reservation)).not.toBe(
      helper.buildCheckoutIdempotencyKey(13, reservation),
    );
  });
});

describe('buildCheckoutSessionPayload', () => {
  const payload = () =>
    helper.buildCheckoutSessionPayload({ orderId: 12, userId: 3, total: 19.99 });

  it('asks for a one time card payment of the order total in cents', () => {
    expect(payload()).toMatchObject({
      mode: 'payment',
      allowed_payment_method_types: ['card'],
      client_reference_id: '12',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: 1999,
            product_data: { name: 'Cartlify order #12' },
          },
        },
      ],
    });
  });

  // 10.15 * 100 is 1014.9999999999999 in floating point
  it.each([
    [10.15, 1015],
    [0.29, 29],
    [4.35, 435],
    [1234567.89, 123456789],
    [0, 0],
  ])('turns a total of %d into %d cents without losing a cent', (total, cents) => {
    const out = helper.buildCheckoutSessionPayload({ orderId: 1, userId: 1, total });

    expect(out.line_items?.[0]?.price_data?.unit_amount).toBe(cents);
  });

  it('keeps the order and its owner in the metadata the webhook reads', () => {
    expect(payload().metadata).toEqual({ entityType: 'order', entityId: '12', userId: '3' });
  });

  // stripe replaces only the literal {CHECKOUT_SESSION_ID}, an encoded %7B...%7D stays as it is
  it('puts the session id template into the success url as stripe expects it', () => {
    expect(payload().success_url).toContain('session_id={CHECKOUT_SESSION_ID}');
  });

  it('keeps the query the success url already has', () => {
    expect(payload().success_url).toBe(
      'https://shop.cartlify.test/checkout/success?from=stripe&session_id={CHECKOUT_SESSION_ID}',
    );
  });

  it.each([
    [
      'has no query',
      'https://shop.cartlify.test/paid',
      'https://shop.cartlify.test/paid?session_id={CHECKOUT_SESSION_ID}',
    ],
    [
      'already has a session id',
      'https://shop.cartlify.test/paid?session_id=old',
      'https://shop.cartlify.test/paid?session_id={CHECKOUT_SESSION_ID}',
    ],
    [
      'has a hash',
      'https://shop.cartlify.test/app#/paid',
      'https://shop.cartlify.test/app?session_id={CHECKOUT_SESSION_ID}#/paid',
    ],
  ])('adds the template once and in the query when the success url %s', async (_case, url, out) => {
    const other = await importWithEnv<Helper>(
      '@routes/api/payments/services/helpers/checkoutSession.helper.js',
      { ...CONFIG, STRIPE_SUCCESS_URL: url },
    );

    expect(other.buildCheckoutSessionPayload({ orderId: 1, userId: 1, total: 1 }).success_url).toBe(
      out,
    );
  });

  it('sends the customer back to the cancel page with the order id', () => {
    const url = new URL(payload().cancel_url!);

    expect(url.origin + url.pathname).toBe(CONFIG.STRIPE_CANCEL_URL);
    expect(url.searchParams.get('orderId')).toBe('12');
  });
});

describe('getOrderIdFromCheckoutSession', () => {
  it('reads the order id from the metadata', () => {
    expect(helper.getOrderIdFromCheckoutSession(session())).toBe(12);
  });

  it('rejects a session that was not made for an order', () => {
    const other = session({ metadata: { entityType: 'subscription', entityId: '12' } });

    expect(thrownBy(() => helper.getOrderIdFromCheckoutSession(other))).toMatchObject({
      statusCode: 500,
      details: { reason: 'STRIPE_CHECKOUT_SESSION_ENTITY_TYPE_INVALID' },
    });
  });

  it('rejects a session without metadata', () => {
    expect(
      thrownBy(() => helper.getOrderIdFromCheckoutSession(session({ metadata: null }))),
    ).toMatchObject({
      details: { reason: 'STRIPE_CHECKOUT_SESSION_ENTITY_TYPE_INVALID' },
    });
  });

  it('rejects a session without an order id', () => {
    const noId = session({ metadata: { entityType: 'order' } });

    expect(thrownBy(() => helper.getOrderIdFromCheckoutSession(noId))).toMatchObject({
      details: { reason: 'STRIPE_CHECKOUT_SESSION_ENTITY_ID_MISSING' },
    });
  });

  it.each(['0', '-3', '1.5', 'abc'])('rejects the order id %s', (entityId) => {
    const bad = session({ metadata: { entityType: 'order', entityId } });

    expect(thrownBy(() => helper.getOrderIdFromCheckoutSession(bad))).toMatchObject({
      details: { reason: 'STRIPE_CHECKOUT_SESSION_ENTITY_ID_INVALID' },
    });
  });
});

describe('getUserIdFromCheckoutSession', () => {
  it('reads the order owner from the metadata', () => {
    expect(helper.getUserIdFromCheckoutSession(session())).toBe(3);
  });

  it.each([
    ['has no owner, as sessions made before it was added', { entityType: 'order' }],
    ['has an owner that is not a number', { userId: 'abc' }],
    ['has an owner id of zero', { userId: '0' }],
  ])('gives null when the session %s', (_case, metadata) => {
    expect(helper.getUserIdFromCheckoutSession(session({ metadata }))).toBeNull();
  });
});

describe('getPaymentIntentIdFromCheckoutSession', () => {
  it('reads a payment intent id', () => {
    expect(helper.getPaymentIntentIdFromCheckoutSession(session())).toBe('pi_test_1');
  });

  it('reads the id of an expanded payment intent', () => {
    const expanded = session({ payment_intent: { id: 'pi_test_2' } as Stripe.PaymentIntent });

    expect(helper.getPaymentIntentIdFromCheckoutSession(expanded)).toBe('pi_test_2');
  });

  it('rejects a paid session without a payment intent', () => {
    expect(
      thrownBy(() =>
        helper.getPaymentIntentIdFromCheckoutSession(session({ payment_intent: null })),
      ),
    ).toMatchObject({ details: { reason: 'STRIPE_CHECKOUT_SESSION_PAYMENT_INTENT_MISSING' } });
  });
});

describe('getPaidAmountFromCheckoutSession', () => {
  it.each([
    [1999, '19.99'],
    [5, '0.05'],
    [50, '0.50'],
    [0, '0.00'],
    [123456789, '1234567.89'],
  ])('turns %d cents into %s', (amount_total, paid) => {
    expect(helper.getPaidAmountFromCheckoutSession(session({ amount_total }))).toBe(paid);
  });

  it.each([
    ['missing', null],
    ['negative', -1],
    ['not whole', 19.5],
  ])('rejects an amount that is %s', (_case, amount_total) => {
    expect(
      thrownBy(() => helper.getPaidAmountFromCheckoutSession(session({ amount_total }))),
    ).toMatchObject({ details: { reason: 'STRIPE_CHECKOUT_SESSION_AMOUNT_INVALID' } });
  });
});

describe('mapCreatedCheckoutSession', () => {
  const stripeExpiry = new Date(1_780_000_000 * 1000);

  it('gives the session the client opens', () => {
    expect(helper.mapCreatedCheckoutSession(session(), 12, null)).toEqual({
      checkoutSession: {
        sessionId: 'cs_test_1',
        url: 'https://checkout.stripe.test/c/pay/cs_test_1',
        mode: 'payment',
        status: 'open',
        paymentStatus: 'unpaid',
        expiresAt: stripeExpiry.toISOString(),
      },
    });
  });

  it('shows the end of the reservation when it comes before stripe closes the session', () => {
    const reservation = new Date(stripeExpiry.getTime() - 60_000);

    expect(
      helper.mapCreatedCheckoutSession(session(), 12, reservation).checkoutSession.expiresAt,
    ).toBe(reservation.toISOString());
  });

  it('shows the stripe expiry when the reservation lasts longer', () => {
    const reservation = new Date(stripeExpiry.getTime() + 60_000);

    expect(
      helper.mapCreatedCheckoutSession(session(), 12, reservation).checkoutSession.expiresAt,
    ).toBe(stripeExpiry.toISOString());
  });

  it('gives a null url when stripe sends none', () => {
    expect(
      helper.mapCreatedCheckoutSession(session({ url: null }), 12, null).checkoutSession.url,
    ).toBeNull();
  });

  it.each([
    ['has no expiry', { expires_at: 0 }, 'PAYMENTS_CHECKOUT_SESSION_EXPIRES_AT_MISSING'],
    [
      'is not a payment',
      { mode: 'subscription' as const },
      'PAYMENTS_CHECKOUT_SESSION_MODE_INVALID',
    ],
    ['has no status', { status: null }, 'PAYMENTS_CHECKOUT_SESSION_STATUS_MISSING'],
    // stripe may add values later, the api promises the client only the known ones
    [
      'has a status the api does not know',
      { status: 'processing' as never },
      'PAYMENTS_CHECKOUT_SESSION_STATUS_UNKNOWN',
    ],
    [
      'has a payment status the api does not know',
      { payment_status: 'pending' as never },
      'PAYMENTS_CHECKOUT_SESSION_PAYMENT_STATUS_UNKNOWN',
    ],
  ])('rejects a session that %s', (_case, patch, reason) => {
    expect(
      thrownBy(() => helper.mapCreatedCheckoutSession(session(patch), 12, null)),
    ).toMatchObject({
      statusCode: 500,
      details: { reason },
    });
  });
});

describe('expireCheckoutSession', () => {
  it.each(['', '   '])('rejects a blank session id before calling stripe', async (sessionId) => {
    const expire = jest.spyOn(stripe.checkout.sessions, 'expire');

    expect(await rejectedBy(() => helper.expireCheckoutSession({ sessionId }))).toMatchObject({
      details: { reason: 'STRIPE_CHECKOUT_SESSION_ID_INVALID' },
    });
    expect(expire).not.toHaveBeenCalled();
  });

  it('expires the session in stripe', async () => {
    const expire = jest
      .spyOn(stripe.checkout.sessions, 'expire')
      .mockResolvedValue(session({ status: 'expired' }) as never);

    await helper.expireCheckoutSession({ sessionId: 'cs_test_1' });

    expect(expire).toHaveBeenCalledWith('cs_test_1');
  });

  it('fails when stripe leaves the session open', async () => {
    jest.spyOn(stripe.checkout.sessions, 'expire').mockResolvedValue(session() as never);

    expect(
      await rejectedBy(() => helper.expireCheckoutSession({ sessionId: 'cs_test_1' })),
    ).toMatchObject({
      details: { reason: 'STRIPE_CHECKOUT_SESSION_EXPIRE_FAILED', status: 'open' },
    });
  });

  it('wraps a stripe failure and keeps it as the cause', async () => {
    const failure = new Error('stripe is down');
    jest.spyOn(stripe.checkout.sessions, 'expire').mockRejectedValue(failure as never);

    expect(
      await rejectedBy(() => helper.expireCheckoutSession({ sessionId: 'cs_test_1' })),
    ).toMatchObject({
      statusCode: 500,
      details: { reason: 'STRIPE_CHECKOUT_SESSION_EXPIRE_UNEXPECTED', sessionId: 'cs_test_1' },
      cause: failure,
    });
  });
});
