import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { shopToday } from '@helpers/shopDay.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  receiveBatch,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';
import { moveClock } from '../../../helpers/payments.js';

// PATCH /api/products: the prices of many products at once

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
// an order keeps its product, so the products stay; the test database goes after the run
const products: TestProduct[] = [];
let clock: { restore: () => void } | null = null;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
});

afterEach(() => {
  clock?.restore();
  clock = null;
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const newProduct = async (opts: Parameters<typeof createProduct>[0]) => {
  const product = await createProduct(opts);
  products.push(product);
  return product;
};

const bulk = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: '/api/products',
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

const priceOf = async (productId: number) =>
  Number(
    (
      await asAdmin((tx) =>
        tx.product.findUniqueOrThrow({ where: { id: productId }, select: { price: true } }),
      )
    ).price,
  );

describe('PATCH /api/products', () => {
  // 1.15 times 1.1 is 1.2649999 in floating point: the price came out 1.26
  it('counts a percent in cents, half up: 1.15 plus 10 percent is 1.27', async () => {
    const product = await newProduct({ price: 1.15, stock: 1 });

    const res = await bulk({ mode: 'percent', value: 10, scope: { productIds: [product.id] } });

    expect(res.statusCode).toBe(200);
    expect(await priceOf(product.id)).toBe(1.27);
  });

  // in stock means what it means in the catalog: units free to buy, not the units the waiting
  // orders hold
  it('takes only the products with free units when the scope asks for the ones in stock', async () => {
    const held = await newProduct({ price: 10, stock: 2 });
    await placeOrder(app, csrf, buyer, held, 'waiting', 2);
    const free = await newProduct({ price: 10, stock: 2 });

    const res = await bulk({
      mode: 'fixed',
      value: 1,
      scope: { productIds: [held.id, free.id], inStock: true },
    });

    expect(res.statusCode).toBe(200);
    expect(await priceOf(held.id)).toBe(10);
    expect(await priceOf(free.id)).toBe(11);
  });

  it('takes the products without free units when the scope asks for the ones out of stock', async () => {
    const held = await newProduct({ price: 10, stock: 2 });
    await placeOrder(app, csrf, buyer, held, 'waiting', 2);
    const free = await newProduct({ price: 10, stock: 2 });

    await bulk({
      mode: 'fixed',
      value: 1,
      scope: { productIds: [held.id, free.id], inStock: false },
    });

    expect(await priceOf(held.id)).toBe(11);
    expect(await priceOf(free.id)).toBe(10);
  });

  // a product in carts or with units past their day still gets its new price without the filter
  it('changes a product held by orders and one with units over without the filter', async () => {
    const held = await newProduct({ price: 10, stock: 2 });
    await placeOrder(app, csrf, buyer, held, 'cart', 2);
    const over = await newProduct({ price: 10, stock: 0 });
    await receiveBatch(over.id, { quantity: 3, expiresAt: shopToday() });
    clock = moveClock(2 * 86_400_000);

    const res = await bulk({ mode: 'fixed', value: 1, scope: { productIds: [held.id, over.id] } });

    expect(res.statusCode).toBe(200);
    expect(await priceOf(held.id)).toBe(11);
    expect(await priceOf(over.id)).toBe(11);
  });

  it('counts the units over as no free units', async () => {
    const over = await newProduct({ price: 10, stock: 0 });
    await receiveBatch(over.id, { quantity: 3, expiresAt: shopToday() });
    clock = moveClock(2 * 86_400_000);

    await bulk({ mode: 'fixed', value: 1, scope: { productIds: [over.id], inStock: true } });

    expect(await priceOf(over.id)).toBe(10);
  });
});
