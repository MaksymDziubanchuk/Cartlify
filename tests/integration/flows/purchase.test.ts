import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { closeSessions, createProduct, createUser } from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { placeOrder } from '../../helpers/orders.js';
import { openPaymentPage, orderStateOf, payPage } from '../../helpers/payments.js';
import { closeOpenSessions, deliver } from '../../helpers/stripe.js';

// a purchase from the cart to the review, through the routes of orders, payments, products,
// reviews and admin, with Stripe (its mock, or the test sandbox with service:stripe): the reserve takes the free units of the catalog,
// the payment sells them from the batch, the admin ships and delivers with a mail each, the buyer
// reviews a product bought, the report of the accountant and the journal of the stock count the
// sale at the cost of its batch
let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

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

const freeUnitsOf = async (productId: number) =>
  (await app.inject({ method: 'GET', url: `/api/products/${productId}` })).json().stock as number;

describe('a purchase from the cart to the review', () => {
  it('reserves, takes the payment, ships, delivers, gets a review and counts the sale', async () => {
    // 3 units in a batch of a cost of 1 a unit (the factory)
    const product = await createProduct({ price: 12.5, stock: 3 });
    const buyer = await createUser();
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(buyer.id, admin.id);
    const mails = watchMail();
    const paidFrom = new Date(Date.now() - 1000).toISOString();

    // the cart and its confirmation hold 2 of the 3 units for the buyer
    const orderId = await placeOrder(app, csrf, buyer, product, 'waiting', 2);
    expect(await freeUnitsOf(product.id)).toBe(1);

    // the buyer pays the page with a test card, Stripe sends its event to the webhook
    const sessionId = await openPaymentPage(app, csrf, buyer, orderId);
    const { paymentId, event } = await payPage(sessionId);
    expect((await deliver(app, event)).statusCode).toBe(200);
    expect(await orderStateOf(orderId)).toMatchObject({ status: 'paid', paymentId });
    expect(await freeUnitsOf(product.id)).toBe(1);

    const order = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(buyer) },
    });
    expect(order.json()).toMatchObject({ id: orderId, status: 'paid', total: 25 });

    // the admin ships and delivers it, the buyer gets a mail of each step
    for (const status of ['shipped', 'delivered'] as const) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/orders/${orderId}/status`,
        headers: withCsrf(csrf, accessCookie(admin)),
        payload: { status },
      });
      expect(res.statusCode).toBe(200);
    }
    expect(
      mails.filter((mail) => mail.to.includes(buyer.email)).map((mail) => mail.subject),
    ).toEqual([
      expect.stringContaining(`Order #${orderId} is paid`),
      expect.stringContaining(`Order #${orderId} is shipped`),
      expect.stringContaining(`Order #${orderId} is delivered`),
    ]);

    // the review of a product the buyer bought says so
    const review = await app.inject({
      method: 'POST',
      url: `/api/products/${product.id}/reviews`,
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: { rating: 5, comment: 'Bright and warm.' },
    });
    expect(review.statusCode).toBe(201);
    expect(review.json()).toMatchObject({ rating: 5, verifiedPurchase: true });
    const card = await app.inject({ method: 'GET', url: `/api/products/${product.id}` });
    expect(card.json()).toMatchObject({ avgRating: 5, reviewsCount: 1 });

    // the accountant sees the sale at the cost of its batch, the journal of the stock the units
    const report = await app.inject({
      method: 'GET',
      url: `/api/admin/reports/accounting?productIds=${product.id}&from=${encodeURIComponent(paidFrom)}`,
      headers: { cookie: accessCookie(admin) },
    });
    expect(report.statusCode).toBe(200);
    expect(report.json().sales).toEqual({ orders: 1, units: 2, revenue: 25, cost: 2, margin: 23 });

    const movements = await app.inject({
      method: 'GET',
      url: `/api/admin/stock/movements?productId=${product.id}&kind=sale`,
      headers: { cookie: accessCookie(admin) },
    });
    expect(movements.json().items).toEqual([
      expect.objectContaining({ kind: 'sale', quantity: -2, orderId }),
    ]);
  });
});
