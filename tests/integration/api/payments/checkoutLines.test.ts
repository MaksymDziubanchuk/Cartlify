import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { resetDelivery, setDelivery } from '../../../helpers/delivery.js';
import { deliveryBody, quotedDeliveryPrice, shippingData } from '../../../helpers/orders.js';
import { openPaymentPage } from '../../../helpers/payments.js';
import {
  closeOpenSessions,
  lineItemsOf,
  payCheckoutSession,
  readSession,
  stripeOfTests,
} from '../../../helpers/stripe.js';

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

afterEach(resetDelivery);

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

describe('the delivery on the payment page of an order', () => {
  // a confirmed order of two mugs at 10, 20 in all, with the delivery as sent
  async function confirmedOrder(delivery: Record<string, unknown> = deliveryBody) {
    const buyer = await createUser();
    userIds.push(buyer.id);
    const mug = await createProduct({ price: 10, stock: 5, name: 'Mug' });
    const cart = (await addToCart(buyer, mug.id, 2)).json();
    const orderId = cart.id as number;
    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/orders/current/confirm',
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: {
        orderId,
        delivery,
        expectedDeliveryPrice: quotedDeliveryPrice(cart, String(delivery.method)),
      },
    });
    expect(confirmed.statusCode).toBe(200);
    return { buyer, orderId };
  }

  it('has a line for the delivery that costs something, and the lines are the total', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99 });
    const { buyer, orderId } = await confirmedOrder();

    const sessionId = await openPaymentPage(app, csrf, buyer, orderId);

    expect(await lineItemsOf(sessionId)).toEqual([
      { description: 'Mug', quantity: 2, unitAmount: 1000, amountTotal: 2000 },
      { description: 'Delivery', quantity: 1, unitAmount: 499, amountTotal: 499 },
    ]);
    expect((await readSession(sessionId)).amount_total).toBe(2499);
  });

  it('has no line for a delivery that is free', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99, DELIVERY_FREE_FROM: 20 });
    const { buyer, orderId } = await confirmedOrder();

    const sessionId = await openPaymentPage(app, csrf, buyer, orderId);

    expect((await lineItemsOf(sessionId)).map((line) => line.description)).toEqual(['Mug']);
    expect((await readSession(sessionId)).amount_total).toBe(2000);
  });

  it('is the delivery alone for an order of free items', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 1 });
    const buyer = await createUser();
    userIds.push(buyer.id);
    const gift = await createProduct({ price: 0, stock: 5, name: 'Gift' });
    const cart = (await addToCart(buyer, gift.id, 1)).json();
    const orderId = cart.id as number;
    await app.inject({
      method: 'POST',
      url: '/api/orders/current/confirm',
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: {
        orderId,
        delivery: deliveryBody,
        expectedDeliveryPrice: quotedDeliveryPrice(cart),
      },
    });

    const sessionId = await openPaymentPage(app, csrf, buyer, orderId);

    expect(await lineItemsOf(sessionId)).toEqual([
      { description: 'Gift', quantity: 1, unitAmount: 0, amountTotal: 0 },
      { description: 'Delivery', quantity: 1, unitAmount: 100, amountTotal: 100 },
    ]);
    expect((await readSession(sessionId)).amount_total).toBe(100);
  });

  it('gives the payment where the order goes and to whom', async () => {
    const { buyer, orderId } = await confirmedOrder({
      ...deliveryBody,
      address: { ...deliveryBody.address, apartment: '12' },
    });

    const paymentId = await payCheckoutSession(await openPaymentPage(app, csrf, buyer, orderId));

    const payment = await stripeOfTests.paymentIntents.retrieve(paymentId);
    expect(payment.shipping).toMatchObject({
      name: 'Anna Koval',
      phone: '+380501234567',
      address: {
        line1: 'Test street 1',
        line2: '12',
        city: 'Kyiv',
        postal_code: '01001',
        country: 'UA',
      },
    });
  });

  it('gives the payment no place to send a pickup to', async () => {
    const { address: _address, ...person } = deliveryBody;
    const { buyer, orderId } = await confirmedOrder({ ...person, method: 'pickup' });

    const paymentId = await payCheckoutSession(await openPaymentPage(app, csrf, buyer, orderId));

    expect((await stripeOfTests.paymentIntents.retrieve(paymentId)).shipping).toBeNull();
  });
});
