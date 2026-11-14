import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
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
import { warnOfFraud } from '../../../helpers/orders.js';
import { placePaidOrder } from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  craftEvent,
  deliver,
  payByCard,
  paymentReviewOf,
} from '../../../helpers/stripe.js';

// POST /api/payments/stripe/webhook with a review of a payment Stripe holds for the shop to look at
// (review.opened, review.closed; only a rule of Radar the owner turns on makes them, so only the mock gives one).
// An open review holds an order not sent; the buyer is told once that the payment is checked and the
// order says so (paymentCheck); the review closed lets the order go (money refunded in the review is
// a refund made by hand, api/payments/handRefunds.test.ts). The function of the database is
// db/orderHolds.test.ts

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
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

async function review(
  type: 'review.opened' | 'review.closed',
  paymentId: string,
  opts: Parameters<typeof paymentReviewOf>[1] = {},
) {
  const object = await paymentReviewOf(paymentId, opts);
  const event = craftEvent(type, object);
  const res = await deliver(app, event);
  expect(res.statusCode).toBe(200);
  return { review: object, event, res };
}

const holdsOf = async (orderId: number) =>
  (
    await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { holds: true } }),
    )
  ).holds as { reason: string; ref: unknown }[];

const paymentCheckOf = async (buyer: TestUser, orderId: number) => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/orders/${orderId}`,
    headers: { cookie: accessCookie(buyer) },
  });
  expect(res.statusCode).toBe(200);
  return res.json().paymentCheck as boolean;
};

const checkMailsTo = (mails: SentMail[], email: string) =>
  mails.filter(
    (mail) =>
      mail.to.includes(email) && mail.subject.includes('We are checking the payment for order #'),
  );

describe('a review of the payment of an order not sent', () => {
  it('holds the order and tells the buyer once that the payment is checked', async () => {
    const order = await paidOrder();
    const mails = watchMail();

    const { review: opened, res } = await review('review.opened', order.paymentId);
    await review('review.opened', order.paymentId, { id: opened.id });

    expect(res.json()).toEqual({ received: true });
    expect(await holdsOf(order.orderId)).toEqual([
      { reason: 'payment_review', since: expect.any(String), ref: opened.id },
    ]);
    expect(checkMailsTo(mails, order.buyer.email)).toHaveLength(1);
    expect(await paymentCheckOf(order.buyer, order.orderId)).toBe(true);
  });

  it('lets the order go when Stripe closes it, without a mail', async () => {
    const order = await paidOrder();
    const { review: opened } = await review('review.opened', order.paymentId);
    const mails = watchMail();

    await review('review.closed', order.paymentId, { id: opened.id, closedReason: 'approved' });

    expect(await holdsOf(order.orderId)).toEqual([]);
    expect(mails.filter((mail) => mail.to.includes(order.buyer.email))).toEqual([]);
    expect(await paymentCheckOf(order.buyer, order.orderId)).toBe(false);
  });

  // a warning of fraud held the order before: the buyer was told already, the check goes on
  it('mails nothing more, and the order stays checked after the review, while a warning holds it', async () => {
    const order = await paidOrder();
    await warnOfFraud(order.orderId);
    const mails = watchMail();

    const { review: opened } = await review('review.opened', order.paymentId);
    await review('review.closed', order.paymentId, { id: opened.id, closedReason: 'approved' });

    expect(checkMailsTo(mails, order.buyer.email)).toEqual([]);
    expect((await holdsOf(order.orderId)).map((hold) => hold.reason)).toEqual(['fraud_warning']);
    expect(await paymentCheckOf(order.buyer, order.orderId)).toBe(true);
  });
});

describe('a review of the payment of an order sent', () => {
  it('holds nothing and mails nothing', async () => {
    const order = await paidOrder('shipped');
    const mails = watchMail();

    await review('review.opened', order.paymentId);

    expect(await holdsOf(order.orderId)).toEqual([]);
    expect(checkMailsTo(mails, order.buyer.email)).toEqual([]);
  });
});

describe('a review of a payment that is none of the shop', () => {
  it('is acknowledged and named in the log', async () => {
    const paymentId = await payByCard(1000);

    const { event, res } = await review('review.opened', paymentId);

    expect(res.json()).toEqual({ received: true, skipped: 'NOT_AN_ORDER' });
    expect(takeLogs({ msg: 'stripe event was skipped', skipped: 'NOT_AN_ORDER' })).toEqual([
      expect.objectContaining({ eventId: event.id, paymentId }),
    ]);
  });
});
