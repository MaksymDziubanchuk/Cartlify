import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  receiveBatch,
  writeOffStock,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { orderRowOf, placeOrder } from '../../../helpers/orders.js';

// GET /api/admin/reports/accounting: what the shop sold in a period and what it cost, the cancels
// that took sales back, what came in and what was written off, and the value of the stock left.
// A sale counts from the time it was paid, its cost from the batches it took; a cancel takes it
// back at the time of the cancel. Other test files make orders and batches at the same time, so
// each test reads only its own products (productIds)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// a product without stock: the test takes in its own batches at its own costs
const newProduct = async (price = 10) => {
  const product = await createProduct({ price, stock: 0 });
  products.push(product);
  return product;
};

const report = (query: Record<string, string>, actor: TestUser = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/reports/accounting?${new URLSearchParams(query)}`,
    headers: { cookie: accessCookie(actor) },
  });

// the report of the products from a minute before the test until a minute after now
const reportOf = (ofProducts: TestProduct[], startedAt: number) =>
  report({
    from: new Date(startedAt - 60_000).toISOString(),
    to: new Date(Date.now() + 60_000).toISOString(),
    productIds: ofProducts.map((p) => p.id).join(','),
  });

const utcDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const cancelPaid = (orderId: number) =>
  asAdmin((tx) => tx.$executeRaw`select cartlify.cancel_paid_order(${orderId}::int)`);

const NOTHING = { units: 0, value: 0 };

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

describe('GET /api/admin/reports/accounting', () => {
  it('counts the sales of the period, the cost of the batches they took and the margin', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    // a sale takes the batch that ends first: 3 at 2, then 1 of the batch at 3
    await receiveBatch(product.id, { quantity: 5, unitCost: 3 });
    await receiveBatch(product.id, { quantity: 3, unitCost: 2, expiresAt: utcDay(5) });
    await placeOrder(app, csrf, await newUser(), product, 'paid', 4);

    const res = await reportOf([product], startedAt);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      currency: 'eur',
      sales: { orders: 1, units: 4, revenue: 40, cost: 9, margin: 31 },
      cancellations: { orders: 0, units: 0, revenue: 0, cost: 0 },
      net: { revenue: 40, cost: 9, margin: 31 },
      // what is left: 4 of the batch at 3
      stock: { units: 4, value: 12 },
    });
  });

  it('counts an order of several products once, and only the products asked for', async () => {
    const startedAt = Date.now();
    const asked = await newProduct(10);
    const notAsked = await newProduct(20);
    await receiveBatch(asked.id, { quantity: 5, unitCost: 4 });
    await receiveBatch(notAsked.id, { quantity: 5, unitCost: 15 });
    const buyer = await newUser();
    // two items of one cart, paid together
    await placeOrder(app, csrf, buyer, notAsked, 'cart');
    await placeOrder(app, csrf, buyer, asked, 'paid', 2);

    const one = await reportOf([asked], startedAt);
    const both = await reportOf([asked, notAsked], startedAt);

    expect(one.json().sales).toEqual({ orders: 1, units: 2, revenue: 20, cost: 8, margin: 12 });
    expect(both.json().sales).toEqual({ orders: 1, units: 3, revenue: 40, cost: 23, margin: 17 });
  });

  it('takes a cancelled sale back in the period of the cancel', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 5, unitCost: 4 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid', 2);
    await cancelPaid(orderId);
    const { paidAt, cancelledAt } = await orderRowOf(orderId);

    const whole = await reportOf([product], startedAt);
    // the period of the sale ends where the cancel comes
    const beforeCancel = await report({
      from: new Date(startedAt - 60_000).toISOString(),
      to: cancelledAt!.toISOString(),
      productIds: String(product.id),
    });

    expect(whole.json()).toMatchObject({
      sales: { orders: 1, units: 2, revenue: 20, cost: 8, margin: 12 },
      cancellations: { orders: 1, units: 2, revenue: 20, cost: 8 },
      net: { revenue: 0, cost: 0, margin: 0 },
      // the units went back into their batch
      stock: { units: 5, value: 20 },
    });
    expect(beforeCancel.json()).toMatchObject({
      sales: { orders: 1, revenue: 20 },
      cancellations: { orders: 0, revenue: 0 },
    });
    expect(paidAt!.getTime()).toBeLessThan(cancelledAt!.getTime());
  });

  it('counts a sale from the time it was paid: the period starts there and ends before it', async () => {
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 2, unitCost: 1 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid');
    const { paidAt } = await orderRowOf(orderId);
    const query = (from: Date, to: Date) =>
      report({ from: from.toISOString(), to: to.toISOString(), productIds: String(product.id) });

    const fromPayment = await query(paidAt!, new Date(paidAt!.getTime() + 60_000));
    const untilPayment = await query(new Date(paidAt!.getTime() - 60_000), paidAt!);

    expect(fromPayment.json().sales).toMatchObject({ orders: 1, revenue: 10 });
    expect(untilPayment.json().sales).toMatchObject({ orders: 0, revenue: 0 });
  });

  it('counts what came in by source at its cost', async () => {
    const startedAt = Date.now();
    const product = await newProduct();
    await receiveBatch(product.id, { quantity: 4, unitCost: 2.5 });
    await receiveBatch(product.id, { quantity: 2, unitCost: 3, source: 'supplier' });
    await receiveBatch(product.id, { quantity: 1, unitCost: 1, source: 'surplus' });
    await receiveBatch(product.id, { quantity: 3, unitCost: 0.5, source: 'customer_return' });

    const res = await reportOf([product], startedAt);

    expect(res.json().purchases).toEqual({
      units: 10,
      value: 18.5,
      bySource: {
        supplier: { units: 6, value: 16 },
        surplus: { units: 1, value: 1 },
        customer_return: { units: 3, value: 1.5 },
      },
    });
  });

  it('counts what was written off by reason at the cost of its batches', async () => {
    const startedAt = Date.now();
    const product = await newProduct();
    const cheap = await receiveBatch(product.id, { quantity: 4, unitCost: 1 });
    const dear = await receiveBatch(product.id, { quantity: 4, unitCost: 5 });
    await writeOffStock(product.id, 2, { batchId: dear, reason: 'damaged' });
    await writeOffStock(product.id, 1, { batchId: cheap, reason: 'damaged' });
    await writeOffStock(product.id, 3, { batchId: cheap, reason: 'shortage' });

    const res = await reportOf([product], startedAt);

    expect(res.json().writeOffs).toEqual({
      units: 6,
      value: 14,
      byReason: {
        damaged: { units: 3, value: 11 },
        defective: NOTHING,
        expired: NOTHING,
        shortage: { units: 3, value: 3 },
        returned_to_supplier: NOTHING,
        other: NOTHING,
      },
    });
    // what is left: 2 at 5
    expect(res.json().stock).toEqual({ units: 2, value: 10 });
  });

  it('gives the period it counted and every section empty when nothing happened', async () => {
    const product = await newProduct();
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-02-01T00:00:00.000Z';

    const res = await report({ from, to, productIds: String(product.id) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      period: { from, to },
      currency: 'eur',
      sales: { orders: 0, units: 0, revenue: 0, cost: 0, margin: 0 },
      cancellations: { orders: 0, units: 0, revenue: 0, cost: 0 },
      net: { revenue: 0, cost: 0, margin: 0 },
      purchases: {
        ...NOTHING,
        bySource: { supplier: NOTHING, surplus: NOTHING, customer_return: NOTHING },
      },
      writeOffs: {
        ...NOTHING,
        byReason: {
          damaged: NOTHING,
          defective: NOTHING,
          expired: NOTHING,
          shortage: NOTHING,
          returned_to_supplier: NOTHING,
          other: NOTHING,
        },
      },
      stock: NOTHING,
    });
  });

  it('counts every product without the filter, ours among them', async () => {
    const startedAt = Date.now();
    const product = await newProduct(10);
    await receiveBatch(product.id, { quantity: 3, unitCost: 2 });
    await placeOrder(app, csrf, await newUser(), product, 'paid', 1);

    const res = await report({
      from: new Date(startedAt - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sales.revenue).toBeGreaterThanOrEqual(10);
    expect(res.json().purchases.units).toBeGreaterThanOrEqual(3);
    expect(res.json().stock.units).toBeGreaterThanOrEqual(2);
  });

  it('counts from the start of all time until now when no period is given', async () => {
    const before = Date.now();

    const res = await report({ productIds: String((await newProduct()).id) });

    expect(res.statusCode).toBe(200);
    expect(res.json().period.from).toBe(new Date(0).toISOString());
    expect(Date.parse(res.json().period.to)).toBeGreaterThanOrEqual(before - 5_000);
  });

  it('refuses a period that ends before it starts', async () => {
    const res = await report({ from: '2026-02-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'INVALID_STATS_PERIOD' });
  });

  it.each([
    ['a date that is not a date', { from: 'yesterday' }],
    ['product ids that are not ids', { productIds: '1,abc' }],
    ['a product id of zero', { productIds: '0' }],
    ['an empty product id', { productIds: '1,,2' }],
  ])('refuses %s', async (_case, query) => {
    const res = await report(query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a product id past the largest id', async () => {
    const res = await report({ productIds: '2147483648' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_IDS_INVALID' });
  });

  it('refuses more than 100 product ids', async () => {
    const res = await report({
      productIds: Array.from({ length: 101 }, (_, n) => n + 1).join(','),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_IDS_INVALID' });
  });

  it('lets root read the report too', async () => {
    const res = await report({}, await newUser({ role: 'ROOT' }));

    expect(res.statusCode).toBe(200);
  });

  it('refuses a user and a guest', async () => {
    const user = await report({}, await newUser());
    const guest = await app.inject({ method: 'GET', url: '/api/admin/reports/accounting' });

    expect(user.statusCode).toBe(403);
    expect(user.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(guest.statusCode).toBe(403);
  });
});
