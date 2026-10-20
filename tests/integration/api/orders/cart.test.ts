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
import { orderRowOf, placeOrder, placeUnconfirmedOrder } from '../../../helpers/orders.js';

// the cart: the one order of a user that is still being filled (pending). Its items are added,
// changed and removed through /api/orders/current; prices always come from the catalog

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

const getCart = (user: TestUser) =>
  app.inject({
    method: 'GET',
    url: '/api/orders/current',
    headers: { cookie: accessCookie(user) },
  });

const addItem = (user: TestUser, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/items',
    headers: withCsrf(csrf, accessCookie(user)),
    payload,
  });

const changeItem = (user: TestUser, itemId: number | string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/current/items/${itemId}`,
    headers: withCsrf(csrf, accessCookie(user)),
    payload,
  });

const removeItem = (user: TestUser, itemId: number | string) =>
  app.inject({
    method: 'DELETE',
    url: `/api/orders/current/items/${itemId}`,
    headers: withCsrf(csrf, accessCookie(user)),
  });

type OrderItem = { id: number; productId: number; quantity: number; totalPrice: number };

const itemOf = (body: { items: OrderItem[] }, productId: number) => {
  const item = body.items.find((it) => it.productId === productId);
  if (!item) throw new Error(`the order has no item of product ${productId}`);
  return item;
};

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

describe('GET /api/orders/current', () => {
  it('answers 404 when the user has no cart', async () => {
    const user = await newUser();

    const res = await getCart(user);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CURRENT_ORDER_NOT_FOUND' });
  });

  it('gives the cart with its items, prices and free stock', async () => {
    const user = await newUser();
    const product = await newProduct({ price: 12.5, stock: 5 });
    await addItem(user, { productId: product.id, quantity: 2 });

    const res = await getCart(user);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      userId: user.id,
      status: 'pending',
      confirmed: false,
      total: 25,
      items: [
        {
          productId: product.id,
          quantity: 2,
          unitPrice: 12.5,
          totalPrice: 25,
          product: { id: product.id, availableStock: 5 },
        },
      ],
    });
    expect(res.json()).not.toHaveProperty('reservationExpiresAt');
  });

  it('brings the prices of the cart to the prices of the catalog', async () => {
    const user = await newUser();
    const product = await newProduct({ price: 10 });
    await addItem(user, { productId: product.id, quantity: 3 });
    await setProductPrice(product.id, 7);

    const res = await getCart(user);

    expect(res.json()).toMatchObject({ total: 21, items: [{ unitPrice: 7, totalPrice: 21 }] });
  });

  // a product removed from the catalog can never be bought: the cart loses it for good, the way
  // an unconfirmed order does, and shows only what can be confirmed
  it('drops the items of products deleted from the catalog for good', async () => {
    const user = await newUser();
    const gone = await newProduct({ price: 10 });
    const kept = await newProduct({ price: 4 });
    await addItem(user, { productId: gone.id, quantity: 1 });
    const added = await addItem(user, { productId: kept.id, quantity: 2 });
    await deleteProductFromCatalog(gone.id);

    const res = await getCart(user);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 8, items: [{ productId: kept.id, quantity: 2 }] });
    expect(res.json().items).toHaveLength(1);
    expect((await orderRowOf(added.json().id)).items.map((item) => item.productId)).toEqual([
      kept.id,
    ]);
  });

  it('keeps an empty cart when its only product was deleted from the catalog', async () => {
    const user = await newUser();
    const gone = await newProduct();
    await addItem(user, { productId: gone.id, quantity: 1 });
    await deleteProductFromCatalog(gone.id);

    const res = await getCart(user);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'pending', total: 0, items: [] });
  });

  it('leaves the cart of another user to its own reads', async () => {
    const reader = await newUser();
    const other = await newUser();
    const gone = await newProduct();
    await addItem(reader, { productId: gone.id, quantity: 1 });
    const theirs = await addItem(other, { productId: gone.id, quantity: 1 });
    await deleteProductFromCatalog(gone.id);

    await getCart(reader);

    expect((await orderRowOf(theirs.json().id)).items).toHaveLength(1);
  });

  // the payment page names such an item (409 ORDER_ITEMS_UNAVAILABLE), the buyer decides
  it('leaves an order waiting for its payment as it is', async () => {
    const user = await newUser();
    const gone = await newProduct();
    const waitingId = await placeOrder(app, csrf, user, gone, 'waiting');
    await addItem(user, { productId: (await newProduct()).id, quantity: 1 });
    await deleteProductFromCatalog(gone.id);

    await getCart(user);

    expect((await orderRowOf(waitingId)).items).toHaveLength(1);
  });

  // an order that lost its reservation is no longer filled, it is changed by its own id
  it('does not take an unconfirmed order for the cart', async () => {
    const user = await newUser();
    await placeUnconfirmedOrder(app, csrf, user, await newProduct());

    const res = await getCart(user);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CURRENT_ORDER_NOT_FOUND' });
  });

  it.each(['ADMIN', 'ROOT'] as const)('refuses a %s: only a user has a cart', async (role) => {
    const res = await getCart(await newUser({ role }));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('POST /api/orders/current/items', () => {
  it('starts the cart with the first item', async () => {
    const user = await newUser();
    const product = await newProduct({ price: 10 });

    const res = await addItem(user, { productId: product.id, quantity: 2 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'pending',
      total: 20,
      items: [{ productId: product.id, quantity: 2, unitPrice: 10, totalPrice: 20 }],
    });
  });

  it('adds the quantity to the item the cart already has for the product', async () => {
    const user = await newUser();
    const product = await newProduct();
    await addItem(user, { productId: product.id, quantity: 1 });

    const res = await addItem(user, { productId: product.id, quantity: 2 });

    expect(res.json().items).toHaveLength(1);
    expect(itemOf(res.json(), product.id).quantity).toBe(3);
  });

  it('keeps one cart for the items of several products', async () => {
    const user = await newUser();
    const lamp = await newProduct({ price: 10 });
    const mug = await newProduct({ price: 4 });
    const first = await addItem(user, { productId: lamp.id, quantity: 1 });

    const res = await addItem(user, { productId: mug.id, quantity: 2 });

    expect(res.json().id).toBe(first.json().id);
    expect(res.json()).toMatchObject({ total: 18 });
    expect(res.json().items).toHaveLength(2);
  });

  it('answers with the cart without the items of products deleted from the catalog', async () => {
    const user = await newUser();
    const gone = await newProduct({ price: 10 });
    const kept = await newProduct({ price: 4 });
    const first = await addItem(user, { productId: gone.id, quantity: 1 });
    await deleteProductFromCatalog(gone.id);

    const res = await addItem(user, { productId: kept.id, quantity: 2 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 8, items: [{ productId: kept.id }] });
    expect(res.json().items).toHaveLength(1);
    expect((await orderRowOf(first.json().id)).items).toHaveLength(1);
  });

  it('refuses a product deleted from the catalog', async () => {
    const user = await newUser();
    const product = await newProduct();
    await deleteProductFromCatalog(product.id);

    const res = await addItem(user, { productId: product.id, quantity: 1 });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('refuses a product that does not exist', async () => {
    const res = await addItem(await newUser(), { productId: 2_000_000_000, quantity: 1 });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('refuses more than the free stock and says how much is free', async () => {
    const user = await newUser();
    const product = await newProduct({ stock: 5 });

    const res = await addItem(user, { productId: product.id, quantity: 6 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'OUT_OF_STOCK',
      details: { productId: product.id, available: 5, requested: 6 },
    });
  });

  it('counts what the cart already has against the free stock', async () => {
    const user = await newUser();
    const product = await newProduct({ stock: 5 });
    await addItem(user, { productId: product.id, quantity: 3 });

    const res = await addItem(user, { productId: product.id, quantity: 3 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ details: { available: 5, requested: 6 } });
  });

  it('leaves out the stock other orders hold for their payment', async () => {
    const product = await newProduct({ stock: 5 });
    await placeOrder(app, csrf, await newUser(), product, 'waiting', 3);

    const res = await addItem(await newUser(), { productId: product.id, quantity: 3 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ details: { available: 2, requested: 3 } });
  });

  // a quantity is a whole number of units, an id fits the database
  it.each([
    ['a quantity of 0', { quantity: 0 }],
    ['a quantity of 1.5', { quantity: 1.5 }],
    ['a quantity over the largest number the database keeps', { quantity: 2_147_483_648 }],
    ['a product id over the largest id', { productId: 2_147_483_648 }],
    ['a product id of 1.5', { productId: 1.5 }],
  ])('refuses %s', async (_case, patch) => {
    const product = await newProduct();

    const res = await addItem(await newUser(), { productId: product.id, quantity: 1, ...patch });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a request without the csrf token', async () => {
    const user = await newUser();
    const product = await newProduct();

    const res = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: { cookie: accessCookie(user) },
      payload: { productId: product.id, quantity: 1 },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
  });

  it('refuses an admin', async () => {
    const product = await newProduct();

    const res = await addItem(await newUser({ role: 'ADMIN' }), {
      productId: product.id,
      quantity: 1,
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('starts a new cart and leaves an unconfirmed order alone', async () => {
    const user = await newUser();
    const unconfirmedId = await placeUnconfirmedOrder(app, csrf, user, await newProduct());
    const product = await newProduct();

    const res = await addItem(user, { productId: product.id, quantity: 1 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'pending' });
    expect(res.json().id).not.toBe(unconfirmedId);
    expect((await orderRowOf(unconfirmedId)).items).toHaveLength(1);
  });
});

describe('PATCH /api/orders/current/items/:itemId', () => {
  it('sets the quantity of the item and the total', async () => {
    const user = await newUser();
    const product = await newProduct({ price: 10 });
    const added = await addItem(user, { productId: product.id, quantity: 1 });

    const res = await changeItem(user, itemOf(added.json(), product.id).id, { quantity: 4 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 40, items: [{ quantity: 4, totalPrice: 40 }] });
  });

  it('refuses more than the free stock and keeps the quantity', async () => {
    const user = await newUser();
    const product = await newProduct({ stock: 5 });
    const added = await addItem(user, { productId: product.id, quantity: 1 });
    const itemId = itemOf(added.json(), product.id).id;

    const res = await changeItem(user, itemId, { quantity: 6 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'OUT_OF_STOCK',
      details: { available: 5, requested: 6 },
    });
    expect((await getCart(user)).json().items[0].quantity).toBe(1);
  });

  it('does not reach an item of another user', async () => {
    const owner = await newUser();
    const product = await newProduct();
    const added = await addItem(owner, { productId: product.id, quantity: 1 });

    const res = await changeItem(await newUser(), itemOf(added.json(), product.id).id, {
      quantity: 2,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ITEM_NOT_FOUND' });
  });

  it.each([
    ['an order waiting for its payment', 'waiting'],
    ['an unconfirmed order', 'unconfirmed'],
  ] as const)('does not reach an item of %s, it is not the cart', async (_case, stage) => {
    const user = await newUser();
    const orderId =
      stage === 'waiting'
        ? await placeOrder(app, csrf, user, await newProduct(), 'waiting')
        : await placeUnconfirmedOrder(app, csrf, user, await newProduct());
    const [item] = (await orderRowOf(orderId)).items;

    const res = await changeItem(user, item!.id, { quantity: 2 });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ITEM_NOT_FOUND' });
    expect((await orderRowOf(orderId)).items[0]!.quantity).toBe(1);
  });

  it('answers with the cart without the items of products deleted from the catalog', async () => {
    const user = await newUser();
    const gone = await newProduct({ price: 10 });
    const kept = await newProduct({ price: 4 });
    await addItem(user, { productId: gone.id, quantity: 1 });
    const added = await addItem(user, { productId: kept.id, quantity: 1 });
    await deleteProductFromCatalog(gone.id);

    const res = await changeItem(user, itemOf(added.json(), kept.id).id, { quantity: 3 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 12, items: [{ productId: kept.id, quantity: 3 }] });
    expect(res.json().items).toHaveLength(1);
  });

  it('refuses a change of an item whose product was deleted from the catalog', async () => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, { productId: product.id, quantity: 1 });
    await deleteProductFromCatalog(product.id);

    const res = await changeItem(user, itemOf(added.json(), product.id).id, { quantity: 2 });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it.each([
    ['a quantity of 0', { quantity: 0 }],
    ['a quantity of 1.5', { quantity: 1.5 }],
    ['a quantity over the largest number the database keeps', { quantity: 2_147_483_648 }],
  ])('refuses %s and keeps the quantity', async (_case, payload) => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, { productId: product.id, quantity: 1 });

    const res = await changeItem(user, itemOf(added.json(), product.id).id, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect((await getCart(user)).json().items[0].quantity).toBe(1);
  });

  // ids in the path are checked the same way in every route
  it('refuses an item id over the largest id', async () => {
    const res = await changeItem(await newUser(), 2_147_483_648, { quantity: 1 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'INVALID_ID_PARAM' });
  });
});

describe('DELETE /api/orders/current/items/:itemId', () => {
  it('removes the item and counts the total again', async () => {
    const user = await newUser();
    const lamp = await newProduct({ price: 10 });
    const mug = await newProduct({ price: 4 });
    await addItem(user, { productId: lamp.id, quantity: 1 });
    const added = await addItem(user, { productId: mug.id, quantity: 2 });

    const res = await removeItem(user, itemOf(added.json(), mug.id).id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 10, items: [{ productId: lamp.id }] });
  });

  it('keeps an empty cart after the last item', async () => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, { productId: product.id, quantity: 1 });

    const res = await removeItem(user, itemOf(added.json(), product.id).id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'pending', total: 0, items: [] });
  });

  it('answers with the cart without the items of products deleted from the catalog', async () => {
    const user = await newUser();
    const gone = await newProduct({ price: 10 });
    const lamp = await newProduct({ price: 4 });
    const mug = await newProduct({ price: 3 });
    await addItem(user, { productId: gone.id, quantity: 1 });
    await addItem(user, { productId: lamp.id, quantity: 1 });
    const added = await addItem(user, { productId: mug.id, quantity: 1 });
    await deleteProductFromCatalog(gone.id);

    const res = await removeItem(user, itemOf(added.json(), mug.id).id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 4, items: [{ productId: lamp.id }] });
    expect(res.json().items).toHaveLength(1);
  });

  it('removes an item whose product was deleted from the catalog', async () => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, { productId: product.id, quantity: 1 });
    await deleteProductFromCatalog(product.id);

    const res = await removeItem(user, itemOf(added.json(), product.id).id);

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it('does not reach an item of another user', async () => {
    const owner = await newUser();
    const product = await newProduct();
    const added = await addItem(owner, { productId: product.id, quantity: 1 });

    const res = await removeItem(await newUser(), itemOf(added.json(), product.id).id);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ITEM_NOT_FOUND' });
    expect((await getCart(owner)).json().items).toHaveLength(1);
  });

  it('does not reach an item of an order waiting for its payment', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');
    const [item] = (await orderRowOf(orderId)).items;

    const res = await removeItem(user, item!.id);

    expect(res.statusCode).toBe(404);
    expect((await orderRowOf(orderId)).items).toHaveLength(1);
  });
});
