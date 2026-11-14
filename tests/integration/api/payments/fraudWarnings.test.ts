import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { watchMail, type SentMail } from '../../../helpers/mail.js';
import { holdForReview } from '../../../helpers/orders.js';
import { placePaidOrder } from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  craftEvent,
  deliver,
  earlyFraudWarningOf,
  payByCard,
} from '../../../helpers/stripe.js';

// POST /api/payments/stripe/webhook with an early warning of fraud of the network of the card
// (radar.early_fraud_warning.created and .updated).
// A warning Stripe still lets the shop act on (actionable) holds an order
// not sent until root decides (POST /api/orders/:orderId/holds/fraud_warning/decision, api/orders/
// holds.test.ts); the buyer is told once that the payment is checked, never of fraud (a warning can
// be wrong), and the order of the buyer says it is checked (paymentCheck). An order already sent is
// only marked for the alert of root. The function of the database is db/orderHolds.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT' });
  userIds.push(root.id);
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

async function paidOrder(stage: 'paid' | 'shipped' = 'paid') {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 1, stage });
  return { ...placed, buyer };
}

async function warn(
  paymentId: string,
  opts: Parameters<typeof earlyFraudWarningOf>[1] = {},
  type = 'radar.early_fraud_warning.created',
) {
  const warning = await earlyFraudWarningOf(paymentId, opts);
  const event = craftEvent(type, warning);
  const res = await deliver(app, event);
  expect(res.statusCode).toBe(200);
  return { warning, event, res };
}

const orderOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, holds: true, fraudWarnedAt: true },
    }),
  );

// the order as its buyer sees it
const buyerCardOf = async (buyer: TestUser, orderId: number) => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/orders/${orderId}`,
    headers: { cookie: accessCookie(buyer) },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
};

const CHECK_SUBJECT = 'We are checking the payment for order #';

const checkMailsTo = (mails: SentMail[], email: string) =>
  mails.filter((mail) => mail.to.includes(email) && mail.subject.includes(CHECK_SUBJECT));

describe('an early warning of fraud of an order not sent', () => {
  it('holds the order, tells the buyer once that the payment is checked, and the order says so', async () => {
    const order = await paidOrder();
    const mails = watchMail();

    const { warning, res } = await warn(order.paymentId);

    expect(res.json()).toEqual({ received: true });
    expect(await orderOf(order.orderId)).toMatchObject({
      status: 'paid',
      holds: [{ reason: 'fraud_warning', since: expect.any(String), ref: warning.id }],
      fraudWarnedAt: null,
    });
    const told = checkMailsTo(mails, order.buyer.email);
    expect(told).toHaveLength(1);
    expect(told[0]!.subject).toContain(`#${order.orderId}`);
    expect(`${told[0]!.subject}\n${told[0]!.text}\n${told[0]!.html}`).not.toMatch(/fraud/i);
    const card = await buyerCardOf(order.buyer, order.orderId);
    expect(card).toMatchObject({ status: 'paid', paymentCheck: true });
    expect(JSON.stringify(card)).not.toMatch(/fraud/i);
  });

  it('holds once and mails once for the warning told again and updated', async () => {
    const order = await paidOrder();
    const { warning } = await warn(order.paymentId);
    const mails = watchMail();

    await warn(order.paymentId, { id: warning.id });
    await warn(order.paymentId, { id: warning.id }, 'radar.early_fraud_warning.updated');

    expect((await orderOf(order.orderId)).holds as unknown[]).toHaveLength(1);
    expect(checkMailsTo(mails, order.buyer.email)).toEqual([]);
  });

  // the buyer was told the payment is checked when the review of Stripe held the order
  it('mails nothing more when a review holds the order already', async () => {
    const order = await paidOrder();
    await holdForReview(order.orderId);
    const mails = watchMail();

    await warn(order.paymentId);

    const holds = (await orderOf(order.orderId)).holds as { reason: string }[];
    expect(holds.map((hold) => hold.reason)).toEqual(['payment_review', 'fraud_warning']);
    expect(checkMailsTo(mails, order.buyer.email)).toEqual([]);
  });

  // the payment was refunded or disputed: Stripe no longer lets the shop act on the warning
  it('does nothing for a warning Stripe says the shop cannot act on', async () => {
    const order = await paidOrder();
    const mails = watchMail();

    await warn(order.paymentId, { actionable: false });

    expect(await orderOf(order.orderId)).toMatchObject({ holds: [], fraudWarnedAt: null });
    expect(checkMailsTo(mails, order.buyer.email)).toEqual([]);
    expect((await buyerCardOf(order.buyer, order.orderId)).paymentCheck).toBe(false);
  });

  it('is not said to the buyer once root lets the order go', async () => {
    const order = await paidOrder();
    await warn(order.paymentId);

    const decided = await app.inject({
      method: 'POST',
      url: `/api/orders/${order.orderId}/holds/fraud_warning/decision`,
      headers: withCsrf(csrf, accessCookie(root)),
      payload: { decision: 'ship', note: 'Checked with the buyer' },
    });

    expect(decided.statusCode).toBe(200);
    expect((await buyerCardOf(order.buyer, order.orderId)).paymentCheck).toBe(false);
  });
});

describe('an early warning of fraud of an order sent', () => {
  it('only marks the order for root, without a hold or a mail', async () => {
    const order = await paidOrder('shipped');
    const mails = watchMail();

    await warn(order.paymentId);

    const row = await orderOf(order.orderId);
    expect(row).toMatchObject({ status: 'shipped', holds: [] });
    expect(row.fraudWarnedAt).toEqual(expect.any(Date));
    expect(checkMailsTo(mails, order.buyer.email)).toEqual([]);
    expect((await buyerCardOf(order.buyer, order.orderId)).paymentCheck).toBe(false);
  });
});

describe('an early warning of fraud of a payment that is none of the shop', () => {
  it('is acknowledged and named in the log', async () => {
    const paymentId = await payByCard(1000);

    const { event, res } = await warn(paymentId);

    expect(res.json()).toEqual({ received: true, skipped: 'NOT_AN_ORDER' });
    expect(takeLogs({ msg: 'stripe event was skipped', skipped: 'NOT_AN_ORDER' })).toEqual([
      expect.objectContaining({ eventId: event.id, paymentId }),
    ]);
  });
});
