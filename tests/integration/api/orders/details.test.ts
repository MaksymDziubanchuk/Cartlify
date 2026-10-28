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
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  loseReservation,
  orderRowOf,
  placeOrder,
  placeUnconfirmedOrder,
  deliveryAnswer,
  shippingData,
} from '../../../helpers/orders.js';

// GET /api/orders/:orderId: one order, for its owner and for an admin. An unconfirmed order is
// shown the way confirming it again would take it; a confirmed one never changes

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

const getOrder = (user: TestUser, orderId: number | string) =>
  app.inject({
    method: 'GET',
    url: `/api/orders/${orderId}`,
    headers: { cookie: accessCookie(user) },
  });

const updatedAtOf = async (user: TestUser, orderId: number) =>
  Date.parse((await getOrder(user, orderId)).json().updatedAt);

// an order of several products that lost its reservation
async function unconfirmedOrderOf(user: TestUser, items: [number, number][]): Promise<number> {
  let orderId = 0;
  for (const [productId, quantity] of items) {
    const added = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { productId, quantity },
    });
    orderId = added.json().id;
  }

  await app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { orderId, ...shippingData },
  });
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

describe('GET /api/orders/:orderId', () => {
  it('gives the owner an order waiting for its payment with all its data', async () => {
    const user = await newUser();
    const product = await newProduct({ price: 10 });
    const orderId = await placeOrder(app, csrf, user, product, 'waiting', 2);

    const res = await getOrder(user, orderId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: orderId,
      userId: user.id,
      status: 'waiting',
      confirmed: true,
      total: 20,
      delivery: deliveryAnswer,
      reservationExpiresAt: expect.any(String),
      items: [{ productId: product.id, quantity: 2, unitPrice: 10, totalPrice: 20 }],
    });
    expect(res.json()).not.toHaveProperty('paymentId');
    expect(res.json()).not.toHaveProperty('paymentProvider');
    // not paid yet
    expect(res.json()).not.toHaveProperty('paidAt');
    expect(res.json()).not.toHaveProperty('cancelledAt');
  });

  it('gives the time of the payment of a paid order and keeps it once the order is shipped', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'paid');
    const paid = (await getOrder(user, orderId)).json();

    await asAdmin((tx) => tx.order.update({ where: { id: orderId }, data: { status: 'shipped' } }));
    const shipped = (await getOrder(user, orderId)).json();

    expect(paid.paidAt).toEqual(expect.any(String));
    expect(Date.parse(paid.paidAt)).toBeGreaterThanOrEqual(Date.parse(paid.createdAt));
    expect(paid).not.toHaveProperty('cancelledAt');
    expect(shipped).toMatchObject({ status: 'shipped', paidAt: paid.paidAt });
    expect(Date.parse(shipped.updatedAt)).toBeGreaterThan(Date.parse(shipped.paidAt));
  });

  it('gives the time of the cancel of a cancelled order next to the time of its payment', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'paid');
    const { paidAt } = (await getOrder(user, orderId)).json();

    await asAdmin((tx) => tx.$executeRaw`select cartlify.cancel_paid_order(${orderId}::int)`);
    const res = await getOrder(user, orderId);

    expect(res.json()).toMatchObject({ status: 'cancelled', paidAt });
    expect(Date.parse(res.json().cancelledAt)).toBeGreaterThan(Date.parse(paidAt));
  });

  it('hides the order of another user as not found', async () => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');

    const res = await getOrder(await newUser(), orderId);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
  });

  it.each(['ADMIN', 'ROOT'] as const)('gives a %s the order of any user', async (role) => {
    const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'paid');

    const res = await getOrder(await newUser({ role }), orderId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: orderId, status: 'paid', delivery: deliveryAnswer });
    expect(res.json()).not.toHaveProperty('paymentId');
    expect(res.json()).not.toHaveProperty('paymentProvider');
  });

  it('answers 404 for an order that does not exist', async () => {
    const res = await getOrder(await newUser(), 2_000_000_000);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
  });

  it.each(['0', '2147483648', 'abc', '1.5'])('refuses the order id %s', async (orderId) => {
    const res = await getOrder(await newUser(), orderId);

    expect(res.statusCode).toBe(400);
  });

  it('keeps the price a paid order was paid with', async () => {
    const user = await newUser();
    const product = await newProduct({ price: 10 });
    const orderId = await placeOrder(app, csrf, user, product, 'paid');
    await setProductPrice(product.id, 25);

    const res = await getOrder(user, orderId);

    expect(res.json()).toMatchObject({ total: 10, items: [{ unitPrice: 10, totalPrice: 10 }] });
  });

  it('shows an unconfirmed order at the prices of the catalog', async () => {
    const user = await newUser();
    const product = await newProduct({ price: 10 });
    const orderId = await placeUnconfirmedOrder(app, csrf, user, product, 2);
    await setProductPrice(product.id, 12);

    const res = await getOrder(user, orderId);

    expect(res.json()).toMatchObject({
      status: 'unconfirmed',
      total: 24,
      items: [{ unitPrice: 12, totalPrice: 24 }],
    });
    expect(res.json()).not.toHaveProperty('reservationExpiresAt');
  });

  it('drops the items of deleted products from an unconfirmed order for good', async () => {
    const user = await newUser();
    const gone = await newProduct({ price: 10 });
    const kept = await newProduct({ price: 4 });
    const orderId = await unconfirmedOrderOf(user, [
      [gone.id, 1],
      [kept.id, 2],
    ]);
    await deleteProductFromCatalog(gone.id);

    const res = await getOrder(user, orderId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 8, items: [{ productId: kept.id, quantity: 2 }] });
    expect(res.json().items).toHaveLength(1);
    expect((await orderRowOf(orderId)).items.map((item) => item.productId)).toEqual([kept.id]);
  });

  it('drops the items of deleted products from the cart as well', async () => {
    const user = await newUser();
    const gone = await newProduct({ price: 10 });
    const kept = await newProduct({ price: 4 });
    await placeOrder(app, csrf, user, gone, 'cart');
    const cartId = await placeOrder(app, csrf, user, kept, 'cart', 2);
    await deleteProductFromCatalog(gone.id);

    const res = await getOrder(user, cartId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'pending',
      total: 8,
      items: [{ productId: kept.id }],
    });
    expect(res.json().items).toHaveLength(1);
  });

  // the payment page names such an item (409 ORDER_ITEMS_UNAVAILABLE), the buyer decides
  it('keeps the items of deleted products in an order waiting for its payment', async () => {
    const user = await newUser();
    const gone = await newProduct();
    const orderId = await placeOrder(app, csrf, user, gone, 'waiting');
    await deleteProductFromCatalog(gone.id);

    const res = await getOrder(user, orderId);

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([expect.objectContaining({ productId: gone.id })]);
  });

  // the page marks what there is not enough of before the order is confirmed again
  it('shows the free stock of each product of an unconfirmed order', async () => {
    const user = await newUser();
    const product = await newProduct({ stock: 5 });
    const orderId = await placeUnconfirmedOrder(app, csrf, user, product, 3);
    await placeOrder(app, csrf, await newUser(), product, 'waiting', 4);

    const res = await getOrder(user, orderId);

    expect(res.json().items[0]).toMatchObject({ quantity: 3, product: { availableStock: 1 } });
  });

  it('changes nothing in an unconfirmed order when an admin reads it', async () => {
    const owner = await newUser();
    const product = await newProduct({ price: 10 });
    const orderId = await placeUnconfirmedOrder(app, csrf, owner, product);
    await setProductPrice(product.id, 30);

    const res = await getOrder(await newUser({ role: 'ADMIN' }), orderId);

    expect(res.statusCode).toBe(200);
    expect((await orderRowOf(orderId)).items[0]!.unitPrice.toNumber()).toBe(10);
  });

  // the payment and the cancel are database functions, not prisma queries: updatedAt shows the
  // time of every change of the order, not only of the changes the app makes through prisma
  it('moves updatedAt when a database function pays or cancels the order', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct({ price: 10 }), 'waiting');
    const confirmedAt = await updatedAtOf(user, orderId);

    const paid = await asAdmin(
      (tx) => tx.$queryRaw<{ result: string }[]>`
        select cartlify.pay_order(${orderId}::int, 'stripe'::cartlify."PaymentProvider", ${`pi_test_${orderId}`}, ${10}::numeric) as result
      `,
    );
    const paidAt = await updatedAtOf(user, orderId);
    await asAdmin((tx) => tx.$executeRaw`select cartlify.cancel_paid_order(${orderId}::int)`);
    const res = await getOrder(user, orderId);

    expect(paid[0]?.result).toBe('PAID');
    expect(paidAt).toBeGreaterThan(confirmedAt);
    expect(res.json().status).toBe('cancelled');
    expect(Date.parse(res.json().updatedAt)).toBeGreaterThan(paidAt);
  });

  it('moves updatedAt when the order loses its reservation', async () => {
    const user = await newUser();
    const orderId = await placeOrder(app, csrf, user, await newProduct(), 'waiting');
    const confirmedAt = await updatedAtOf(user, orderId);

    await loseReservation(orderId);

    expect(await updatedAtOf(user, orderId)).toBeGreaterThan(confirmedAt);
  });

  it('keeps updatedAt when the order is only read', async () => {
    const user = await newUser();
    const orderId = await placeUnconfirmedOrder(app, csrf, user, await newProduct());
    const readAt = await updatedAtOf(user, orderId);

    expect(await updatedAtOf(user, orderId)).toBe(readAt);
  });

  it('refuses a guest', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/orders/1' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});
