import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { PAYMENT_WEBHOOK_GRACE_MS } from '@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createProduct, createUser, stockOf } from '../../helpers/factories.js';
import { placeOrder } from '../../helpers/orders.js';
import { moveClock, openPaymentPage, orderStateOf, payPage } from '../../helpers/payments.js';
import { closeOpenSessions, deliver, expireSession, stripeEvent } from '../../helpers/stripe.js';

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
      payload: { orderId },
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
