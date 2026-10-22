import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from '@jest/globals';

import { closeRedis, connectRedis } from '@redis/client.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  stockOf,
  type TestProduct,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { loseReservation, placeOrder } from '../../../helpers/orders.js';
import {
  openPaymentPage,
  orderStateOf,
  payPage,
  redisStateOf,
  refundAuditOf,
} from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  craftEvent,
  deliver,
  describeWithStripe,
  readSession,
  refundsOf,
} from '../../../helpers/stripe.js';

// POST /api/payments/stripe/webhook with checkout.session.completed: the buyer paid the page with a test
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

// an admin moves the paid order on, past the routes: shipped and delivered by its status, a cancel
// the way POST /cancel takes it, without the refund (only the webhook is checked here)
const moveOrderTo = (orderId: number, stage: 'shipped' | 'delivered' | 'cancelled') =>
  asAdmin(async (tx) => {
    if (stage === 'cancelled') {
      await tx.$executeRaw`select cartlify.cancel_paid_order(${orderId}::int)`;
    } else {
      await tx.order.update({ where: { id: orderId }, data: { status: stage } });
    }
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describeWithStripe('POST /api/payments/stripe/webhook: checkout.session.completed', () => {
  it('marks the order paid with the payment of its page and sells the reserved stock', async () => {
    const { product, orderId, sessionId } = await orderWithPage();
    const { paymentId, event } = await payPage(sessionId);
    const delivered = Date.now();

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    const state = await orderStateOf(orderId);
    expect(state).toMatchObject({
      status: 'paid',
      confirmed: true,
      paymentProvider: 'stripe',
      paymentId,
      reservationExpiresAt: null,
    });
    // the time the payment is recorded; the clock of the database may run a little apart
    expect(state!.paidAt!.getTime()).toBeGreaterThan(delivered - 5_000);
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
    const mails = watchMail();

    await deliver(app, event);
    await deliver(app, event);

    expect(mails.map((mail) => mail.subject)).toEqual([`Cartlify — Order #${orderId} is paid`]);
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
      paymentProvider: 'stripe',
      paymentId,
    });
    expect(await stockOf(product.id)).toEqual({ stock: 3, reservedStock: 0 });
  });

  // stripe delivers an event again when an answer was lost, days later as well: an order shipped,
  // delivered or cancelled meanwhile keeps the payment it was paid with, nothing is refunded
  it.each(['shipped', 'delivered', 'cancelled'] as const)(
    'keeps the money of an order %s when Stripe delivers the event again',
    async (stage) => {
      const { orderId, sessionId } = await orderWithPage();
      const { paymentId, event } = await payPage(sessionId);
      expect((await deliver(app, event)).statusCode).toBe(200);
      await moveOrderTo(orderId, stage);

      const again = await deliver(app, event);

      expect(again.statusCode).toBe(200);
      expect(again.json()).toEqual({ received: true });
      expect(await refundsOf(paymentId)).toEqual([]);
      expect(await refundAuditOf(orderId)).toEqual([]);
      expect(await orderStateOf(orderId)).toMatchObject({
        status: stage,
        paymentProvider: 'stripe',
        paymentId,
      });
    },
  );

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
      paymentProvider: 'stripe',
      paymentId,
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
      paymentProvider: null,
      paymentId: null,
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
      paymentProvider: 'stripe',
      paymentId,
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
        paymentProvider: 'stripe',
        paymentId,
      });
    } finally {
      await connectRedis(app.log);
    }
  });
});
