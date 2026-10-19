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
  deleteProductFromCatalog,
  setProductPrice,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { loseReservation, placeOrder, shippingData } from '../../../helpers/orders.js';

// the shipping data of an order: the address and the recipient come with the confirmation and
// stay on the order as they were confirmed; every order answer shows them, never the payment id

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

const newProduct = async () => {
  const product = await createProduct({ price: 10, stock: 5 });
  products.push(product);
  return product;
};

// a user with a cart of one item
const newCart = async () => {
  const user = await newUser();
  const orderId = await placeOrder(app, csrf, user, await newProduct(), 'cart');
  return { user, orderId };
};

const confirm = (user: TestUser, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(user)),
    payload,
  });

const orderOf = (id: number) => asAdmin((tx) => tx.order.findUniqueOrThrow({ where: { id } }));

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

describe('POST /api/orders/current/confirm', () => {
  it('confirms with the address and the recipient and answers with them', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, { orderId, ...shippingData, note: 'Leave near the door.' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: orderId,
      status: 'waiting',
      confirmed: true,
      ...shippingData,
      note: 'Leave near the door.',
      reservationExpiresAt: expect.any(String),
    });
    expect(new Date(res.json().reservationExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(await orderOf(orderId)).toMatchObject({ ...shippingData, note: 'Leave near the door.' });
  });

  it('stores the address, the names and the note without the spaces around them', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      shippingAddress: '  Main st 1, Kyiv ',
      recipientFirstName: ' Anna ',
      recipientLastName: ' Koval ',
      recipientPhone: '+380501234567',
      note: '  Call first. ',
    });

    expect(res.statusCode).toBe(200);
    expect(await orderOf(orderId)).toMatchObject({
      shippingAddress: 'Main st 1, Kyiv',
      recipientFirstName: 'Anna',
      recipientLastName: 'Koval',
      note: 'Call first.',
    });
  });

  it('takes names of any script, with hyphens and apostrophes', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      ...shippingData,
      recipientFirstName: 'Ελένη',
      recipientLastName: "O'Brien-Smith",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      recipientFirstName: 'Ελένη',
      recipientLastName: "O'Brien-Smith",
    });
  });

  it.each([
    ['shippingAddress', 'SHIPPING_ADDRESS_REQUIRED'],
    ['recipientFirstName', 'RECIPIENT_FIRST_NAME_REQUIRED'],
    ['recipientLastName', 'RECIPIENT_LAST_NAME_REQUIRED'],
    ['recipientPhone', 'RECIPIENT_PHONE_REQUIRED'],
  ] as const)('refuses an order without %s and keeps it a cart', async (field, errorCode) => {
    const { user, orderId } = await newCart();
    const rest = Object.fromEntries(Object.entries(shippingData).filter(([key]) => key !== field));

    const res = await confirm(user, { orderId, ...rest });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect(await orderOf(orderId)).toMatchObject({
      confirmed: false,
      status: 'pending',
      shippingAddress: null,
      recipientFirstName: null,
      recipientLastName: null,
      recipientPhone: null,
    });
  });

  it.each([
    ['recipientFirstName', 'a digit', 'Anna2', 'RECIPIENT_FIRST_NAME_INVALID'],
    ['recipientFirstName', 'only spaces', '   ', 'RECIPIENT_FIRST_NAME_INVALID'],
    ['recipientLastName', 'no letter', '---', 'RECIPIENT_LAST_NAME_INVALID'],
    ['shippingAddress', 'only spaces', '   ', 'SHIPPING_ADDRESS_INVALID'],
  ])('refuses a %s with %s and keeps the order a cart', async (field, _case, value, errorCode) => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, { orderId, ...shippingData, [field]: value });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect(await orderOf(orderId)).toMatchObject({ confirmed: false, recipientPhone: null });
  });

  // the profile phone takes the same single form
  it.each([
    ['a phone without the plus sign', { recipientPhone: '0501234567' }],
    ['a phone with spaces', { recipientPhone: '+38 050 123 45 67' }],
    ['a first name of 101 characters', { recipientFirstName: 'x'.repeat(101) }],
    ['a last name of 101 characters', { recipientLastName: 'x'.repeat(101) }],
    ['a note of 501 characters', { note: 'x'.repeat(501) }],
  ])('refuses %s by the request schema', async (_case, patch) => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, { orderId, ...shippingData, ...patch });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect((await orderOf(orderId)).confirmed).toBe(false);
  });

  it('takes 100 characters in a name', async () => {
    const { user, orderId } = await newCart();

    const res = await confirm(user, {
      orderId,
      ...shippingData,
      recipientLastName: 'x'.repeat(100),
    });

    expect(res.statusCode).toBe(200);
  });

  it('confirms an order that lost its reservation again with only its id', async () => {
    const { user, orderId } = await newCart();
    expect(
      (await confirm(user, { orderId, ...shippingData, note: 'Call first.' })).statusCode,
    ).toBe(200);
    await loseReservation(orderId);

    const res = await confirm(user, { orderId });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'waiting', ...shippingData, note: 'Call first.' });
  });

  it('replaces what is sent again and removes the note with an empty one', async () => {
    const { user, orderId } = await newCart();
    await confirm(user, { orderId, ...shippingData, note: 'Call first.' });
    await loseReservation(orderId);

    const res = await confirm(user, { orderId, recipientPhone: '+12025550123', note: '' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('note');
    expect(await orderOf(orderId)).toMatchObject({
      recipientFirstName: shippingData.recipientFirstName,
      recipientPhone: '+12025550123',
      note: null,
    });
  });

  it('keeps the shipping data of a confirmed order as it was confirmed', async () => {
    const { user, orderId } = await newCart();
    await confirm(user, { orderId, ...shippingData });

    const res = await confirm(user, { orderId, recipientPhone: '+12025550123' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ALREADY_CONFIRMED' });
    expect((await orderOf(orderId)).recipientPhone).toBe(shippingData.recipientPhone);
  });
});

describe('POST /api/orders/current/confirm, the order itself', () => {
  const addItem = (user: TestUser, productId: number, quantity: number) =>
    app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { productId, quantity },
    });

  it('holds the stock of the items for the payment and the cart is gone', async () => {
    const user = await newUser();
    const product = await createProduct({ stock: 5 });
    products.push(product);
    const added = await addItem(user, product.id, 2);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(200);
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 2 });
    const cart = await app.inject({
      method: 'GET',
      url: '/api/orders/current',
      headers: { cookie: accessCookie(user) },
    });
    expect(cart.statusCode).toBe(404);
  });

  it('refuses an order without items', async () => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, product.id, 1);
    await app.inject({
      method: 'DELETE',
      url: `/api/orders/current/items/${added.json().items[0].id}`,
      headers: withCsrf(csrf, accessCookie(user)),
    });

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ITEMS_REQUIRED' });
  });

  // Stripe takes no smaller payment: the order is refused before its stock is held, the page tells
  // the buyer the smallest total, before the payment page is asked for
  it.each([
    ['a total below the smallest payment', 0.3],
    ['a free order', 0],
  ])('refuses %s and holds no stock', async (_case, price) => {
    const user = await newUser();
    const product = await createProduct({ price, stock: 5 });
    products.push(product);
    const added = await addItem(user, product.id, 1);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_TOTAL_BELOW_MINIMUM',
      details: { minimum: 0.5, currency: 'eur' },
    });
    expect(await orderOf(added.json().id)).toMatchObject({
      status: 'pending',
      confirmed: false,
      reservationExpiresAt: null,
      shippingAddress: null,
    });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 0 });
  });

  it.each([
    ['the smallest payment', 0.5, 1],
    ['a total over it of cheap items', 0.3, 2],
  ])('confirms %s', async (_case, price, quantity) => {
    const user = await newUser();
    const product = await createProduct({ price, stock: 5 });
    products.push(product);
    const added = await addItem(user, product.id, quantity);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'waiting', total: price * quantity });
  });

  // the confirmation takes the prices of the catalog: a price that fell below the smallest payment
  // after the cart was read is refused for it, a reload would show the same
  it('counts the prices of the catalog, not the ones the cart was read at', async () => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, product.id, 1);
    await setProductPrice(product.id, 0.3);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_TOTAL_BELOW_MINIMUM' });
  });

  it('names an item whose product was deleted from the catalog and keeps the cart', async () => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, product.id, 1);
    await deleteProductFromCatalog(product.id);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_ITEMS_UNAVAILABLE',
      details: {
        items: [
          {
            itemId: added.json().items[0].id,
            productId: product.id,
            reason: 'deleted',
            available: 0,
            requested: 1,
          },
        ],
      },
    });
    expect(await orderOf(added.json().id)).toMatchObject({ status: 'pending', confirmed: false });
  });

  it('names an item there is not enough free stock of', async () => {
    const user = await newUser();
    const product = await createProduct({ stock: 5 });
    products.push(product);
    const added = await addItem(user, product.id, 2);
    // another buyer confirms first and holds 4 of the 5
    await placeOrder(app, csrf, await newUser(), product, 'waiting', 4);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_ITEMS_UNAVAILABLE',
      details: {
        items: [{ productId: product.id, reason: 'out_of_stock', available: 1, requested: 2 }],
      },
    });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 4 });
  });

  it('names every item it cannot take and only those', async () => {
    const user = await newUser();
    const fine = await newProduct();
    const gone = await newProduct();
    const scarce = await createProduct({ stock: 2 });
    products.push(scarce);
    await addItem(user, fine.id, 1);
    await addItem(user, gone.id, 1);
    const added = await addItem(user, scarce.id, 2);
    await deleteProductFromCatalog(gone.id);
    await placeOrder(app, csrf, await newUser(), scarce, 'waiting', 1);

    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(409);
    const items = res.json().details.items as { productId: number; reason: string }[];
    expect(items.map(({ productId, reason }) => ({ productId, reason }))).toEqual([
      { productId: gone.id, reason: 'deleted' },
      { productId: scarce.id, reason: 'out_of_stock' },
    ]);
  });

  it('refuses a price that changed after the cart was read, then confirms the new one', async () => {
    const user = await newUser();
    const product = await newProduct();
    const added = await addItem(user, product.id, 2);
    await setProductPrice(product.id, 8);

    const refused = await confirm(user, { orderId: added.json().id, ...shippingData });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ errorCode: 'ORDER_PRICES_CHANGED' });

    // the page reloads the cart: it gets the new prices
    await app.inject({
      method: 'GET',
      url: '/api/orders/current',
      headers: { cookie: accessCookie(user) },
    });
    const res = await confirm(user, { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 16 });
  });

  it('does not confirm the cart of another user', async () => {
    const owner = await newUser();
    const added = await addItem(owner, (await newProduct()).id, 1);

    const res = await confirm(await newUser(), { orderId: added.json().id, ...shippingData });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
    expect((await orderOf(added.json().id)).confirmed).toBe(false);
  });

  it('answers 404 for an order that does not exist', async () => {
    const res = await confirm(await newUser(), { orderId: 2_000_000_000, ...shippingData });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
  });

  it('refuses an order id over the largest id', async () => {
    const res = await confirm(await newUser(), { orderId: 2_147_483_648, ...shippingData });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // the database would cut 1.5 to 1 and confirm another order of the user
  it('refuses an order id of 1.5 and confirms no order', async () => {
    const user = await newUser();
    const added = await addItem(user, (await newProduct()).id, 1);

    const res = await confirm(user, { orderId: added.json().id + 0.5, ...shippingData });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect((await orderOf(added.json().id)).confirmed).toBe(false);
  });

  it('refuses an admin', async () => {
    const res = await confirm(await newUser({ role: 'ADMIN' }), { orderId: 1, ...shippingData });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('the order answers after the confirmation', () => {
  it('GET /api/orders/:orderId shows the owner the paid order with the recipient, not the payment id', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'paid');

    const res = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(user) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: orderId, status: 'paid', ...shippingData });
    // a paid order holds no stock for the payment any more
    expect(res.json()).not.toHaveProperty('reservationExpiresAt');
    expect(res.json()).not.toHaveProperty('paymentIntentId');
    expect((await orderOf(orderId)).paymentIntentId).toBe(`pi_test_${orderId}`);
  });

  it('GET /api/orders lists the orders with the recipient', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');

    const res = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: accessCookie(user) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        id: orderId,
        ...shippingData,
        reservationExpiresAt: expect.any(String),
      }),
    ]);
  });

  it('PATCH /api/orders/:orderId/status gives the admin who to ship the order to', async () => {
    const user = await newUser();
    const admin = await newUser({ role: 'ADMIN' });
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'paid');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/status`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { status: 'shipped' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'shipped', ...shippingData });
    expect(res.json()).not.toHaveProperty('paymentIntentId');
    // the test environment has no SendGrid key, the shipped mail only logs its failure
    // (status.test.ts checks the mails)
    expect(takeLogs({ msg: 'order shipped mail was not sent' })).toHaveLength(1);
  });
});
