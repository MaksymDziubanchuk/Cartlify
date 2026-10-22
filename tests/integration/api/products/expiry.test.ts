import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { shopToday } from '@helpers/shopDay.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createFavorite,
  createProduct,
  createUser,
  receiveBatch,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder, shippingData } from '../../../helpers/orders.js';
import { moveClock } from '../../../helpers/payments.js';

// a batch is over once its last good day is behind the day of the shop (SHOP_TIME_ZONE): its
// units are no free units anywhere a buyer looks or buys (the card, the list, the cart, the
// confirm), the units held for a waiting order are not sold either, the money of such a payment
// goes back. An admin sees them apart (expiredStock) and writes them off. The test takes in a batch
// good until today and moves the clock of the app two days on

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
let clock: { restore: () => void } | null = null;

const TWO_DAYS = 2 * 86_400_000;

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// a product with 4 units good until today and 1 unit without an end
async function productWithBatchOfToday(opts: { good?: number } = {}) {
  const product = await createProduct({ stock: 0, price: 10 });
  products.push(product);
  await receiveBatch(product.id, { quantity: 4, expiresAt: shopToday() });
  if ((opts.good ?? 1) > 0) await receiveBatch(product.id, { quantity: opts.good ?? 1 });
  return product;
}

const twoDaysOn = () => {
  clock = moveClock(TWO_DAYS);
};

const getCard = (productId: number, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: `/api/products/${productId}`,
    ...(actor ? { headers: { cookie: accessCookie(actor) } } : {}),
  });

const listOf = (product: TestProduct, query = '') =>
  app.inject({
    method: 'GET',
    url: `/api/products?categoryIds=${product.categoryId}${query}`,
  });

const addToCart = (user: TestUser, productId: number, quantity: number) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/items',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { productId, quantity },
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
});

beforeEach(() => {
  clock = null;
});

afterEach(() => {
  clock?.restore();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('a batch that is over', () => {
  it('counts its units free until its last good day is over', async () => {
    const product = await productWithBatchOfToday();

    const today = await getCard(product.id);
    twoDaysOn();
    const later = await getCard(product.id);

    expect(today.json().stock).toBe(5);
    expect(later.json().stock).toBe(1);
  });

  it('shows a buyer only the good units in the list and in the favorites', async () => {
    const product = await productWithBatchOfToday();
    const user = await newUser();
    await createFavorite(user.id, product.id);
    twoDaysOn();

    const list = await listOf(product);
    const favorites = await app.inject({
      method: 'GET',
      url: '/api/favorites',
      headers: { cookie: accessCookie(user) },
    });

    expect(list.json().items).toEqual([expect.objectContaining({ id: product.id, stock: 1 })]);
    expect(favorites.json().items[0].product).toMatchObject({ id: product.id, stock: 1 });
  });

  it('shows an admin the units that are over apart from the free ones', async () => {
    const product = await productWithBatchOfToday();
    twoDaysOn();

    const res = await getCard(product.id, admin);

    expect(res.json()).toMatchObject({
      stock: 1,
      totalStock: 5,
      reservedStock: 0,
      expiredStock: 4,
    });
  });

  it('lists a product with only units that are over as out of stock', async () => {
    const product = await productWithBatchOfToday({ good: 0 });
    twoDaysOn();

    const inStock = await listOf(product, '&inStock=true');
    const outOfStock = await listOf(product, '&inStock=false');

    expect(inStock.json().items).toEqual([]);
    expect(outOfStock.json().items).toEqual([
      expect.objectContaining({ id: product.id, stock: 0 }),
    ]);
  });

  it('refuses to put more than the good units into the cart', async () => {
    const product = await productWithBatchOfToday();
    twoDaysOn();

    const res = await addToCart(await newUser(), product.id, 2);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'OUT_OF_STOCK',
      details: { productId: product.id, available: 1, requested: 2 },
    });
  });

  it('refuses to confirm the units that are over since they went into the cart', async () => {
    const product = await productWithBatchOfToday();
    const user = await newUser();
    const cartId = await placeOrder(app, csrf, user, product, 'cart', 3);
    twoDaysOn();

    const res = await app.inject({
      method: 'POST',
      url: '/api/orders/current/confirm',
      headers: withCsrf(csrf, accessCookie(user)),
      payload: { orderId: cartId, ...shippingData },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_ITEMS_UNAVAILABLE',
      details: {
        items: [{ productId: product.id, reason: 'out_of_stock', available: 1, requested: 3 }],
      },
    });
  });

  // the webhook pays through cartlify.pay_order; any answer but PAID gives the money back
  it('refuses a payment of held units whose batch is over since', async () => {
    const product = await productWithBatchOfToday({ good: 0 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'waiting', 2);
    twoDaysOn();

    const [paid] = await asAdmin(
      (tx) => tx.$queryRaw<{ result: string }[]>`
        select cartlify.pay_order(${orderId}::int, 'stripe'::cartlify."PaymentProvider", ${`pi_test_${orderId}`}, 20) as result
      `,
    );
    const order = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { status: true, paidAt: true },
      }),
    );

    expect(paid!.result).toBe('OUT_OF_STOCK');
    expect(order).toEqual({ status: 'waiting', paidAt: null });
  });

  it('gives the units that are over in the stock answer of a delivery', async () => {
    const product = await productWithBatchOfToday();
    twoDaysOn();

    const res = await app.inject({
      method: 'POST',
      url: '/api/products/stock/deliveries',
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { source: 'supplier', items: [{ productId: product.id, quantity: 2, unitCost: 1 }] },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().products).toEqual([
      { id: product.id, stock: 3, totalStock: 7, reservedStock: 0, expiredStock: 4 },
    ]);
  });
});
