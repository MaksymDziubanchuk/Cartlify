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
  createVariant,
  waitForSalesEnd,
  type TestUser,
} from '../../../helpers/factories.js';
import { moveClock } from '../../../helpers/payments.js';
import { priceRowOf } from '../../../helpers/variants.js';

// a sale names the lowest price of the 30 days before it (salePriorPrice): the price the variant
// sold at, a sale price of that time too, read from the log of prices of the variant (each variant
// has its own). A sale that replaces the one that is on keeps the lowest price of the first; a sale
// taken off takes it away. A buyer sees it next to the sale price while the sale lasts, an admin as
// the row keeps it

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

// the sale of one variant of a product, the sale route with the variant named
const patchSale = (productId: number, sale: unknown, variantId?: number) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/sale`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { ...(variantId ? { variantIds: [variantId] } : {}), sale } as Record<string, unknown>,
  });

const setPrice = async (productId: number, variantId: number, price: number) => {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/variants/${variantId}`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { price },
  });
  expect(res.statusCode).toBe(200);
};

const buyerCard = async (productId: number) =>
  (await app.inject({ method: 'GET', url: `/api/products/${productId}` })).json();

const priorPriceOf = async (variantId: number) => (await priceRowOf(variantId)).salePriorPrice;

// the lowest price of what the sale route answered for the variant
const priorOf = (res: { json: () => { variants: Array<Record<string, unknown>> } }, at = 0) =>
  res.json().variants[at];

describe('the lowest price of the 30 days before a sale', () => {
  it('is the price of a variant whose price did not change', async () => {
    const product = await createProduct({ price: 20 });

    const res = await patchSale(product.id, { percent: 25, endsAt: inMs(DAY) });

    expect(res.statusCode).toBe(200);
    expect(priorOf(res)).toMatchObject({ salePrice: 15, salePriorPrice: 20 });
    expect((await buyerCard(product.id)).variant).toMatchObject({
      price: 20,
      salePrice: 15,
      salePriorPrice: 20,
    });
    expect(await priorPriceOf(product.variantId)).toBe(20);
  });

  it('takes a lower price the variant had in the 30 days', async () => {
    const product = await createProduct({ price: 20 });
    await setPrice(product.id, product.variantId, 15);
    await setPrice(product.id, product.variantId, 30);

    const res = await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    expect(priorOf(res)).toMatchObject({ price: 30, salePrice: 27, salePriorPrice: 15 });
  });

  it('leaves out a price from before the 30 days', async () => {
    const product = await createProduct({ price: 20 });
    await setPrice(product.id, product.variantId, 15);
    await setPrice(product.id, product.variantId, 30);
    clock = moveClock(31 * DAY);

    const res = await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    expect(priorOf(res)).toMatchObject({ salePrice: 27, salePriorPrice: 30 });
  });

  it('takes a sale price the variant sold at in the 30 days', async () => {
    const product = await createProduct({ price: 20 });
    await patchSale(product.id, { amount: 8, endsAt: inMs(DAY) });
    await patchSale(product.id, null);

    const res = await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    expect(priorOf(res)).toMatchObject({ salePrice: 18, salePriorPrice: 12 });
  });

  // the sale began before the 30 days and lasted into them: its price was a price of that time
  it('takes the price of a sale that was on when the 30 days began', async () => {
    const product = await createProduct({ price: 20 });
    await patchSale(product.id, { amount: 8, endsAt: inMs(33 * DAY) });
    clock = moveClock(35 * DAY);

    const res = await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    expect(priorOf(res)).toMatchObject({ salePrice: 18, salePriorPrice: 12 });
  });

  // one reduction after another: the price before the first one is the price the buyer compares
  it('keeps the lowest price of the first sale when a new sale replaces the one that is on', async () => {
    const product = await createProduct({ price: 20 });
    await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    const res = await patchSale(product.id, { percent: 20, endsAt: inMs(2 * DAY) });

    expect(priorOf(res)).toMatchObject({ salePrice: 16, salePriorPrice: 20 });
  });

  it('goes with the sale when the sale is taken off', async () => {
    const product = await createProduct({ price: 20 });
    await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    const res = await patchSale(product.id, null);

    expect(priorOf(res)).toMatchObject({ salePrice: null, salePriorPrice: null });
    expect(await priorPriceOf(product.variantId)).toBeNull();
  });

  it('goes with a sale a new price takes off', async () => {
    const product = await createProduct({ price: 20 });
    await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}/variants/${product.variantId}`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { price: 25, sale: 'remove' },
    });

    expect(res.json().variant).toMatchObject({ price: 25, salePrice: null, salePriorPrice: null });
  });

  // a buyer sees a sale only while it lasts, its lowest price with it
  it('is left out for a buyer once the sale is over, and stays for an admin', async () => {
    const product = await createProduct({ price: 20 });
    await asAdmin(
      (tx) => tx.$executeRaw`
        update cartlify.product_variants
        set "salePrice" = 15, "salePriorPrice" = 20,
            "saleEndsAt" = (now() at time zone 'utc') + interval '1.5 seconds'
        where id = ${product.variantId}
      `,
    );
    await waitForSalesEnd([product.id]);

    expect((await buyerCard(product.id)).variant).not.toHaveProperty('salePriorPrice');
    const admins = await app.inject({
      method: 'GET',
      url: `/api/products/${product.id}`,
      headers: { cookie: accessCookie(admin) },
    });
    expect(admins.json().variant).toMatchObject({ salePrice: 15, salePriorPrice: 20 });
  });
});

// each variant has a history of prices of its own: the lowest price is read from it, not from the
// history of its product
describe('the lowest price of a variant is read from its own history', () => {
  it('takes the lower price one variant had and not the one of its neighbour', async () => {
    const product = await createProduct({ price: 20 });
    const other = await createVariant(product.id, { price: 50 });
    await setPrice(product.id, product.variantId, 12);
    await setPrice(product.id, product.variantId, 20);
    await setPrice(product.id, other.id, 40);

    const res = await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      expect.objectContaining({ id: product.variantId, salePrice: 18, salePriorPrice: 12 }),
      expect.objectContaining({ id: other.id, salePrice: 36, salePriorPrice: 40 }),
    ]);
  });

  it('is the price of a variant that never changed, whatever its neighbour did', async () => {
    const product = await createProduct({ price: 20 });
    const other = await createVariant(product.id, { price: 50 });
    await setPrice(product.id, product.variantId, 5);

    const res = await patchSale(product.id, { percent: 10, endsAt: inMs(DAY) }, other.id);

    expect(res.statusCode).toBe(200);
    expect(priorOf(res)).toMatchObject({ id: other.id, salePrice: 45, salePriorPrice: 50 });
  });
});
