import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { resetDelivery, setDelivery } from '../../../helpers/delivery.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { deliveryAnswer, deliveryBody, placeOrder } from '../../../helpers/orders.js';

// the cart shows what each method of the shop would cost for what is in it, how far it is from a
// free delivery, and offers the delivery of the last order of the buyer to start from

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const newUser = async () => {
  const user = await createUser();
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(resetDelivery);

afterAll(async () => {
  try {
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

const cartOf = (user: TestUser) =>
  app.inject({
    method: 'GET',
    url: '/api/orders/current',
    headers: { cookie: accessCookie(user) },
  });

describe('GET /api/orders/current: the delivery of a cart', () => {
  it('has no delivery yet and quotes each method of the shop for the items in it', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99, DELIVERY_FREE_FROM: 30 });
    const buyer = await newUser();
    await addToCart(buyer, (await createProduct({ price: 10, stock: 5 })).id, 2);

    const res = await cartOf(buyer);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'pending',
      itemsTotal: 20,
      total: 20,
      delivery: null,
      deliveryQuotes: [
        { method: 'manual', price: 4.99, freeFrom: 30, remainingToFree: 10 },
        { method: 'pickup', price: 0, freeFrom: null, remainingToFree: null },
      ],
    });
    expect(res.json()).not.toHaveProperty('deliverySuggestion');
  });

  it('quotes a free delivery once the items reach the sum, and shows it again when they fall under', async () => {
    setDelivery({ DELIVERY_FLAT_PRICE: 4.99, DELIVERY_FREE_FROM: 30 });
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 10 });
    const added = await addToCart(buyer, product.id, 3);

    expect(added.json().deliveryQuotes[0]).toEqual({
      method: 'manual',
      price: 0,
      freeFrom: 30,
      remainingToFree: 0,
    });

    const itemId = added.json().items[0].id;
    const lowered = await app.inject({
      method: 'PATCH',
      url: `/api/orders/current/items/${itemId}`,
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: { quantity: 2 },
    });

    expect(lowered.json().deliveryQuotes[0]).toMatchObject({ price: 4.99, remainingToFree: 10 });
  });

  it('quotes only the methods the shop has enabled, and no price when the shop names none', async () => {
    setDelivery({ DELIVERY_METHODS: ['pickup'] });
    const buyer = await newUser();
    await addToCart(buyer, (await createProduct({ price: 10, stock: 5 })).id, 1);

    const res = await cartOf(buyer);

    expect(res.json().deliveryQuotes).toEqual([
      { method: 'pickup', price: 0, freeFrom: null, remainingToFree: null },
    ]);
  });

  it('offers the delivery of the last order of the buyer, without the note', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 10 });
    await placeOrder(app, csrf, buyer, product, 'paid', 1, {
      ...deliveryBody,
      address: { ...deliveryBody.address, apartment: '12' },
      note: 'Leave near the door.',
    });
    await addToCart(buyer, product.id, 1);

    const res = await cartOf(buyer);

    expect(res.json().deliverySuggestion).toEqual({
      method: 'manual',
      recipient: deliveryAnswer.recipient,
      address: { ...deliveryAnswer.address, apartment: '12' },
    });
    expect(res.json().delivery).toBeNull();
  });

  it('offers the latest of many, and a pickup with no address', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 10 });
    await placeOrder(app, csrf, buyer, product, 'paid');
    const { address: _address, ...person } = deliveryBody;
    await placeOrder(app, csrf, buyer, product, 'paid', 1, { ...person, method: 'pickup' });
    await addToCart(buyer, product.id, 1);

    const res = await cartOf(buyer);

    expect(res.json().deliverySuggestion).toEqual({
      method: 'pickup',
      recipient: deliveryAnswer.recipient,
      address: null,
    });
  });

  it('offers the delivery of an order that was never paid too: the buyer wrote it', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 10 });
    await placeOrder(app, csrf, buyer, product, 'waiting');
    await addToCart(buyer, product.id, 1);

    const res = await cartOf(buyer);

    expect(res.json().deliverySuggestion).toMatchObject({ method: 'manual' });
  });

  it('is the cart of the buyer only: another buyer is offered nothing', async () => {
    const buyer = await newUser();
    const product = await createProduct({ price: 10, stock: 10 });
    await placeOrder(app, csrf, buyer, product, 'paid');
    const other = await newUser();
    await addToCart(other, product.id, 1);

    const res = await cartOf(other);

    expect(res.json()).not.toHaveProperty('deliverySuggestion');
  });
});
