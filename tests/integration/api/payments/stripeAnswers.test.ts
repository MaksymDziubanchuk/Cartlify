import { randomBytes } from 'node:crypto';

import type Stripe from 'stripe';
import { afterAll, describe, expect, it } from '@jest/globals';

import { setShopSettingsForTest } from '@config/shopSettings.js';
import {
  buildCheckoutIdempotencyKey,
  buildCheckoutSessionPayload,
  paymentPageReadingOf,
  readStripePaidPage,
} from '@routes/api/payments/providers/stripe/stripeCheckout.helper.js';
import {
  getStripeDispute,
  putStripeDisputeEvidence,
} from '@routes/api/payments/providers/stripe/stripeDispute.helper.js';
import {
  findStripeRefund,
  getStripeRefund,
  listStripeRefunds,
  refundStripePayment,
} from '@routes/api/payments/providers/stripe/stripeRefund.helper.js';

import {
  closeDispute,
  closeOpenSessions,
  disputeOf,
  disputesOf,
  expireSession,
  lineItemsOf,
  openBankPaymentPage,
  DISPUTED_CARD,
  payByCard,
  payCheckoutSession,
  PENDING_REFUND_CARD,
  readSession,
  refundAtStripe,
  refundsOf,
  refundBecomes,
  REFUND_FAIL_CARD,
  rememberSession,
  stripeEvent,
  stripeOfTests,
  stripeWait,
  stripeWithKey,
  tryCardOnPage,
  untilStripe,
} from '../../../helpers/stripe.js';

// the answers of Stripe the app and the tests rely on: the states of a page and of a payment, the
// idempotency keys, the events and the errors the app reads. It runs in both modes, so the mock
// (tests/helpers/stripeMock.ts) answers what the test sandbox answers; a change at Stripe shows
// here first. The pages are built by the code of the app for a made-up order

const stripe = stripeOfTests;

// this file calls the stripe helpers directly, no startApp (no loadShopSettings read a row):
// the server defaults are enough, the checkout description is only ever matched loosely here
setShopSettingsForTest();

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
      locale: 'en',
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
      // the letter before /pay is Stripe's own (c, g): the app hands the address on as it is
      url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\/[a-z]\/pay\/cs_test_/),
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
      // a card (its wallets with it), PayPal and Bizum, all switched on in the dashboard
      allowed_payment_method_types: ['card', 'paypal', 'bizum'],
      payment_method_types: ['card', 'paypal', 'bizum'],
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

  // none of a card, PayPal and Bizum takes it, Stripe names the first
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
  it('is refused by the bank of a declined card, and the page stays open for another card', async () => {
    const session = await openAppPage();

    const refusals = [];
    for (const token of [
      'tok_chargeDeclined',
      'tok_chargeDeclinedInsufficientFunds',
      'tok_chargeDeclinedExpiredCard',
    ]) {
      refusals.push(await tryCardOnPage(session.id, token));
    }
    const open = await stripe.checkout.sessions.retrieve(session.id);
    const paid = await tryCardOnPage(session.id, 'tok_visa');

    expect(refusals).toEqual([
      {
        statusCode: 402,
        type: 'StripeCardError',
        code: 'card_declined',
        declineCode: 'generic_decline',
        message: 'Your card was declined.',
      },
      {
        statusCode: 402,
        type: 'StripeCardError',
        code: 'card_declined',
        declineCode: 'insufficient_funds',
        message:
          'Your card has insufficient funds. Use a different payment method to complete this purchase.',
      },
      {
        statusCode: 402,
        type: 'StripeCardError',
        code: 'expired_card',
        declineCode: 'expired_card',
        message: 'Your card has expired.',
      },
    ]);
    expect(open).toMatchObject({ status: 'open', payment_status: 'unpaid' });
    expect(paid).toBeNull();
    expect(await stripe.checkout.sessions.retrieve(session.id)).toMatchObject({
      status: 'complete',
      payment_status: 'paid',
    });
  });

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

  // the timer reads a page it found paid the way the webhook reads the event of the page
  it('is read paid at Stripe the way its checkout.session.completed is read', async () => {
    const page = appPage();
    const session = await openAppPage(page);
    expect(await readStripePaidPage(session.id)).toEqual({
      state: 'unpaid',
      pageId: session.id,
      orderId: page.orderId,
    });

    const paymentId = await payCheckoutSession(session.id);

    const read = await readStripePaidPage(session.id);
    const event = await stripeEvent('checkout.session.completed', session.id);
    expect(read).toEqual({
      state: 'paid',
      pageId: session.id,
      orderId: page.orderId,
      userId: 12,
      paymentId,
      amount: '34.30',
      currency: 'eur',
    });
    expect(paymentPageReadingOf(event.data.object as Stripe.Checkout.Session)).toEqual(read);
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
  const refundOf = (paymentId: string, amount: string, key: string) =>
    refundStripePayment({ orderId: 2_000_000_001, paymentIntentId: paymentId, amount, key });

  it('gives the whole payment back once for its key, and Stripe refuses a second refund', async () => {
    const paymentId = await payByCard(2000);

    const first = await refundOf(paymentId, '20.00', `refund:${paymentId}`);
    const again = await refundOf(paymentId, '20.00', `refund:${paymentId}`);

    expect(first).toEqual({
      refundId: expect.stringMatching(/^re_/),
      status: 'succeeded',
      bankReference: null,
    });
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
        metadata: {
          entityType: 'order',
          entityId: '2000000001',
          transfer: `refund:${paymentId}`,
        },
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

  it('gives back a part for each key, the same refund for the same key, and no more than is left', async () => {
    const paymentId = await payByCard(2000);
    const key = `refund:${randomText(20)}`;

    const part = await refundOf(paymentId, '5.00', key);
    const sameKey = await refundOf(paymentId, '5.00', key);
    const next = await refundOf(paymentId, '7.00', `refund:${randomText(20)}`);
    const tooMuch = await refundOf(paymentId, '9.00', `refund:${randomText(20)}`);

    expect(part).toEqual({
      refundId: expect.stringMatching(/^re_/),
      status: 'succeeded',
      bankReference: null,
    });
    expect(sameKey.refundId).toBe(part.refundId);
    expect(next.refundId).not.toBe(part.refundId);
    // 8.00 are left: Stripe refuses 9.00 with its words and the parameter amount, no code (the
    // sandbox, 11.11.2026), nothing is refunded
    expect(
      await refusalOf(stripe.refunds.create({ payment_intent: paymentId, amount: 900 })),
    ).toEqual(
      refused({
        statusCode: 400,
        param: 'amount',
        message: 'Refund amount (€9.00) is greater than unrefunded amount on charge (€8.00)',
      }),
    );
    expect(tooMuch).toEqual({
      refundId: null,
      status: 'failed',
      failure: 'already_refunded',
      failureText: expect.stringMatching(/is greater than unrefunded amount on charge/),
      bankReference: null,
    });
    expect((await refundsOf(paymentId)).map((refund) => refund.amount).sort()).toEqual([500, 700]);
  });

  it('is found by the key of its transfer among the refunds of the payment, and not found by another', async () => {
    const paymentId = await payByCard(2000);
    const key = `refund:${randomText(20)}`;
    const made = await refundOf(paymentId, '5.00', key);
    await refundOf(paymentId, '7.00', `refund:${randomText(20)}`);

    const found = await findStripeRefund({ paymentIntentId: paymentId, key });
    const none = await findStripeRefund({
      paymentIntentId: paymentId,
      key: `refund:${randomText(20)}`,
    });

    // the number of the bank comes a moment after the refund was made
    expect(found).toEqual({ ...made, bankReference: found!.bankReference });
    expect(none).toBeNull();
  });

  it('is read by its id, the way it was made', async () => {
    const paymentId = await payByCard(1500);
    const made = await refundOf(paymentId, '15.00', `refund:${paymentId}`);

    const read = await getStripeRefund(made.refundId!);

    // the number of the bank may come between the two reads: the sandbox gives it within seconds
    expect(read).toEqual({ ...made, bankReference: read.bankReference });
    expect(read.bankReference === null || /^\d+$/.test(read.bankReference)).toBe(true);
    expect(await stripe.refunds.retrieve(made.refundId!)).toMatchObject({
      id: made.refundId,
      object: 'refund',
      amount: 1500,
      status: 'succeeded',
      payment_intent: paymentId,
    });
  });

  // the sandbox ends it about two minutes later with one refund.updated of status succeeded (seen
  // 04.11.2026), longer than a test waits; the mock ends it when a test says so
  it('of a payment by the card of a pending refund is pending, and is read so', async () => {
    const paymentId = await payByCard(1200, PENDING_REFUND_CARD);
    const made = await refundOf(paymentId, '12.00', `refund:${paymentId}`);

    expect(made).toEqual({
      refundId: expect.stringMatching(/^re_/),
      status: 'pending',
      bankReference: null,
    });
    expect(await getStripeRefund(made.refundId!)).toEqual(made);
  });

  it('is refused for a payment the buyer disputed at the bank, as charge_disputed', async () => {
    const paymentId = await payByCard(1000, DISPUTED_CARD);
    const { latest_charge: charge } = await stripe.paymentIntents.retrieve(paymentId);

    expect(
      await refusalOf(stripe.refunds.create({ payment_intent: paymentId, amount: 500 })),
    ).toEqual(
      refused({
        statusCode: 400,
        code: 'charge_disputed',
        message: `Charge ${String(charge)} has been charged back; cannot issue a refund.`,
      }),
    );
    expect(await refundOf(paymentId, '5.00', `refund:${paymentId}`)).toMatchObject({
      status: 'failed',
      failure: 'disputed',
    });
  });

  // the sandbox fails it about 130 s later: the test waits
  it(
    'of a payment by the card of a card that is gone succeeds, then fails with refund.failed',
    async () => {
      const paymentId = await payByCard(1100, REFUND_FAIL_CARD);
      const made = await refundOf(paymentId, '11.00', `refund:${paymentId}`);
      expect(made).toEqual({
        refundId: expect.stringMatching(/^re_/),
        status: 'succeeded',
        bankReference: null,
      });

      await refundBecomes(made.refundId!, { status: 'failed', reason: 'expired_or_canceled_card' });

      expect(await getStripeRefund(made.refundId!)).toMatchObject({
        refundId: made.refundId,
        status: 'failed',
        failure: 'card_unavailable',
      });
      const event = await stripeEvent('refund.failed', made.refundId!);
      expect(event.data.object).toMatchObject({
        id: made.refundId,
        status: 'failed',
        failure_reason: 'expired_or_canceled_card',
      });
    },
    stripeWait,
  );

  it('is not found by an id Stripe does not know', async () => {
    const id = `re_${randomText(24)}`;

    expect(await refusalOf(stripe.refunds.retrieve(id))).toMatchObject({
      type: 'StripeInvalidRequestError',
      statusCode: 404,
      code: 'resource_missing',
      message: `No such refund: '${id}'`,
    });
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

describe('the refunds of a payment', () => {
  const refundOf = (paymentId: string, amount: string, key: string) =>
    refundStripePayment({ orderId: 2_000_000_001, paymentIntentId: paymentId, amount, key });

  it('are listed the newest first, a page at a time, the ones made by hand without a key', async () => {
    const paymentId = await payByCard(3000);
    const key = `refund:${randomText(20)}`;
    const ours = await refundOf(paymentId, '5.00', key);
    const byHand = await refundAtStripe(paymentId, {
      amount: 700,
      reason: 'requested_by_customer',
    });
    const last = await refundOf(paymentId, '3.00', `refund:${randomText(20)}`);

    const first = await stripe.refunds.list({ payment_intent: paymentId, limit: 2 });
    const rest = await stripe.refunds.list({
      payment_intent: paymentId,
      limit: 2,
      starting_after: first.data[1]!.id,
    });

    expect(first).toMatchObject({ object: 'list', url: '/v1/refunds', has_more: true });
    expect(first.data.map((refund) => refund.id)).toEqual([last.refundId, byHand.id]);
    expect(rest).toMatchObject({ has_more: false });
    expect(rest.data.map((refund) => refund.id)).toEqual([ours.refundId]);
    expect(byHand).toMatchObject({
      object: 'refund',
      amount: 700,
      status: 'succeeded',
      reason: 'requested_by_customer',
      metadata: {},
    });
    expect(await listStripeRefunds(paymentId)).toEqual([
      expect.objectContaining({
        refundId: ours.refundId,
        amount: '5.00',
        transferKey: key,
        reason: null,
      }),
      expect.objectContaining({
        refundId: byHand.id,
        status: 'succeeded',
        amount: '7.00',
        transferKey: null,
        reason: 'requested_by_customer',
        createdAt: new Date(byHand.created * 1000),
      }),
      expect.objectContaining({ refundId: last.refundId, amount: '3.00' }),
    ]);
  });

  // the webhook hears of a refund made in the dashboard by this event, and of nothing else
  it('record refund.created for a refund made by hand, without a key', async () => {
    const paymentId = await payByCard(1000);

    const byHand = await refundAtStripe(paymentId, { reason: 'duplicate' });

    const event = await stripeEvent('refund.created', byHand.id);
    expect(event.data.object).toMatchObject({
      id: byHand.id,
      object: 'refund',
      amount: 1000,
      status: 'succeeded',
      payment_intent: paymentId,
      reason: 'duplicate',
      metadata: {},
    });
  });

  // the number of the bank of the card (ARN) comes days after the money is sent
  it('of a card has the details of its destination, without the number of the bank yet', async () => {
    const paymentId = await payByCard(1000);
    const made = await refundOf(paymentId, '10.00', `refund:${paymentId}`);

    const refund = await stripe.refunds.retrieve(made.refundId!);

    expect(refund.destination_details).toEqual({
      card: {
        reference_status: 'pending',
        reference_type: 'acquirer_reference_number',
        type: 'refund',
      },
      type: 'card',
    });
  });
});

describe('a dispute of a payment', () => {
  // the sandbox opens the dispute of the card a moment after the payment
  const disputeOfCard = async (amount: number) => {
    const paymentId = await payByCard(amount, DISPUTED_CARD);
    const dispute = await untilStripe(
      'the dispute of the payment',
      async () => (await disputesOf(paymentId))[0] ?? null,
    );
    return { paymentId, dispute };
  };

  it('is a fraudulent chargeback of the card of a dispute, which takes the sum and a fee at once', async () => {
    const { paymentId, dispute } = await disputeOfCard(1000);

    expect(dispute).toMatchObject({
      id: expect.stringMatching(/^du_[A-Za-z0-9]{24}$/),
      object: 'dispute',
      amount: 1000,
      currency: 'eur',
      charge: expect.stringMatching(/^ch_/),
      payment_intent: paymentId,
      reason: 'fraudulent',
      status: 'needs_response',
      is_charge_refundable: false,
      livemode: false,
      evidence_details: {
        due_by: expect.any(Number),
        has_evidence: false,
        past_due: false,
        submission_count: 0,
      },
    });
    expect(dispute.balance_transactions).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^txn_/),
        object: 'balance_transaction',
        amount: -1000,
        currency: 'eur',
        fee: expect.any(Number),
        reporting_category: 'dispute',
        type: 'adjustment',
      }),
    ]);
    const [withdrawn] = dispute.balance_transactions;
    expect(withdrawn!.fee).toBeGreaterThan(0);
    expect(withdrawn!.net).toBe(withdrawn!.amount - withdrawn!.fee);
    expect((await stripeEvent('charge.dispute.created', dispute.id)).data.object).toMatchObject({
      id: dispute.id,
      status: 'needs_response',
    });
    expect(
      (await stripeEvent('charge.dispute.funds_withdrawn', dispute.id)).data.object,
    ).toMatchObject({ id: dispute.id, balance_transactions: [{ id: withdrawn!.id }] });
    expect(await getStripeDispute(dispute.id)).toMatchObject({
      id: dispute.id,
      paymentId,
      status: 'needs_response',
      reason: 'fraudulent',
      amount: '10.00',
      currency: 'eur',
      hasEvidence: false,
      submissionCount: 0,
      isChargeRefundable: false,
      openedAt: new Date(dispute.created * 1000),
      transactions: [
        expect.objectContaining({
          id: withdrawn!.id,
          amount: '-10.00',
          fee: expect.stringMatching(/^\d+\.\d{2}$/),
        }),
      ],
    });
  });

  // a draft staged is evidence on the dispute, a submission is not: only a person submits
  it('takes a draft of the evidence without submitting it, with charge.dispute.updated', async () => {
    const { dispute } = await disputeOfCard(1000);

    const answer = await putStripeDisputeEvidence(dispute.id, {
      productDescription: 'Order #1: Desk lamp x 1',
      shippingCarrier: 'Nova Poshta',
      shippingTrackingNumber: '20450000000000',
    });

    expect(answer).toEqual({ status: 'put' });
    const after = await disputeOf(dispute.id);
    expect(after).toMatchObject({
      status: 'needs_response',
      evidence: {
        product_description: 'Order #1: Desk lamp x 1',
        shipping_carrier: 'Nova Poshta',
        shipping_tracking_number: '20450000000000',
        uncategorized_text: null,
      },
      evidence_details: { has_evidence: true, submission_count: 0 },
    });
    expect((await stripeEvent('charge.dispute.updated', dispute.id)).data.object).toMatchObject({
      id: dispute.id,
      evidence_details: { has_evidence: true, submission_count: 0 },
    });
  });

  // the sandbox decides by the test evidence about 20 s after it is submitted
  it(
    'is won by the winning evidence: the sum comes back, and the payment can be refunded again',
    async () => {
      const { paymentId, dispute } = await disputeOfCard(1000);

      await closeDispute(paymentId, 'won');

      const won = await disputeOf(dispute.id);
      expect(won).toMatchObject({
        status: 'won',
        evidence_details: { submission_count: 1 },
      });
      expect(won.balance_transactions).toEqual([
        expect.objectContaining({ amount: -1000, reporting_category: 'dispute' }),
        expect.objectContaining({ amount: 1000, reporting_category: 'dispute_reversal' }),
      ]);
      expect((await stripeEvent('charge.dispute.closed', dispute.id)).data.object).toMatchObject({
        id: dispute.id,
        status: 'won',
      });
      expect(
        (await stripeEvent('charge.dispute.funds_reinstated', dispute.id)).data.object,
      ).toMatchObject({ id: dispute.id, status: 'won' });
      expect(
        await refundStripePayment({
          orderId: 2_000_000_001,
          paymentIntentId: paymentId,
          amount: '10.00',
          key: `refund:${paymentId}`,
        }),
      ).toMatchObject({ status: 'succeeded' });
    },
    stripeWait,
  );

  it(
    'is lost by the losing evidence: the sum stays with the buyer, the payment stays charged back',
    async () => {
      const { paymentId, dispute } = await disputeOfCard(1000);

      await closeDispute(paymentId, 'lost');

      const lost = await disputeOf(dispute.id);
      expect(lost).toMatchObject({ status: 'lost', is_charge_refundable: false });
      expect(lost.balance_transactions).toHaveLength(1);
      expect((await stripeEvent('charge.dispute.closed', dispute.id)).data.object).toMatchObject({
        id: dispute.id,
        status: 'lost',
      });
      expect(
        await refundStripePayment({
          orderId: 2_000_000_001,
          paymentIntentId: paymentId,
          amount: '10.00',
          key: `refund:${paymentId}`,
        }),
      ).toMatchObject({ status: 'failed', failure: 'disputed' });
    },
    stripeWait,
  );

  it('is not found by an id Stripe does not know', async () => {
    const id = `du_${randomText(24)}`;

    expect(await refusalOf(stripe.disputes.retrieve(id))).toEqual(
      refused({
        statusCode: 404,
        code: 'resource_missing',
        param: 'dispute',
        message: `No such dispute: '${id}'`,
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
