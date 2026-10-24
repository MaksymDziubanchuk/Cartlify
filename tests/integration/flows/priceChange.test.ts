import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../helpers/factories.js';
import { shippingData } from '../../helpers/orders.js';

// a price that changes between the cart and its confirmation, through the routes of products and
// orders: the confirmation does not take an old price, the cart read again shows the new one and
// the confirmation takes it; a sale put on meanwhile lowers the total the same way
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const asBuyer = (buyer: TestUser) => withCsrf(csrf, accessCookie(buyer));

async function cartOf(buyer: TestUser, productId: number, quantity: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/orders/current/items',
    headers: asBuyer(buyer),
    payload: { productId, quantity },
  });
  expect(res.statusCode).toBe(200);
  return res.json() as { id: number; total: number };
}

const confirm = (buyer: TestUser, orderId: number) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: asBuyer(buyer),
    payload: { orderId, ...shippingData },
  });

const readCart = (buyer: TestUser) =>
  app.inject({
    method: 'GET',
    url: '/api/orders/current',
    headers: { cookie: accessCookie(buyer) },
  });

describe('a price that changes before the confirmation', () => {
  it('refuses the old price, and confirms the new one once the cart is read again', async () => {
    const product = await createProduct({ price: 10, stock: 5 });
    const buyer = await createUser();
    userIds.push(buyer.id);
    const cart = await cartOf(buyer, product.id, 2);
    expect(cart.total).toBe(20);

    const raised = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { price: 12 },
    });
    expect(raised.statusCode).toBe(200);

    const stale = await confirm(buyer, cart.id);
    expect({ status: stale.statusCode, code: stale.json().errorCode }).toEqual({
      status: 409,
      code: 'ORDER_PRICES_CHANGED',
    });

    expect((await readCart(buyer)).json()).toMatchObject({ id: cart.id, total: 24 });
    const confirmed = await confirm(buyer, cart.id);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ id: cart.id, status: 'waiting', total: 24 });
  });

  it('takes the price of a sale put on before the confirmation', async () => {
    const product = await createProduct({ price: 40, stock: 5 });
    const buyer = await createUser();
    userIds.push(buyer.id);
    const cart = await cartOf(buyer, product.id, 1);

    const sale = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}/sale`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: {
        sale: { percent: 25, endsAt: new Date(Date.now() + 86_400_000).toISOString() },
      },
    });
    expect(sale.statusCode).toBe(200);

    expect((await readCart(buyer)).json()).toMatchObject({ total: 30 });
    const confirmed = await confirm(buyer, cart.id);
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toMatchObject({ total: 30 });
  });
});
