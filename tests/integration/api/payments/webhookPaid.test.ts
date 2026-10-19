import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from '@jest/globals';

import { closeRedis, connectRedis } from '@redis/client.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  stockOf,
  type TestProduct,
} from '../../../helpers/factories.js';
import { allowLogs, takeLogs } from '../../../helpers/logs.js';
import { loseReservation, placeOrder } from '../../../helpers/orders.js';
import { openPaymentPage, orderStateOf, payPage, redisStateOf } from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  craftEvent,
  deliver,
  describeWithStripe,
  readSession,
} from '../../../helpers/stripe.js';

// POST /api/payments/webhook with checkout.session.completed: the buyer paid the page with a test
// card at Stripe, the test delivers the event Stripe recorded for it. The order becomes paid with
// that payment and its reserved stock is sold. Payments the order cannot take are in
// webhookRefund.test.ts

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

// a buyer whose order of 2 waits for its payment on a page the app opened
async function orderWithPage(opts: { stock?: number } = {}) {
  const user = await createUser();
  userIds.push(user.id);
  const product = await createProduct({ price: 25.5, stock: opts.stock ?? 5 });
  products.push(product);
  const orderId = await placeOrder(app, csrf, user, product, 'waiting', 2);
  const sessionId = await openPaymentPage(app, csrf, user, orderId);
  return { user, product, orderId, sessionId };
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);

  // the test environment has no SendGrid key: every paid order logs that its mail was not sent;
  // 'mails the buyer once' checks the line
  allowLogs({ msg: 'order paid mail was not sent', reason: 'SENDGRID_API_KEY_REQUIRED' });
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describeWithStripe('POST /api/payments/webhook: checkout.session.completed', () => {
  it('marks the order paid with the payment of its page and sells the reserved stock', async () => {
    const { product, orderId, sessionId } = await orderWithPage();
    const { paymentId, event } = await payPage(sessionId);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'paid',
      confirmed: true,
      paymentIntentId: paymentId,
      reservationExpiresAt: null,
    });
    expect(await stockOf(product.id)).toEqual({ stock: 3, reservedStock: 0 });
  });

  // nothing waits for a paid order: the reservation timers would only touch a paid order and the
  // page link would stay in redis for good
  it('removes the reservation timers and the page link of the paid order', async () => {
    const { orderId, sessionId } = await orderWithPage();
    const { event } = await payPage(sessionId);

    await deliver(app, event);

    expect(await redisStateOf(orderId)).toEqual({
      pageLink: null,
      reservationTimer: null,
      graceTimer: null,
    });
  });

  it('mails the buyer once, also when Stripe delivers the event again', async () => {
    const { orderId, sessionId } = await orderWithPage();
    const { event } = await payPage(sessionId);

    await deliver(app, event);
    await deliver(app, event);

    // the mail is tried and fails without a SendGrid key; the order stays paid
    const tried = takeLogs({ msg: 'order paid mail was not sent' });
    expect(tried).toHaveLength(1);
    expect(tried[0]).toMatchObject({ orderId });
  });

  it('changes nothing when Stripe delivers the event again', async () => {
    const { product, orderId, sessionId } = await orderWithPage();
    const { paymentId, event } = await payPage(sessionId);
    await deliver(app, event);

    const again = await deliver(app, event);

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ received: true });
    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'paid',
      paymentIntentId: paymentId,
    });
    expect(await stockOf(product.id)).toEqual({ stock: 3, reservedStock: 0 });
  });

  // a bank payment ends this way; the shop pays only by card, the event is the paid page itself
  it('marks the order paid on checkout.session.async_payment_succeeded too', async () => {
    const { orderId, sessionId } = await orderWithPage();
    const { paymentId } = await payPage(sessionId);

    const res = await deliver(
      app,
      craftEvent('checkout.session.async_payment_succeeded', await readSession(sessionId)),
    );

    expect(res.statusCode).toBe(200);
    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'paid',
      paymentIntentId: paymentId,
    });
  });

  // a bank payment completes the page before the money comes, the order waits for it
  it('leaves the order waiting for a completed page that is not paid yet', async () => {
    const { product, orderId, sessionId } = await orderWithPage();

    const res = await deliver(
      app,
      craftEvent('checkout.session.completed', {
        ...(await readSession(sessionId)),
        status: 'complete',
        payment_status: 'unpaid',
      }),
    );

    expect(res.statusCode).toBe(200);
    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'waiting',
      confirmed: true,
      paymentIntentId: null,
    });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 2 });
  });

  // the reservation timer was faster than the payment: the stock is still there, so it is sold
  it('takes a late payment of an order that lost its reservation while the stock is there', async () => {
    const { product, orderId, sessionId } = await orderWithPage();
    await loseReservation(orderId);
    const { paymentId, event } = await payPage(sessionId);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'paid',
      confirmed: true,
      paymentIntentId: paymentId,
    });
    expect(await stockOf(product.id)).toEqual({ stock: 3, reservedStock: 0 });
  });

  // the payment is in the database before redis is asked: a redis outage must not lose it
  it('records the payment while Redis is down', async () => {
    const { orderId, sessionId } = await orderWithPage();
    const { paymentId, event } = await payPage(sessionId);
    await closeRedis();

    try {
      const res = await deliver(app, event);

      expect(res.statusCode).toBe(200);
      expect(await orderStateOf(orderId)).toMatchObject({
        status: 'paid',
        paymentIntentId: paymentId,
      });
    } finally {
      await connectRedis(app.log);
    }
  });
});
