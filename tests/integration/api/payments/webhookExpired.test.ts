import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { PAYMENT_WEBHOOK_GRACE_MS } from '@routes/api/orders/services/helpers/index.js';

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
import { loseReservation, placeOrder } from '../../../helpers/orders.js';
import {
  deleteOrderAsOwner,
  moveClock,
  openPaymentPage,
  orderStateOf,
  redisStateOf,
} from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  craftEvent,
  deliver,
  expireSession,
  readSession,
  stripeEvent,
} from '../../../helpers/stripe.js';

// POST /api/payments/stripe/webhook with checkout.session.expired and async_payment_failed: the payment
// page is closed (the order timeout worker closes it when the reservation ends), the test delivers
// the event Stripe recorded. A payment made at the last moment can still be on its way, so the
// reservation goes only after the grace window; the clock of the app is moved past it

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

// the reservation of a confirmation and the grace window after it are over
const PAST_THE_GRACE_WINDOW_MS = 15 * 60_000 + PAYMENT_WEBHOOK_GRACE_MS + 5_000;

// a buyer whose order of 2 waits for its payment on a page the app opened
async function orderWithPage() {
  const user = await createUser();
  userIds.push(user.id);
  const product = await createProduct({ price: 25.5, stock: 5 });
  products.push(product);
  const orderId = await placeOrder(app, csrf, user, product, 'waiting', 2);
  const sessionId = await openPaymentPage(app, csrf, user, orderId);
  return { user, product, orderId, sessionId };
}

// the page is closed at Stripe; the event Stripe recorded for it
async function closePage(sessionId: string) {
  await expireSession(sessionId);
  return stripeEvent('checkout.session.expired', sessionId);
}

// the payment of another page of the order came first, the way the webhook records one
const payByAnotherPage = (orderId: number) =>
  asAdmin(async (tx) => {
    const { total } = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { total: true },
    });
    await tx.$queryRaw`
      select cartlify.pay_order(${orderId}::int, 'stripe'::cartlify."PaymentProvider", ${`pi_test_other_${orderId}`}, ${total}::numeric)
    `;
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('POST /api/payments/stripe/webhook: checkout.session.expired', () => {
  it('keeps the reservation within the grace window, a payment may still be on its way', async () => {
    const { product, orderId, sessionId } = await orderWithPage();
    const event = await closePage(sessionId);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'waiting',
      confirmed: true,
      reservationExpiresAt: expect.any(Date),
    });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 2 });
    expect((await redisStateOf(orderId)).graceTimer).not.toBeNull();
  });

  it('releases the reservation once the grace window is over', async () => {
    const { product, orderId, sessionId } = await orderWithPage();
    const event = await closePage(sessionId);
    moveClock(PAST_THE_GRACE_WINDOW_MS);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'unconfirmed',
      confirmed: false,
      reservationExpiresAt: null,
    });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
    const redis = await redisStateOf(orderId);
    expect(redis.reservationTimer).toBeNull();
    expect(redis.graceTimer).toBeNull();
  });

  // the page is closed and the order released: nothing is left to close, the link would stay for good
  it('forgets the page link of the order it releases', async () => {
    const { orderId, sessionId } = await orderWithPage();
    const event = await closePage(sessionId);
    moveClock(PAST_THE_GRACE_WINDOW_MS);

    await deliver(app, event);

    expect((await redisStateOf(orderId)).pageLink).toBeNull();
  });

  it('leaves an order paid by another page alone', async () => {
    const { product, orderId, sessionId } = await orderWithPage();
    await payByAnotherPage(orderId);
    const event = await closePage(sessionId);
    moveClock(PAST_THE_GRACE_WINDOW_MS);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'paid',
      paymentProvider: 'stripe',
      paymentId: `pi_test_other_${orderId}`,
    });
    expect(await stockOf(product.id)).toEqual({ stock: 3, reservedStock: 0 });
  });

  it('leaves an order that lost its reservation already as it is', async () => {
    const { product, orderId, sessionId } = await orderWithPage();
    await loseReservation(orderId);
    const event = await closePage(sessionId);
    moveClock(PAST_THE_GRACE_WINDOW_MS);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(await orderStateOf(orderId)).toMatchObject({ status: 'unconfirmed', confirmed: false });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
  });

  // an error answer would make Stripe deliver the event again for days
  it('acknowledges the closed page of an order that is gone', async () => {
    const { user, orderId, sessionId } = await orderWithPage();
    await loseReservation(orderId);
    await deleteOrderAsOwner(user, orderId);
    const event = await closePage(sessionId);

    const res = await deliver(app, event);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, skipped: 'ORDER_NOT_FOUND' });
  });
});

describe('POST /api/payments/stripe/webhook: checkout.session.async_payment_failed', () => {
  // a failed bank payment is final, no money comes after it: the stock goes back at once.
  // The shop pays only by card, the event is the page itself
  it('releases the reservation at once', async () => {
    const { product, orderId, sessionId } = await orderWithPage();

    const res = await deliver(
      app,
      craftEvent('checkout.session.async_payment_failed', await readSession(sessionId)),
    );

    expect(res.statusCode).toBe(200);
    expect(await orderStateOf(orderId)).toMatchObject({
      status: 'unconfirmed',
      confirmed: false,
      reservationExpiresAt: null,
    });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
    expect((await redisStateOf(orderId)).graceTimer).toBeNull();
  });
});
