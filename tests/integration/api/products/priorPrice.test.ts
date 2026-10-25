import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  waitForSalesEnd,
  type TestUser,
} from '../../../helpers/factories.js';
import { moveClock } from '../../../helpers/payments.js';

// a sale names the lowest price of the 30 days before it (salePriorPrice): the price the product
// sold at, a sale price of that time too, read from the log of prices. A sale that replaces the
// one that is on keeps the lowest price of the first; a sale taken off takes it away. A buyer sees
// it next to the sale price while the sale lasts, an admin as the row keeps it

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;

const DAY = 86_400_000;
let clock: { restore: () => void } | undefined;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
});

afterEach(() => {
  clock?.restore();
  clock = undefined;
});

afterAll(async () => {
  try {
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

// the end of a sale after ms, by the clock of the app
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

const patchSale = (productId: number, sale: unknown) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/sale`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { sale } as Record<string, unknown>,
  });

const setPrice = async (productId: number, price: number) => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { price },
  });
  expect(res.statusCode).toBe(200);
};

const buyerCard = async (productId: number) =>
  (await app.inject({ method: 'GET', url: `/api/products/${productId}` })).json();

const priorPriceOf = async (productId: number) => {
  const row = await asAdmin((tx) =>
    tx.product.findUniqueOrThrow({ where: { id: productId }, select: { salePriorPrice: true } }),
  );
  return row.salePriorPrice === null ? null : Number(row.salePriorPrice);
};

describe('the lowest price of the 30 days before a sale', () => {
  it('is the price of a product whose price did not change', async () => {
    const product = await createProduct({ price: 20 });

    const res = await patchSale(product.id, { percent: 25, endsAt: inMs(DAY) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ salePrice: 15, salePriorPrice: 20 });
    expect(await buyerCard(product.id)).toMatchObject({
      price: 20,
      salePrice: 15,
      salePriorPrice: 20,
    });
    expect(await priorPriceOf(product.id)).toBe(20);
  });

  it('takes a lower price the product had in the 30 days', async () => {
    const product = await createProduct({ price: 20 });
    await setPrice(product.id, 15);
    await setPrice(product.id, 30);

    const res = await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    expect(res.json()).toMatchObject({ price: 30, salePrice: 27, salePriorPrice: 15 });
  });

  it('leaves out a price from before the 30 days', async () => {
    const product = await createProduct({ price: 20 });
    await setPrice(product.id, 15);
    await setPrice(product.id, 30);
    clock = moveClock(31 * DAY);

    const res = await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    expect(res.json()).toMatchObject({ salePrice: 27, salePriorPrice: 30 });
  });

  it('takes a sale price the product sold at in the 30 days', async () => {
    const product = await createProduct({ price: 20 });
    await patchSale(product.id, { amount: 8, endsAt: inMs(DAY) });
    await patchSale(product.id, null);

    const res = await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    expect(res.json()).toMatchObject({ salePrice: 18, salePriorPrice: 12 });
  });

  // the sale began before the 30 days and lasted into them: its price was a price of that time
  it('takes the price of a sale that was on when the 30 days began', async () => {
    const product = await createProduct({ price: 20 });
    await patchSale(product.id, { amount: 8, endsAt: inMs(33 * DAY) });
    clock = moveClock(35 * DAY);

    const res = await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    expect(res.json()).toMatchObject({ salePrice: 18, salePriorPrice: 12 });
  });

  // one reduction after another: the price before the first one is the price the buyer compares
  it('keeps the lowest price of the first sale when a new sale replaces the one that is on', async () => {
    const product = await createProduct({ price: 20 });
    await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    const res = await patchSale(product.id, { percent: 20, endsAt: inMs(2 * DAY) });

    expect(res.json()).toMatchObject({ salePrice: 16, salePriorPrice: 20 });
  });

  it('goes with the sale when the sale is taken off', async () => {
    const product = await createProduct({ price: 20 });
    await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    const res = await patchSale(product.id, null);

    expect(res.json()).toMatchObject({ salePrice: null, salePriorPrice: null });
    expect(await priorPriceOf(product.id)).toBeNull();
  });

  it('goes with a sale a new price takes off', async () => {
    const product = await createProduct({ price: 20 });
    await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { price: 25, sale: null },
    });

    expect(res.json()).toMatchObject({ price: 25, salePrice: null, salePriorPrice: null });
  });

  // a buyer sees a sale only while it lasts, its lowest price with it
  it('is left out for a buyer once the sale is over, and stays for an admin', async () => {
    const product = await createProduct({ price: 20 });
    await asAdmin(
      (tx) => tx.$executeRaw`
        update cartlify.products
        set "salePrice" = 15, "salePriorPrice" = 20,
            "saleEndsAt" = (now() at time zone 'utc') + interval '1.5 seconds'
        where id = ${product.id}
      `,
    );
    await waitForSalesEnd([product.id]);

    expect(await buyerCard(product.id)).not.toHaveProperty('salePriorPrice');
    const admins = await app.inject({
      method: 'GET',
      url: `/api/products/${product.id}`,
      headers: { cookie: accessCookie(admin) },
    });
    expect(admins.json()).toMatchObject({ salePrice: 15, salePriorPrice: 20 });
  });

  it('shows in the catalog next to the sale price', async () => {
    const product = await createProduct({ price: 20, name: `Prior ${Date.now()}` });
    await patchSale(product.id, { percent: 50, endsAt: inMs(DAY) });

    const res = await app.inject({
      method: 'GET',
      url: `/api/products?categoryIds=${product.categoryId}`,
    });

    expect(res.json().items).toEqual([
      expect.objectContaining({ id: product.id, salePrice: 10, salePriorPrice: 20 }),
    ]);
  });
});
