import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  orderRowOf,
  placeOrder,
  placeUnconfirmedOrder,
  shippingData,
} from '../../../helpers/orders.js';

// PATCH /api/orders/:orderId/status: an admin moves a paid order along its delivery, paid to
// shipped to delivered. A cancel returns money and stock, it is a route of its own

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const newProduct = async () => {
  const product = await createProduct({ price: 10, stock: 5 });
  products.push(product);
  return product;
};

const setStatus = (actor: TestUser, orderId: number | string, status: string) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/status`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: { status },
  });

const markDelivered = (orderId: number) =>
  asAdmin((tx) => tx.order.update({ where: { id: orderId }, data: { status: 'delivered' } }));

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('PATCH /api/orders/:orderId/status', () => {
  it('ships a paid order and answers with who to ship it to', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: orderId, status: 'shipped', ...shippingData });
    expect(res.json()).not.toHaveProperty('paymentIntentId');
    expect((await orderRowOf(orderId)).status).toBe('shipped');
  });

  it('marks a shipped order delivered', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'shipped');

    const res = await setStatus(admin, orderId, 'delivered');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'delivered' });
  });

  it('lets root move an order as well', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');

    const res = await setStatus(await newUser({ role: 'ROOT' }), orderId, 'shipped');

    expect(res.statusCode).toBe(200);
  });

  it('refuses a cancel here and keeps the order paid', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');

    const res = await setStatus(admin, orderId, 'cancelled');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect((await orderRowOf(orderId)).status).toBe('paid');
  });

  it.each(['pending', 'waiting', 'unconfirmed', 'paid'])(
    'refuses the status %s, an admin does not set it',
    async (status) => {
      const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');

      const res = await setStatus(admin, orderId, status);

      expect(res.statusCode).toBe(400);
      expect((await orderRowOf(orderId)).status).toBe('paid');
    },
  );

  // the order is there, its state does not allow the step: the answer must not say "not found"
  it.each([
    ['an order waiting for its payment', 'waiting'],
    ['an unconfirmed order', 'unconfirmed'],
    ['the cart', 'cart'],
  ] as const)('refuses to ship %s as a conflict', async (_case, stage) => {
    const user = await newUser();
    const orderId =
      stage === 'unconfirmed'
        ? await placeUnconfirmedOrder(app, csrf, user, await newProduct())
        : await placeOrder(app, csrf, user, await newProduct(), stage);
    const before = (await orderRowOf(orderId)).status;

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
      details: { status: before, requested: 'shipped' },
    });
    expect((await orderRowOf(orderId)).status).toBe(before);
  });

  it('refuses to move a delivered order back', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'shipped');
    await markDelivered(orderId);

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
      details: { status: 'delivered', requested: 'shipped' },
    });
    expect((await orderRowOf(orderId)).status).toBe('delivered');
  });

  it('refuses to ship an order shipped already', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'shipped');

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
      details: { status: 'shipped', requested: 'shipped' },
    });
  });

  it('answers 404 for an order that does not exist', async () => {
    const res = await setStatus(admin, 2_000_000_000, 'shipped');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
  });

  it('refuses a user, also the owner of the order', async () => {
    const owner = await newUser();
    const orderId = await placeOrder(app, csrf, owner, await newProduct(), 'paid');

    const res = await setStatus(owner, orderId, 'shipped');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect((await orderRowOf(orderId)).status).toBe('paid');
  });
});
