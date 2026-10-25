import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { shippingData } from '../../../helpers/orders.js';
import { openPaymentPage } from '../../../helpers/payments.js';
import { closeOpenSessions, lineItemsOf, readSession } from '../../../helpers/stripe.js';

// the payment page shows what is bought: a line for each item with its name, its units and its
// price, the lines together are the total of the order; the page knows the email of the buyer.
// The name of the shop on the payment is checked by the unit tests of the payload

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

const addToCart = (user: TestUser, productId: number, quantity: number) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/items',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { productId, quantity },
  });

describe('the payment page of an order', () => {
  it('has a line for each item and the email of the buyer', async () => {
    const buyer = await createUser();
    userIds.push(buyer.id);
    const lamp = await createProduct({ price: 12.5, stock: 5, name: 'Desk lamp' });
    const mug = await createProduct({ price: 3.1, stock: 5, name: 'Mug' });
    await addToCart(buyer, lamp.id, 2);
    const orderId = (await addToCart(buyer, mug.id, 3)).json().id as number;
    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/orders/current/confirm',
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: { orderId, ...shippingData },
    });
    expect(confirmed.statusCode).toBe(200);

    const sessionId = await openPaymentPage(app, csrf, buyer, orderId);

    expect(await lineItemsOf(sessionId)).toEqual([
      { description: 'Desk lamp', quantity: 2, unitAmount: 1250, amountTotal: 2500 },
      { description: 'Mug', quantity: 3, unitAmount: 310, amountTotal: 930 },
    ]);
    const session = await readSession(sessionId);
    expect(session.amount_total).toBe(3430);
    expect(session.customer_email).toBe(buyer.email);
  });
});
