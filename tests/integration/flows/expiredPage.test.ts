import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

import {
  PAYMENT_WEBHOOK_GRACE_MS,
  processClaimedOrderReservationBase,
  scheduleOrderReservationExpiry,
} from '@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createProduct, createUser, stockOf } from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { placeOrder } from '../../helpers/orders.js';
import { moveClock, openPaymentPage, orderStateOf, payPage } from '../../helpers/payments.js';
import {
  closeOpenSessions,
  deliver,
  expireSession,
  payCheckoutSession,
  stripeEvent,
} from '../../helpers/stripe.js';

// a payment page that runs out, through the routes of orders and payments with Stripe (its mock,
// or the test sandbox with service:stripe): the page closes, its event comes after the grace window and gives the reserved units
// back to the catalog; the buyer confirms the same order again, without the shipping a second
// time, pays a new page and the order is paid
let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

// the reservation of a confirmation and the grace window after it are over
const PAST_THE_GRACE_WINDOW_MS = 15 * 60_000 + PAYMENT_WEBHOOK_GRACE_MS + 5_000;

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

describe('a payment page that runs out', () => {
  it('gives the units back, and the same order is confirmed and paid again', async () => {
    const product = await createProduct({ price: 20, stock: 4 });
    const buyer = await createUser();
    userIds.push(buyer.id);
    const orderId = await placeOrder(app, csrf, buyer, product, 'waiting', 3);
    const firstPage = await openPaymentPage(app, csrf, buyer, orderId);
    expect(await stockOf(product.id)).toEqual({ stock: 4, reservedStock: 3 });

    // the page closes at Stripe; its event, past the grace window, ends the reservation
    await expireSession(firstPage);
    const expired = await stripeEvent('checkout.session.expired', firstPage);
    const clock = moveClock(PAST_THE_GRACE_WINDOW_MS);
    try {
      expect((await deliver(app, expired)).statusCode).toBe(200);
    } finally {
      clock.restore();
    }
    expect(await orderStateOf(orderId)).toMatchObject({ status: 'unconfirmed', confirmed: false });
    expect(await stockOf(product.id)).toEqual({ stock: 4, reservedStock: 0 });

    // the buyer confirms the same order: the shipping of the first confirmation stays
    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/orders/current/confirm',
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: { orderId, expectedDeliveryPrice: 0 },
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ id: orderId, status: 'waiting' });

    // a new page, paid this time
    const secondPage = await openPaymentPage(app, csrf, buyer, orderId);
    expect(secondPage).not.toBe(firstPage);
    const { paymentId, event } = await payPage(secondPage);
    expect((await deliver(app, event)).statusCode).toBe(200);

    expect(await orderStateOf(orderId)).toMatchObject({ status: 'paid', paymentId });
    expect(await stockOf(product.id)).toEqual({ stock: 1, reservedStock: 0 });
  });
});

// the money of a page is taken and its event never came: at the end of the reservation the timer
// (the base job of orderTimeoutQueue.helper.ts, the one of this order made due first and taken
// alone, as in worker/orderTimeout.test.ts) reads the page at Stripe and takes the step the event
// takes. The buyer has the paid order and the one mail, the admins the payment in the money journal;
// the event that comes late changes nothing
describe('a payment page paid while its event never came', () => {
  it('is made paid by the reservation timer, and the event that comes late changes nothing', async () => {
    const product = await createProduct({ price: 20, stock: 4 });
    const buyer = await createUser();
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(buyer.id, admin.id);
    const mails = watchMail();
    const orderId = await placeOrder(app, csrf, buyer, product, 'waiting', 3);
    const sessionId = await openPaymentPage(app, csrf, buyer, orderId);

    // the buyer pays on the page; the event of Stripe does not reach the shop
    await payCheckoutSession(sessionId);
    const waiting = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(buyer) },
    });
    expect(waiting.json()).toMatchObject({ id: orderId, status: 'waiting' });

    // the reservation is over: the timer finds the page paid and the order takes the payment
    await scheduleOrderReservationExpiry(orderId, new Date(1));
    const log = {
      info: jest.fn<(obj: unknown, msg?: string) => void>(),
      warn: jest.fn<(obj: unknown, msg?: string) => void>(),
      error: jest.fn<(obj: unknown, msg?: string) => void>(),
    };
    expect(await processClaimedOrderReservationBase(log, 1)).toBe(1);
    expect(log.error).not.toHaveBeenCalled();

    // the buyer has the paid order and one mail of it
    const paid = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(buyer) },
    });
    expect(paid.json()).toMatchObject({ id: orderId, status: 'paid', total: 60 });
    const paidMails = () =>
      mails.filter(
        (mail) =>
          mail.to.includes(buyer.email) && mail.subject.includes(`Order #${orderId} is paid`),
      );
    expect(paidMails()).toHaveLength(1);
    expect(await stockOf(product.id)).toEqual({ stock: 1, reservedStock: 0 });

    // the admins see the payment in the money journal, the work of the system, the whole total
    const moneyOf = async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/admin/money-log?orderId=${orderId}&sortOrder=asc&limit=100`,
        headers: { cookie: accessCookie(admin) },
      });
      expect(res.statusCode).toBe(200);
      return res.json().items as Array<{
        id: number;
        event: string;
        purpose: string;
        part: string;
        amount: number;
        paymentId: string | null;
        actorRole: string | null;
      }>;
    };
    const lines = await moneyOf();
    expect(lines.map((line) => line.event)).toEqual(lines.map(() => 'money.payment'));
    expect(lines[0]).toMatchObject({ purpose: 'order', part: 'goods', actorRole: null });
    expect(lines.reduce((sum, line) => sum + line.amount, 0)).toBe(60);
    const paymentId = lines[0]!.paymentId;
    expect(paymentId).toMatch(/^pi_/);

    // the event of the page comes after all: the same payment, nothing changes
    const late = await deliver(app, await stripeEvent('checkout.session.completed', sessionId));
    expect(late.statusCode).toBe(200);
    expect(late.json()).toEqual({ received: true });
    expect(paidMails()).toHaveLength(1);
    expect((await moneyOf()).map((line) => line.id)).toEqual(lines.map((line) => line.id));
    expect(await orderStateOf(orderId)).toMatchObject({ status: 'paid', paymentId });
  });
});
