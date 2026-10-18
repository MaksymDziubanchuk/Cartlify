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
  orderRowOf,
  placeOrder,
  placeUnconfirmedOrder,
  shippingData,
} from '../../../helpers/orders.js';

// the items of an order that lost its reservation (unconfirmed): the owner changes them the way
// the cart items are changed, by the id of the order, and confirms the order again. The answer
// is the order at the prices of the catalog, without products deleted from it

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
  const product = await createProduct({ price: 10, stock: 5, ...opts });
  products.push(product);
  return product;
};

const addItem = (user: TestUser, orderId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/items`,
    headers: withCsrf(csrf, accessCookie(user)),
    payload,
  });

const changeItem = (
  user: TestUser,
  orderId: number,
  itemId: number,
  payload: Record<string, unknown>,
) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/items/${itemId}`,
    headers: withCsrf(csrf, accessCookie(user)),
    payload,
  });

const removeItem = (user: TestUser, orderId: number, itemId: number) =>
  app.inject({
    method: 'DELETE',
    url: `/api/orders/${orderId}/items/${itemId}`,
    headers: withCsrf(csrf, accessCookie(user)),
  });

const confirm = (user: TestUser, orderId: number) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { orderId },
  });

const firstItemOf = async (orderId: number) => (await orderRowOf(orderId)).items[0]!;

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

describe('POST /api/orders/:orderId/items', () => {
  it('adds an item to an unconfirmed order of the user', async () => {
    const user = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, await newProduct({ price: 10 }));
    const mug = await newProduct({ price: 4 });

    const res = await addItem(user, orderId, { productId: mug.id, quantity: 2 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: orderId, status: 'unconfirmed', total: 18 });
    expect(res.json().items).toHaveLength(2);
  });

  it('adds the quantity to the item the order already has for the product', async () => {
    const user = await newUser();
    const product = await newProduct();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, product);

    const res = await addItem(user, orderId, { productId: product.id, quantity: 2 });

    expect(res.json().items).toEqual([expect.objectContaining({ quantity: 3 })]);
  });

  it('refuses more than the free stock', async () => {
    const user = await newUser();
    const product = await newProduct({ stock: 5 });
    const orderId = await placeUnconfirmedOrder(app, csrf, user, product, 2);

    const res = await addItem(user, orderId, { productId: product.id, quantity: 4 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'OUT_OF_STOCK',
      details: { available: 5, requested: 6 },
    });
  });

  // the same body as the cart: whole numbers from 1 to the largest int of the database
  it.each([
    ['a quantity of 1.5', { quantity: 1.5 }],
    ['a product id of 1.5', { quantity: 1, productIdShift: 0.5 }],
    ['a product id over the largest id', { quantity: 1, productId: 2_147_483_648 }],
  ])('refuses %s and keeps the order', async (_case, patch) => {
    const user = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, await newProduct());
    const product = await newProduct();
    const { productIdShift, ...rest } = { productIdShift: 0, ...patch };

    const res = await addItem(user, orderId, { productId: product.id + productIdShift, ...rest });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect((await orderRowOf(orderId)).items).toHaveLength(1);
  });

  it('refuses a product deleted from the catalog', async () => {
    const user = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, await newProduct());
    const gone = await newProduct();
    await deleteProductFromCatalog(gone.id);

    const res = await addItem(user, orderId, { productId: gone.id, quantity: 1 });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('answers with the order at current prices and without products deleted from the catalog', async () => {
    const user = await newUser();
    const gone = await newProduct({ price: 10 });
    const orderId = await placeUnconfirmedOrder(app, csrf, user, gone);
    await deleteProductFromCatalog(gone.id);
    const mug = await newProduct({ price: 4 });
    await setProductPrice(mug.id, 6);

    const res = await addItem(user, orderId, { productId: mug.id, quantity: 1 });

    expect(res.json()).toMatchObject({ total: 6, items: [{ productId: mug.id, unitPrice: 6 }] });
    expect(res.json().items).toHaveLength(1);
  });

  it.each([
    ['the cart', 'cart'],
    ['an order waiting for its payment', 'waiting'],
    ['a paid order', 'paid'],
  ] as const)('does not reach %s', async (_case, stage) => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), stage);
    const before = (await orderRowOf(orderId)).items;

    const res = await addItem(user, orderId, { productId: (await newProduct()).id, quantity: 1 });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
    expect((await orderRowOf(orderId)).items).toHaveLength(before.length);
  });

  it('does not reach an unconfirmed order of another user', async () => {
    const orderId = await placeUnconfirmedOrder(app, csrf, await newUser(), await newProduct());

    const res = await addItem(await newUser(), orderId, {
      productId: (await newProduct()).id,
      quantity: 1,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
    expect((await orderRowOf(orderId)).items).toHaveLength(1);
  });

  it('leaves the cart of the user alone', async () => {
    const user = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, await newProduct());
    const cartId = await placeOrder(app, csrf, user, await newProduct(), 'cart');

    await addItem(user, orderId, { productId: (await newProduct()).id, quantity: 1 });

    expect((await orderRowOf(cartId)).items).toHaveLength(1);
  });

  it('refuses an admin', async () => {
    const orderId = await placeUnconfirmedOrder(app, csrf, await newUser(), await newProduct());

    const res = await addItem(await newUser({ role: 'ADMIN' }), orderId, {
      productId: (await newProduct()).id,
      quantity: 1,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('PATCH /api/orders/:orderId/items/:itemId', () => {
  it('sets the quantity of an item of an unconfirmed order', async () => {
    const user = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, await newProduct({ price: 10 }));
    const item = await firstItemOf(orderId);

    const res = await changeItem(user, orderId, item.id, { quantity: 3 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'unconfirmed',
      total: 30,
      items: [{ quantity: 3 }],
    });
  });

  it('refuses more than the free stock', async () => {
    const user = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, await newProduct({ stock: 5 }));
    const item = await firstItemOf(orderId);

    const res = await changeItem(user, orderId, item.id, { quantity: 6 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'OUT_OF_STOCK' });
    expect((await firstItemOf(orderId)).quantity).toBe(1);
  });

  it('does not reach an item of another order of the user under this order id', async () => {
    const user = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, await newProduct());
    const otherId = await placeUnconfirmedOrder(app, csrf, user, await newProduct());
    const otherItem = await firstItemOf(otherId);

    const res = await changeItem(user, orderId, otherItem.id, { quantity: 2 });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ITEM_NOT_FOUND' });
    expect((await firstItemOf(otherId)).quantity).toBe(1);
  });

  it('does not reach an item of an unconfirmed order of another user', async () => {
    const orderId = await placeUnconfirmedOrder(app, csrf, await newUser(), await newProduct());
    const item = await firstItemOf(orderId);

    const res = await changeItem(await newUser(), orderId, item.id, { quantity: 2 });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ITEM_NOT_FOUND' });
  });

  it('does not reach an item of an order waiting for its payment', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');
    const item = await firstItemOf(orderId);

    const res = await changeItem(user, orderId, item.id, { quantity: 2 });

    expect(res.statusCode).toBe(404);
    expect((await firstItemOf(orderId)).quantity).toBe(1);
  });
});

describe('DELETE /api/orders/:orderId/items/:itemId', () => {
  it('removes an item of an unconfirmed order and counts the total again', async () => {
    const user = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, await newProduct({ price: 10 }));
    const mug = await newProduct({ price: 4 });
    const added = await addItem(user, orderId, { productId: mug.id, quantity: 1 });
    const mugItem = added.json().items.find((it: { productId: number }) => it.productId === mug.id);

    const res = await removeItem(user, orderId, mugItem.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'unconfirmed', total: 10 });
    expect(res.json().items).toHaveLength(1);
  });

  it('does not reach an item of an unconfirmed order of another user', async () => {
    const orderId = await placeUnconfirmedOrder(app, csrf, await newUser(), await newProduct());
    const item = await firstItemOf(orderId);

    const res = await removeItem(await newUser(), orderId, item.id);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ITEM_NOT_FOUND' });
    expect((await orderRowOf(orderId)).items).toHaveLength(1);
  });
});

describe('confirming a changed unconfirmed order again', () => {
  it('confirms it with only its id, at the new items and total', async () => {
    const user = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, await newProduct({ price: 10 }));
    await addItem(user, orderId, { productId: (await newProduct({ price: 4 })).id, quantity: 2 });

    const res = await confirm(user, orderId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: orderId,
      status: 'waiting',
      total: 18,
      ...shippingData,
      reservationExpiresAt: expect.any(String),
    });
  });

  it('refuses it once every item is removed', async () => {
    const user = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, await newProduct());
    const item = await firstItemOf(orderId);
    await removeItem(user, orderId, item.id);

    const res = await confirm(user, orderId);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ITEMS_REQUIRED' });
  });
});
