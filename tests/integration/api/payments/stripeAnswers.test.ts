import { randomBytes } from 'node:crypto';

import type Stripe from 'stripe';
import { afterAll, describe, expect, it } from '@jest/globals';

import {
  buildCheckoutIdempotencyKey,
  buildCheckoutSessionPayload,
} from '@routes/api/payments/providers/stripe/stripeCheckout.helper.js';
import { refundStripePayment } from '@routes/api/payments/providers/stripe/stripeRefund.helper.js';

import {
  closeOpenSessions,
  expireSession,
  lineItemsOf,
  openBankPaymentPage,
  payByCard,
  payCheckoutSession,
  readSession,
  refundsOf,
  rememberSession,
  stripeEvent,
  stripeOfTests,
  stripeWithKey,
} from '../../../helpers/stripe.js';

// the answers of Stripe the app and the tests rely on: the states of a page and of a payment, the
// idempotency keys, the events and the errors the app reads. It runs in both modes, so the mock
// (tests/helpers/stripeMock.ts) answers what the test sandbox answers; a change at Stripe shows
// here first. The pages are built by the code of the app for a made-up order

const stripe = stripeOfTests;

afterAll(closeOpenSessions);

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const randomText = (length: number) =>
  Array.from(randomBytes(length), (byte) => BASE62[byte % BASE62.length]).join('');

// an order of its own for each page, an id no order of the tests has
const newOrderId = () => 2_000_000_000 + Math.floor(Math.random() * 100_000_000);

// the request of the app for a page of an order of a lamp twice and a mug three times
function appPage(opts: { items?: { name: string; unitPrice: number; quantity: number }[] } = {}) {
  const orderId = newOrderId();
  const reservationExpiresAt = new Date(Date.now() + 15 * 60_000);
  const items = opts.items ?? [
    { name: 'Desk lamp', unitPrice: 12.5, quantity: 2 },
    { name: 'Mug', unitPrice: 3.1, quantity: 3 },
  ];

  return {
    orderId,
    params: buildCheckoutSessionPayload({
      orderId,
      userId: 12,
      total: items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0),
      reservationExpiresAt,
      items,
      customerEmail: 'buyer@example.com',
    }),
    idempotencyKey: buildCheckoutIdempotencyKey(orderId, reservationExpiresAt),
  };
}

async function openAppPage(page = appPage()) {
  const session = await stripe.checkout.sessions.create(page.params, {
    idempotencyKey: page.idempotencyKey,
  });
  rememberSession(session.id);
  return session;
}

// what an error of Stripe says, as the app reads it
async function refusalOf(request: Promise<unknown>) {
  const err = await request.then(
    () => {
      throw new Error('Stripe took the request');
    },
    (failure: unknown) => failure as Stripe.errors.StripeError,
  );

  return {
    type: err.type,
    statusCode: err.statusCode,
    code: err.code,
    param: err.param,
    message: err.message,
  };
}

const refused = (fields: {
  statusCode: number;
  message: string | RegExp;
  code?: string;
  param?: string;
  type?: string;
}) => ({
  type: fields.type ?? 'StripeInvalidRequestError',
  statusCode: fields.statusCode,
  code: fields.code,
  param: fields.param,
  message:
    typeof fields.message === 'string' ? fields.message : expect.stringMatching(fields.message),
});

// a test card of the buyer, for a payment of the page through its own api
const testCard = () =>
  stripe.paymentMethods.create({
    type: 'card',
    card: { token: 'tok_visa' },
    billing_details: { email: 'buyer@example.com', name: 'Test Buyer' },
  });

const confirmPage = (sessionId: string, paymentMethod: string, expectedAmount: number) =>
  stripe.rawRequest('POST', `/v1/payment_pages/${sessionId}/confirm`, {
    payment_method: paymentMethod,
    expected_amount: expectedAmount,
  });

describe('a payment page the app opens', () => {
  it('is open and unpaid, for the sum of its lines, with the data of the order', async () => {
    const page = appPage();

    const session = await openAppPage(page);

    const expected = {
      id: expect.stringMatching(/^cs_test_[A-Za-z0-9]{58}$/),
      object: 'checkout.session',
      status: 'open',
      payment_status: 'unpaid',
      payment_intent: null,
      url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/),
      mode: 'payment',
      amount_subtotal: 3430,
      amount_total: 3430,
      currency: 'eur',
      client_reference_id: String(page.orderId),
      metadata: { entityType: 'order', entityId: String(page.orderId), userId: '12' },
      customer_email: 'buyer@example.com',
      customer_details: expect.objectContaining({ email: 'buyer@example.com', name: null }),
      success_url: page.params.success_url,
      cancel_url: page.params.cancel_url,
      expires_at: page.params.expires_at,
      allowed_payment_method_types: ['card'],
      livemode: false,
    };
    expect(session).toMatchObject(expected);
    expect(await readSession(session.id)).toMatchObject({ ...expected, id: session.id });
  });

  it('is the same page for the same key and the same request, and Stripe says it is', async () => {
    const page = appPage();
    const first = await openAppPage(page);

    const again = await openAppPage(page);

    expect(again.id).toBe(first.id);
    expect(again.lastResponse.headers['idempotent-replayed']).toBe('true');
  });

  it('is refused for the same key with another request', async () => {
    const page = appPage();
    await openAppPage(page);

    const refusal = await refusalOf(
      stripe.checkout.sessions.create(
        { ...page.params, client_reference_id: '1' },
        { idempotencyKey: page.idempotencyKey },
      ),
    );

    expect(refusal).toEqual(
      refused({
        type: 'StripeIdempotencyError',
        statusCode: 400,
        message:
          'Keys for idempotent requests can only be used with the same parameters they were ' +
          `first used with. Try using a key other than '${page.idempotencyKey}' if you meant to ` +
          'execute a different request.',
      }),
    );
  });

  it.each([
    [
      'in less than 30 minutes',
      10 * 60,
      /must be at least 30 minutes from Checkout Session creation/,
    ],
    [
      'in more than 24 hours',
      25 * 3600,
      /must be less than 24 hours from Checkout Session creation/,
    ],
  ])('is refused when it would close %s', async (_case, seconds, message) => {
    const { params } = appPage();

    const refusal = await refusalOf(
      stripe.checkout.sessions.create({
        ...params,
        expires_at: Math.floor(Date.now() / 1000) + seconds,
      }),
    );

    expect(refusal).toEqual(refused({ statusCode: 400, message }));
  });

  it('is refused for a total below 0.50 EUR', async () => {
    const { params } = appPage({ items: [{ name: 'Pin', unitPrice: 0.49, quantity: 1 }] });

    const refusal = await refusalOf(stripe.checkout.sessions.create(params));

    expect(refusal).toEqual(
      refused({
        statusCode: 400,
        param: 'allowed_payment_method_types',
        message:
          /`card` is invalid because: The Checkout Session's total amount due must add up to at least €0.50 EUR$/,
      }),
    );
  });

  it('lists its lines the way the buyer sees them', async () => {
    const session = await openAppPage();

    expect(await lineItemsOf(session.id)).toEqual([
      { description: 'Desk lamp', quantity: 2, unitAmount: 1250, amountTotal: 2500 },
      { description: 'Mug', quantity: 3, unitAmount: 310, amountTotal: 930 },
    ]);
  });
});

describe('a page Stripe does not know', () => {
  it.each([
    ['of the test mode', 'cs_test_'],
    ['of the live mode', 'cs_live_'],
  ])('is not found by its id %s', async (_case, prefix) => {
    const id = prefix + randomText(58);

    const refusal = await refusalOf(stripe.checkout.sessions.retrieve(id));

    expect(refusal).toEqual(
      refused({
        statusCode: 404,
        code: 'resource_missing',
        message: `No such checkout.session: ${id}`,
      }),
    );
  });

  it('is not found by an id longer than Stripe makes, with no code', async () => {
    const id = `cs_test_${randomText(64)}`;

    const refusal = await refusalOf(stripe.checkout.sessions.retrieve(id));

    expect(refusal).toEqual(
      refused({
        statusCode: 404,
        param: 'session',
        message: `Invalid string: ${id.slice(0, 4)}...${id.slice(-4)}; must be at most 66 characters`,
      }),
    );
  });

  it.each([
    ['closed', (id: string) => stripe.checkout.sessions.expire(id)],
    ['asked for its lines', (id: string) => stripe.checkout.sessions.listLineItems(id)],
  ])('is not found when it is %s', async (_case, request) => {
    const id = `cs_test_${randomText(58)}`;

    const refusal = await refusalOf(request(id));

    expect(refusal).toEqual(
      refused({
        statusCode: 404,
        code: 'resource_missing',
        param: 'session',
        message: `No such checkout session: '${id}'`,
      }),
    );
  });
});

describe('closing a page', () => {
  it('closes an open page, which has no url then, and records checkout.session.expired', async () => {
    const session = await openAppPage();

    const closed = await expireSession(session.id);

    expect(closed).toMatchObject({
      id: session.id,
      status: 'expired',
      payment_status: 'unpaid',
      url: null,
    });
    const event = await stripeEvent('checkout.session.expired', session.id);
    expect(event).toMatchObject({
      object: 'event',
      type: 'checkout.session.expired',
      livemode: false,
      data: { object: { id: session.id, status: 'expired', payment_status: 'unpaid' } },
    });
  });

  it('is refused for a page that is not open', async () => {
    const session = await openAppPage();
    await expireSession(session.id);

    const refusal = await refusalOf(stripe.checkout.sessions.expire(session.id));

    expect(refusal).toEqual(
      refused({
        statusCode: 400,
        message:
          'Only Checkout Sessions with a status in ["open"] can be expired. This Checkout ' +
          'Session has a status of `expired`.',
      }),
    );
  });
});

describe('paying a page with a test card', () => {
  it('is refused for an amount the page does not show', async () => {
    const session = await openAppPage();
    const card = await testCard();

    const refusal = await refusalOf(confirmPage(session.id, card.id, 1));

    expect(refusal).toEqual(
      refused({
        statusCode: 400,
        code: 'checkout_amount_mismatch',
        param: 'expected_amount',
        message:
          'Your order has been updated. Please review the updated total and submit payment again.',
      }),
    );
  });

  it('completes the page with its payment and records checkout.session.completed with the page', async () => {
    const session = await openAppPage();

    const paymentId = await payCheckoutSession(session.id);

    const paid = await readSession(session.id);
    expect(paymentId).toMatch(/^pi_[A-Za-z0-9]{24}$/);
    expect(paid).toMatchObject({
      status: 'complete',
      payment_status: 'paid',
      payment_intent: paymentId,
      amount_total: 3430,
      url: null,
      customer_details: expect.objectContaining({ email: 'buyer@example.com', name: 'Test Buyer' }),
    });
    const event = await stripeEvent('checkout.session.completed', session.id);
    expect(event.data.object).toMatchObject({
      id: session.id,
      status: 'complete',
      payment_status: 'paid',
      payment_intent: paymentId,
      metadata: paid.metadata,
    });
    expect(Object.keys(event.data.object).sort()).toEqual(Object.keys(paid).sort());
    expect(await stripe.paymentIntents.retrieve(paymentId)).toMatchObject({
      status: 'succeeded',
      amount: 3430,
      currency: 'eur',
      // the payment names the shop and the order
      description: expect.stringMatching(/ order #\d+$/),
    });
  });

  it('is refused for a page paid already, and a paid page is not closed', async () => {
    const session = await openAppPage();
    await payCheckoutSession(session.id);
    const card = await testCard();

    expect(await refusalOf(confirmPage(session.id, card.id, 3430))).toEqual(
      refused({
        statusCode: 400,
        code: 'checkout_succeeded_session',
        message: 'Your payment has already been processed.',
      }),
    );
    expect(await refusalOf(stripe.checkout.sessions.expire(session.id))).toEqual(
      refused({ statusCode: 400, message: /This Checkout Session has a status of `complete`\.$/ }),
    );
  });

  it('is refused for a closed page', async () => {
    const session = await openAppPage();
    await expireSession(session.id);
    const card = await testCard();

    const refusal = await refusalOf(confirmPage(session.id, card.id, 3430));

    expect(refusal).toEqual(
      refused({
        statusCode: 400,
        code: 'checkout_not_active_session',
        message: 'This Checkout Session is no longer active.',
      }),
    );
  });
});

describe('a page paid by a bank debit', () => {
  it('is complete but not paid, its payment processing, and is not closed any more', async () => {
    const sessionId = await openBankPaymentPage(1000);

    const page = await readSession(sessionId);

    expect(page).toMatchObject({ status: 'complete', payment_status: 'unpaid' });
    expect(await stripe.paymentIntents.retrieve(page.payment_intent as string)).toMatchObject({
      status: 'processing',
    });
    expect(await refusalOf(stripe.checkout.sessions.expire(sessionId))).toEqual(
      refused({ statusCode: 400, message: /This Checkout Session has a status of `complete`\.$/ }),
    );
  });
});

describe('a refund of the app', () => {
  it('gives the whole payment back once for its key, and Stripe refuses a second refund', async () => {
    const paymentId = await payByCard(2000);

    const first = await refundStripePayment({ orderId: 2_000_000_001, paymentIntentId: paymentId });
    const again = await refundStripePayment({ orderId: 2_000_000_001, paymentIntentId: paymentId });

    expect(again.refundId).toBe(first.refundId);
    expect(await refundsOf(paymentId)).toEqual([
      expect.objectContaining({
        id: first.refundId,
        object: 'refund',
        amount: 2000,
        currency: 'eur',
        status: 'succeeded',
        payment_intent: paymentId,
        charge: expect.stringMatching(/^ch_/),
        metadata: { entityType: 'order', entityId: '2000000001' },
      }),
    ]);
    const charge = (await stripe.paymentIntents.retrieve(paymentId)).latest_charge;
    expect(await refusalOf(stripe.refunds.create({ payment_intent: paymentId }))).toEqual(
      refused({
        statusCode: 400,
        code: 'charge_already_refunded',
        message: `Charge ${String(charge)} has already been refunded.`,
      }),
    );
  });

  it('is not found for a payment Stripe does not know', async () => {
    const id = `pi_${randomText(24)}`;

    expect(await refusalOf(stripe.refunds.create({ payment_intent: id }))).toEqual(
      refused({
        statusCode: 404,
        code: 'resource_missing',
        param: 'id',
        message: `No such payment_intent: '${id}'`,
      }),
    );
    expect(await refusalOf(stripe.paymentIntents.retrieve(id))).toEqual(
      refused({
        statusCode: 404,
        code: 'resource_missing',
        param: 'intent',
        message: `No such payment_intent: '${id}'`,
      }),
    );
    expect(await refusalOf(stripe.refunds.list({ payment_intent: id }))).toEqual(
      refused({
        statusCode: 404,
        code: 'resource_missing',
        param: 'payment_intent',
        message: `No such payment_intent: '${id}'`,
      }),
    );
  });
});

describe('a card payment without a page', () => {
  it('is taken at once with its charge', async () => {
    const paymentId = await payByCard(2000);

    expect(await stripe.paymentIntents.retrieve(paymentId)).toMatchObject({
      id: paymentId,
      object: 'payment_intent',
      status: 'succeeded',
      amount: 2000,
      amount_received: 2000,
      currency: 'eur',
      latest_charge: expect.stringMatching(/^ch_[A-Za-z0-9]{24}$/),
    });
  });
});

describe('a key Stripe does not know', () => {
  it('is refused, and Stripe quotes only its end', async () => {
    const unknown = stripeWithKey(`sk_test_${randomText(20)}0000`);

    const refusal = await refusalOf(
      unknown.checkout.sessions.retrieve(`cs_test_${randomText(58)}`),
    );

    expect(refusal).toEqual(
      refused({
        type: 'StripeAuthenticationError',
        statusCode: 401,
        message: /^Invalid API Key provided: sk_test_\*+0000$/,
      }),
    );
  });
});
