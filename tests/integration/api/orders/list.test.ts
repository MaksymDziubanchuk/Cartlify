import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  setProductPrice,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  loseReservation,
  placeOrder,
  placeUnconfirmedOrder,
  shippingData,
} from '../../../helpers/orders.js';

// GET /api/orders: the order history. The cart is not an order and is not listed; the newest come
// first. A paid order shows what was paid, an unconfirmed one what confirming it again would cost

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const newProduct = async (opts: { stock?: number; price?: number } = {}) => {
  const product = await createProduct({ price: 10, stock: 20, ...opts });
  products.push(product);
  return product;
};

const list = (user: TestUser, query = '') =>
  app.inject({
    method: 'GET',
    url: `/api/orders${query}`,
    headers: { cookie: accessCookie(user) },
  });

type ListedOrder = {
  id: number;
  status: string;
  total: number;
  items: { productId: number; unitPrice: number }[];
};

const idsOf = (res: { json: () => { items: ListedOrder[] } }) =>
  res.json().items.map((order) => order.id);

const listed = (res: { json: () => { items: ListedOrder[] } }, id: number) => {
  const order = res.json().items.find((it) => it.id === id);
  if (!order) throw new Error(`the list has no order ${id}`);
  return order;
};

// an order of several products that lost its reservation
async function unconfirmedOrderOf(user: TestUser, productIds: number[]): Promise<number> {
  let orderId = 0;
  for (const productId of productIds) {
    const added = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { productId, quantity: 1 },
    });
    orderId = added.json().id;
  }

  const confirmed = await app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { orderId, ...shippingData },
  });
  if (confirmed.statusCode !== 200) throw new Error(`confirm answered ${confirmed.statusCode}`);

  await loseReservation(orderId);
  return orderId;
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('GET /api/orders', () => {
  it('lists the orders of the user, the newest first, without the cart', async () => {
    const user = await newUser();
    const product = await newProduct();
    const paidId = await placeOrder(app, csrf, user, product, 'paid');
    const waitingId = await placeOrder(app, csrf, user, product, 'waiting');
    const unconfirmedId = await placeUnconfirmedOrder(app, csrf, user, product);
    const cartId = await placeOrder(app, csrf, user, product, 'cart');

    const res = await list(user);

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([unconfirmedId, waitingId, paidId]);
    expect(idsOf(res)).not.toContain(cartId);
    expect(res.json()).toMatchObject({ total: 3, limit: 20, nextCursor: null });
  });

  it('shows a user none of the orders of another user', async () => {
    const owner = await newUser();
    await placeOrder(app, csrf, owner, await newProduct(), 'paid');

    const res = await list(await newUser());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ items: [], total: 0 });
  });

  it('lets an admin see the orders of every user, without any cart', async () => {
    const product = await newProduct();
    const first = await placeOrder(app, csrf, await newUser(), product, 'waiting');
    const second = await placeOrder(app, csrf, await newUser(), product, 'paid');
    const cartId = await placeOrder(app, csrf, await newUser(), product, 'cart');

    const res = await list(await newUser({ role: 'ADMIN' }), '?limit=100');

    expect(res.statusCode).toBe(200);
    // other test files make orders at the same time, only the ones of this test are compared
    expect(idsOf(res).filter((id) => id === first || id === second)).toEqual([second, first]);
    expect(idsOf(res)).not.toContain(cartId);
    expect(res.json().items.every((order: ListedOrder) => order.status !== 'pending')).toBe(true);
  });

  it('filters by status and by confirmation', async () => {
    const user = await newUser();
    const product = await newProduct();
    const paidId = await placeOrder(app, csrf, user, product, 'paid');
    const unconfirmedId = await placeUnconfirmedOrder(app, csrf, user, product);
    await placeOrder(app, csrf, user, product, 'cart');

    expect(idsOf(await list(user, '?status=unconfirmed'))).toEqual([unconfirmedId]);
    expect(idsOf(await list(user, '?status=paid'))).toEqual([paidId]);
    // the cart is not confirmed either, it still stays out
    expect(idsOf(await list(user, '?confirmed=false'))).toEqual([unconfirmedId]);
  });

  it('refuses a filter by the cart status', async () => {
    const res = await list(await newUser(), '?status=pending');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('pages through the orders with the cursor, each order once', async () => {
    const user = await newUser();
    const product = await newProduct();
    const oldest = await placeOrder(app, csrf, user, product, 'paid');
    const middle = await placeOrder(app, csrf, user, product, 'paid');
    const newest = await placeOrder(app, csrf, user, product, 'waiting');

    const first = await list(user, '?limit=2');
    expect(idsOf(first)).toEqual([newest, middle]);
    expect(first.json().nextCursor).toEqual(expect.any(String));

    const second = await list(user, `?limit=2&cursor=${first.json().nextCursor}`);
    expect(idsOf(second)).toEqual([oldest]);
    expect(second.json().nextCursor).toBeNull();
  });

  it('sorts by the total when asked', async () => {
    const user = await newUser();
    const dear = await placeOrder(app, csrf, user, await newProduct({ price: 30 }), 'paid');
    const cheap = await placeOrder(app, csrf, user, await newProduct({ price: 5 }), 'paid');

    const res = await list(user, '?sortBy=total&sortDir=asc');

    expect(idsOf(res)).toEqual([cheap, dear]);
  });

  it('keeps the price a paid order was paid with and shows an unconfirmed one at the new price', async () => {
    const user = await newUser();
    const product = await newProduct({ price: 10 });
    const paidId = await placeOrder(app, csrf, user, product, 'paid');
    const unconfirmedId = await placeUnconfirmedOrder(app, csrf, user, product);
    await setProductPrice(product.id, 15);

    const res = await list(user);

    expect(listed(res, paidId)).toMatchObject({ total: 10, items: [{ unitPrice: 10 }] });
    expect(listed(res, unconfirmedId)).toMatchObject({ total: 15, items: [{ unitPrice: 15 }] });
  });

  it('drops the items of deleted products from an unconfirmed order, a paid one keeps them', async () => {
    const user = await newUser();
    const gone = await newProduct({ price: 10 });
    const kept = await newProduct({ price: 4 });
    const paidId = await placeOrder(app, csrf, user, gone, 'paid');
    const unconfirmedId = await unconfirmedOrderOf(user, [gone.id, kept.id]);
    await deleteProductFromCatalog(gone.id);

    const res = await list(user);

    expect(listed(res, unconfirmedId)).toMatchObject({
      total: 4,
      items: [{ productId: kept.id }],
    });
    expect(listed(res, unconfirmedId).items).toHaveLength(1);
    expect(listed(res, paidId)).toMatchObject({ total: 10, items: [{ productId: gone.id }] });
  });

  it('never gives the payment id', async () => {
    const user = await newUser();
    await placeOrder(app, csrf, user, await newProduct(), 'paid');

    const res = await list(user);

    expect(res.json().items[0]).not.toHaveProperty('paymentIntentId');
  });

  it('refuses a guest', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/orders' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});
