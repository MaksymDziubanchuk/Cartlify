import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
} from '../../helpers/factories.js';
import { watchMail } from '../../helpers/mail.js';
import { placeOrder, placeOrderOf } from '../../helpers/orders.js';
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

// the free units of a variant, read as the card of its product shows them
const freeUnitsOf = async (productId: number, variantId?: number) =>
  (
    await app.inject({
      method: 'GET',
      url: `/api/products/${productId}${variantId === undefined ? '' : `?variantId=${variantId}`}`,
    })
  ).json().variant.stock as number;

describe('a purchase from the cart to the review', () => {
  it('reserves, takes the payment, ships, delivers, gets a review and counts the sale', async () => {
    // 3 units in a batch of a cost of 1 a unit (the factory)
    const product = await createProduct({ price: 12.5, stock: 3 });
    const buyer = await createUser();
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(buyer.id, admin.id);
    const mails = watchMail();
    // the database dates the payment by its own clock, so the period starts by that clock too:
    // the clock of the test can be ahead of it by seconds
    const [{ now }] = await asAdmin(
      (tx) => tx.$queryRaw<[{ now: Date }]>`select clock_timestamp() at time zone 'utc' as now`,
    );
    const paidFrom = now.toISOString();

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
    expect(card.json().product).toMatchObject({ avgRating: 5, reviewsCount: 1 });

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

  // two variants of one product in one order: each is reserved, sold and counted from its own
  // units, the buyer pays one total, the mail of the delivery asks for one rating of the product
  it('sells two variants of one product from their own units and asks one rating', async () => {
    const black = await createProduct({ price: 10, stock: 4, name: 'Desk lamp' });
    const white = await createVariant(black.id, { price: 12, stock: 3 });
    const buyer = await createUser();
    const admin = await createUser({ role: 'ADMIN' });
    userIds.push(buyer.id, admin.id);
    const mails = watchMail();

    const orderId = await placeOrderOf(
      app,
      csrf,
      buyer,
      [
        { item: black, quantity: 2 },
        { item: { variantId: white.id }, quantity: 1 },
      ],
      'waiting',
    );
    expect(await freeUnitsOf(black.id, black.variantId)).toBe(2);
    expect(await freeUnitsOf(black.id, white.id)).toBe(2);

    const { event } = await payPage(await openPaymentPage(app, csrf, buyer, orderId));
    expect((await deliver(app, event)).statusCode).toBe(200);
    expect(await orderStateOf(orderId)).toMatchObject({ status: 'paid' });
    expect(await freeUnitsOf(black.id, black.variantId)).toBe(2);
    expect(await freeUnitsOf(black.id, white.id)).toBe(2);

    for (const status of ['shipped', 'delivered'] as const) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/orders/${orderId}/status`,
        headers: withCsrf(csrf, accessCookie(admin)),
        payload: { status },
      });
      expect(res.statusCode).toBe(200);
    }

    const delivered = mails.find((mail) => mail.subject.includes('is delivered'))!;
    expect(delivered.text).toContain('Desk lamp x 2 = ');
    expect(delivered.text).toContain('Desk lamp x 1 = ');
    // a review is of the product: one line to rate, not one for each variant
    expect(delivered.text.split('- Desk lamp: ')).toHaveLength(2);
  });
});
