import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import type Stripe from 'stripe';

import { rejectedBy, thrownBy } from '../../../../../../helpers/errors.js';
import { importWithEnv } from '../../../../../../helpers/freshImport.js';

type Helper = typeof import('@routes/api/payments/providers/stripe/stripeCheckout.helper.js');
type StripeClient = (typeof import('@config/stripe.js'))['default'];

// the site the return pages are on, the module reads it at import
const CONFIG = {
  WEB_ORIGIN: 'https://shop.example.com',
  STRIPE_CURRENCY: 'eur',
};

let helper: Helper;
let stripe: StripeClient;

beforeAll(async () => {
  helper = await importWithEnv<Helper>(
    '@routes/api/payments/providers/stripe/stripeCheckout.helper.js',
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

  // the buyer moved to another provider, the app closed this page, then came back: the same key
  // would give the closed page back from stripe as if it were open
  it('gives a new key once the app closed a page of the order for another provider', () => {
    const closedAt = new Date('2026-06-01T10:05:00.000Z');

    expect(helper.buildCheckoutIdempotencyKey(12, reservation, closedAt)).not.toBe(
      helper.buildCheckoutIdempotencyKey(12, reservation),
    );
    expect(helper.buildCheckoutIdempotencyKey(12, reservation, closedAt)).toBe(
      helper.buildCheckoutIdempotencyKey(12, reservation, new Date(closedAt)),
    );
  });
});

describe('buildCheckoutSessionPayload', () => {
  const reservationExpiresAt = new Date('2026-06-01T10:15:00.000Z');
  // an order of one item, the way the payment page is opened for one
  const order = (
    total: number,
    items = [{ name: 'Desk lamp', unitPrice: total, quantity: 1 }],
  ) => ({
    orderId: 12,
    userId: 3,
    total,
    reservationExpiresAt,
    items,
    customerEmail: 'anna@example.com',
  });
  const payload = () => helper.buildCheckoutSessionPayload(order(19.99));

  // without it stripe keeps a page open for 24 hours, and a page the timer could not close stayed
  // payable long after the reservation; 30 minutes is the least stripe takes. It comes from the
  // reservation, not from the clock: a repeated request with the same key sends the same values
  it('closes the page at stripe 30 minutes after the end of the reservation', () => {
    expect(payload().expires_at).toBe(Math.floor(reservationExpiresAt.getTime() / 1000) + 30 * 60);
  });

  // the buyer sees what is bought: a line for each item, its name, units and price in cents
  it('asks for a one time card payment with a line for each item', () => {
    const out = helper.buildCheckoutSessionPayload(
      order(34.3, [
        { name: 'Desk lamp', unitPrice: 12.5, quantity: 2 },
        { name: 'Mug', unitPrice: 3.1, quantity: 3 },
      ]),
    );

    expect(out).toMatchObject({
      mode: 'payment',
      allowed_payment_method_types: ['card'],
      client_reference_id: '12',
      line_items: [
        {
          quantity: 2,
          price_data: { currency: 'eur', unit_amount: 1250, product_data: { name: 'Desk lamp' } },
        },
        {
          quantity: 3,
          price_data: { currency: 'eur', unit_amount: 310, product_data: { name: 'Mug' } },
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
  ])('turns a price of %d into %d cents without losing a cent', (total, cents) => {
    const out = helper.buildCheckoutSessionPayload({ ...order(total), orderId: 1, userId: 1 });

    expect(out.line_items?.[0]?.price_data?.unit_amount).toBe(cents);
  });

  // the webhook takes the paid amount for the total of the order: lines that differ from it are a
  // mistake of the server, never a page
  it('refuses lines that do not add up to the total of the order', () => {
    expect(
      thrownBy(() =>
        helper.buildCheckoutSessionPayload(
          order(20, [{ name: 'Desk lamp', unitPrice: 9.99, quantity: 2 }]),
        ),
      ),
    ).toMatchObject({ statusCode: 500, details: { reason: 'STRIPE_LINES_TOTAL_MISMATCH' } });
  });

  it('gives the page the email of the buyer, and none for an account without one', () => {
    expect(payload().customer_email).toBe('anna@example.com');
    expect(
      helper.buildCheckoutSessionPayload({ ...order(19.99), customerEmail: null }),
    ).not.toHaveProperty('customer_email');
  });

  // the payment carries the name of the shop, the bank statement and the stripe dashboard show it
  it('names the order with the name of the shop', async () => {
    expect(payload().payment_intent_data).toEqual({ description: 'Cartlify order #12' });

    const other = await importWithEnv<Helper>(
      '@routes/api/payments/providers/stripe/stripeCheckout.helper.js',
      { ...CONFIG, SHOP_NAME: 'Lamp shop' },
    );
    expect(other.buildCheckoutSessionPayload(order(19.99)).payment_intent_data).toEqual({
      description: 'Lamp shop order #12',
    });
  });

  it('keeps the order and its owner in the metadata the webhook reads', () => {
    expect(payload().metadata).toEqual({ entityType: 'order', entityId: '12', userId: '3' });
  });

  // stripe replaces only the literal {CHECKOUT_SESSION_ID}, an encoded %7B...%7D stays as it is
  it('puts the session id template into the success url as stripe expects it', () => {
    expect(payload().success_url).toContain('session_id={CHECKOUT_SESSION_ID}');
  });

  it('returns the buyer to the success page of the site', () => {
    expect(payload().success_url).toBe(
      'https://shop.example.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
    );
  });

  // WEB_ORIGIN is reduced to the origin, the way a browser sends it
  it.each(['https://shop.example.com/', 'https://shop.example.com/some/page?x=1'])(
    'builds the return pages on the origin of WEB_ORIGIN %s',
    async (origin) => {
      const other = await importWithEnv<Helper>(
        '@routes/api/payments/providers/stripe/stripeCheckout.helper.js',
        { ...CONFIG, WEB_ORIGIN: origin },
      );

      const out = other.buildCheckoutSessionPayload({ ...order(1), orderId: 1, userId: 1 });
      expect(out.success_url).toBe(
        'https://shop.example.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      );
      expect(out.cancel_url).toBe('https://shop.example.com/checkout/cancel?orderId=1');
    },
  );

  it('sends the customer back to the cancel page with the order id', () => {
    const url = new URL(payload().cancel_url!);

    expect(url.origin + url.pathname).toBe('https://shop.example.com/checkout/cancel');
    expect(url.searchParams.get('orderId')).toBe('12');
  });

  // a production server without the address of its site has no page to return the buyer to
  it('refuses with WEB_ORIGIN_REQUIRED in production without WEB_ORIGIN', async () => {
    const other = await importWithEnv<Helper>(
      '@routes/api/payments/providers/stripe/stripeCheckout.helper.js',
      { ...CONFIG, NODE_ENV: 'production', WEB_ORIGIN: '' },
    );

    expect(
      thrownBy(() => other.buildCheckoutSessionPayload({ ...order(1), orderId: 1, userId: 1 })),
    ).toMatchObject({ statusCode: 500, details: { reason: 'WEB_ORIGIN_REQUIRED' } });
  });
});

describe('isOrderCheckoutSession', () => {
  it('takes a page the app opened for an order', () => {
    expect(helper.isOrderCheckoutSession(session())).toBe(true);
  });

  // pages of other tools in the same stripe account, the webhook leaves them and their money alone
  it.each([
    ['no metadata', null],
    ['no entity type', { entityId: '12' }],
    ['another entity type', { entityType: 'subscription', entityId: '12' }],
    ['no order id', { entityType: 'order' }],
    ['an order id that is no number', { entityType: 'order', entityId: 'abc' }],
    ['the order id 0', { entityType: 'order', entityId: '0' }],
    ['a fractional order id', { entityType: 'order', entityId: '1.5' }],
    ['an order id over the largest id', { entityType: 'order', entityId: '2147483648' }],
  ])('refuses a page with %s', (_case, metadata) => {
    expect(
      helper.isOrderCheckoutSession(session({ metadata: metadata as Stripe.Metadata | null })),
    ).toBe(false);
  });

  it('takes the largest order id', () => {
    const page = session({ metadata: { entityType: 'order', entityId: '2147483647' } });

    expect(helper.isOrderCheckoutSession(page)).toBe(true);
  });
});

describe('isStripeResourceMissing', () => {
  // an id stripe never made, or one of another account or mode: for a checkout session stripe
  // answers 404 without a code (checked against the test sandbox), other objects carry one
  it.each([
    ['a checkout session', { statusCode: 404 }],
    ['another object', { statusCode: 404, code: 'resource_missing' }],
  ])('takes the answer stripe gives to an unknown id of %s', (_case, fields) => {
    const missing = Object.assign(new Error('No such checkout.session: cs_test_x'), {
      type: 'StripeInvalidRequestError',
      ...fields,
    });

    expect(helper.isStripeResourceMissing(missing)).toBe(true);
  });

  it.each([
    [
      'another refusal of the request',
      { type: 'StripeInvalidRequestError', statusCode: 400, code: 'parameter_invalid' },
    ],
    ['stripe out of reach', { type: 'StripeConnectionError' }],
    ['a 404 of another kind of error', { type: 'StripeAPIError', statusCode: 404 }],
  ])('does not take %s', (_case, fields) => {
    expect(helper.isStripeResourceMissing(Object.assign(new Error('x'), fields))).toBe(false);
  });

  it.each([null, undefined, 'error'])('does not take %p', (err) => {
    expect(helper.isStripeResourceMissing(err)).toBe(false);
  });
});

describe('isStripeUnavailable', () => {
  // the request may work later: no connection, a failure of stripe itself, too many requests
  it.each(['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError'])(
    'takes %s as stripe out of reach',
    (type) => {
      expect(helper.isStripeUnavailable(Object.assign(new Error('x'), { type }))).toBe(true);
    },
  );

  // a refusal of what was asked stays a refusal
  it.each([['StripeInvalidRequestError'], ['StripeAuthenticationError'], ['StripeCardError']])(
    'does not take %s as stripe out of reach',
    (type) => {
      expect(helper.isStripeUnavailable(Object.assign(new Error('x'), { type }))).toBe(false);
    },
  );

  it.each([null, undefined, 'error', new Error('plain')])('does not take %p', (err) => {
    expect(helper.isStripeUnavailable(err)).toBe(false);
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
        provider: 'stripe',
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

describe('readCheckoutSessionStatus', () => {
  it.each([
    ['an open page', { status: 'open', payment_status: 'unpaid' }, { status: 'open', paid: false }],
    [
      'a paid page',
      { status: 'complete', payment_status: 'paid' },
      { status: 'complete', paid: true },
    ],
    // a bank debit completes the page before the bank says yes or no
    [
      'a complete page of a payment the bank has not confirmed',
      { status: 'complete', payment_status: 'unpaid' },
      { status: 'complete', paid: false },
    ],
    [
      'an expired page',
      { status: 'expired', payment_status: 'unpaid' },
      { status: 'expired', paid: false },
    ],
  ] as const)('tells %s', async (_case, state, expected) => {
    const retrieve = jest
      .spyOn(stripe.checkout.sessions, 'retrieve')
      .mockResolvedValue(session(state as Partial<Stripe.Checkout.Session>) as never);

    expect(await helper.readCheckoutSessionStatus('cs_test_1')).toEqual(expected);
    expect(retrieve).toHaveBeenCalledWith('cs_test_1');
  });

  it('refuses a state stripe added later', async () => {
    jest
      .spyOn(stripe.checkout.sessions, 'retrieve')
      .mockResolvedValue(session({ status: 'reopened' as never }) as never);

    expect(await rejectedBy(() => helper.readCheckoutSessionStatus('cs_test_1'))).toMatchObject({
      details: { reason: 'STRIPE_CHECKOUT_SESSION_STATUS_UNKNOWN', sessionId: 'cs_test_1' },
    });
  });

  it('wraps a stripe failure and keeps it as the cause', async () => {
    const failure = new Error('stripe is down');
    jest.spyOn(stripe.checkout.sessions, 'retrieve').mockRejectedValue(failure as never);

    expect(await rejectedBy(() => helper.readCheckoutSessionStatus('cs_test_1'))).toMatchObject({
      statusCode: 500,
      details: { reason: 'STRIPE_CHECKOUT_SESSION_READ_UNEXPECTED', sessionId: 'cs_test_1' },
      cause: failure,
    });
  });
});
