import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  auditLinesOf,
  markVariantDeleted,
  priceLinesOf,
  priceRowOf,
  variantRowsOf,
} from '../../../helpers/variants.js';

// PATCH /api/products/:productId/variants/:variantId changes the price of a variant, with the word
// on its sale when it has one (the steps of a sale are in sale.test.ts): the answer, the log of
// prices, the admin log about the variant. Products with a log of prices cannot be deleted, so the
// products of the file stay; the test database goes after the run

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;

const DAY = 86_400_000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  buyer = await createUser();
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, root.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const newProduct = (opts: Parameters<typeof createProduct>[0] = {}): Promise<TestProduct> =>
  createProduct({ price: 20, ...opts });

const change = (
  product: { id: number; variantId: number },
  payload: Record<string, unknown>,
  actor: TestUser | null = admin,
) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${product.id}/variants/${product.variantId}`,
    headers: withCsrf(csrf, actor ? accessCookie(actor) : ''),
    payload,
  });

const updateLines = (variantId: number) => auditLinesOf('variant', variantId, ['variant.update']);

describe('PATCH /api/products/:productId/variants/:variantId and the price', () => {
  it('changes the price, answers with the product and the variant and keeps the change in both logs', async () => {
    const product = await newProduct();

    const res = await change(product, { price: 24.5 });

    expect(res.statusCode).toBe(200);
    expect(res.json().product).toMatchObject({ id: product.id });
    expect(res.json().variant).toMatchObject({ id: product.variantId, price: 24.5 });
    expect((await priceRowOf(product.variantId)).price).toBe(24.5);
    expect(await priceLinesOf(product.variantId)).toEqual([
      {
        mode: 'fixed',
        oldPrice: 20,
        newPrice: 24.5,
        value: 4.5,
        endsAt: null,
        actorId: admin.id,
        event: 'price.set',
        productId: product.id,
      },
    ]);
    expect(await updateLines(product.variantId)).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        event: 'variant.update',
        meta: [{ field: 'price', old: '20', new: '24.5' }],
      },
    ]);
  });

  it('writes a change down with a negative value', async () => {
    const product = await newProduct();

    await change(product, { price: 12.25 });

    expect(await priceLinesOf(product.variantId)).toEqual([
      expect.objectContaining({ mode: 'fixed', oldPrice: 20, newPrice: 12.25, value: -7.75 }),
    ]);
  });

  it('lets root change the price, in the logs in the name of root', async () => {
    const product = await newProduct();

    const res = await change(product, { price: 21 }, root);

    expect(res.statusCode).toBe(200);
    expect(await priceLinesOf(product.variantId)).toEqual([
      expect.objectContaining({ actorId: root.id }),
    ]);
    expect((await updateLines(product.variantId))[0]).toMatchObject({ actorId: root.id });
  });

  it('takes a price of 0 and the highest price the column holds', async () => {
    const product = await newProduct();

    const free = await change(product, { price: 0 });
    const highest = await change(product, { price: 99_999_999.99 });

    expect(free.statusCode).toBe(200);
    expect(free.json().variant.price).toBe(0);
    expect(highest.statusCode).toBe(200);
    expect(highest.json().variant.price).toBe(99_999_999.99);
  });

  it('writes nothing for the price it already has', async () => {
    const product = await newProduct();

    const res = await change(product, { price: 20 });

    expect(res.statusCode).toBe(200);
    expect(await priceLinesOf(product.variantId)).toEqual([]);
    expect(await updateLines(product.variantId)).toEqual([]);
  });

  it('changes the price with the other fields in one line of the admin log', async () => {
    const product = await newProduct();
    const sku = `PRICE-${uniqueTag()}`;

    const res = await change(product, { price: 30, sku, weightGrams: 200 });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 30, sku, weightGrams: 200 });
    const lines = await updateLines(product.variantId);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.meta).toEqual([
      { field: 'sku', old: null, new: sku },
      { field: 'weightGrams', old: null, new: 200 },
      { field: 'price', old: '20', new: '30' },
    ]);
  });

  it('changes the price of a variant taken out of sale', async () => {
    const product = await newProduct();
    await markVariantDeleted(product.variantId);

    const res = await change(product, { price: 22 });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 22, visible: false });
  });

  it.each([
    ['a part of a cent', 10.004],
    ['a price below 0', -1],
    ['a price past what the column holds', 100_000_000],
  ])('refuses %s and changes nothing', async (_case, price) => {
    const product = await newProduct();

    const res = await change(product, { price });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_PRICE_INVALID' });
    expect((await priceRowOf(product.variantId)).price).toBe(20);
  });

  it('refuses a price that is no number', async () => {
    const product = await newProduct();

    const res = await change(product, { price: 'cheap' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // a null is no price of 0
  it('refuses a price of null and keeps the price', async () => {
    const product = await newProduct();

    const res = await change(product, { price: null });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_PRICE_INVALID' });
    expect((await priceRowOf(product.variantId)).price).toBe(20);
  });

  it('changes nothing when the article number beside the price is taken', async () => {
    const sku = `TAKEN-${uniqueTag()}`;
    await newProduct({ sku });
    const product = await newProduct();

    const res = await change(product, { price: 25, sku });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SKU_TAKEN', details: { sku } });
    expect((await priceRowOf(product.variantId)).price).toBe(20);
    expect(await priceLinesOf(product.variantId)).toEqual([]);
  });

  it('refuses a stock beside the price', async () => {
    const product = await newProduct();

    const res = await change(product, { price: 25, stock: 3 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_STOCK_NOT_ALLOWED' });
    expect((await priceRowOf(product.variantId)).price).toBe(20);
  });

  it('changes nothing when a field beside the price is refused', async () => {
    const product = await newProduct();

    const res = await change(product, { price: 25, weightGrams: 0 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_WEIGHT_INVALID' });
    expect((await priceRowOf(product.variantId)).price).toBe(20);
    expect(await priceLinesOf(product.variantId)).toEqual([]);
  });

  it.each([
    ['a user', () => buyer],
    ['a guest', () => null],
  ])('refuses %s', async (_who, actorOf) => {
    const product = await newProduct();

    const res = await change(product, { price: 25 }, actorOf());

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect((await priceRowOf(product.variantId)).price).toBe(20);
  });

  it('answers 404 for a variant of another product', async () => {
    const product = await newProduct();
    const other = await newProduct();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}/variants/${other.variantId}`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { price: 25 },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
    expect((await priceRowOf(other.variantId)).price).toBe(20);
  });

  // the prices of the other variants of the product stay
  it('leaves the other variants of the product as they are', async () => {
    const product = await newProduct();

    await change(product, { price: 25 });

    expect((await variantRowsOf(product.id)).map((row) => Number(row.price))).toEqual([25]);
  });
});

// a sale through the change of a variant is no sale of a variant that is out: the variant that is
// taken out of sale sells no more, as on the route of the sale (a product taken out of the catalog
// and the end the database refuses are in validation.test.ts)
describe('a sale through the change of a variant', () => {
  const sale = () => ({ percent: 10, endsAt: inMs(DAY) });

  it('is 404 for a variant taken out of sale of a product that is in the catalog', async () => {
    const product = await newProduct();
    await markVariantDeleted(product.variantId);

    const res = await change(product, { price: 30, sale: sale() });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
    expect((await priceRowOf(product.variantId)).price).toBe(20);
  });

  it('is 404 for a product that is not there', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/products/2000000000/variants/2000000000`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { price: 30, sale: sale() },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('refuses an end that is behind', async () => {
    const product = await newProduct();

    const res = await change(product, {
      price: 30,
      sale: { percent: 10, endsAt: inMs(-DAY) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID' });
    expect((await priceRowOf(product.variantId)).price).toBe(20);
  });

  it('takes the word remove for a variant without a sale: there is nothing to take off', async () => {
    const product = await newProduct();

    const res = await change(product, { price: 26, sale: 'remove' });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 26, salePrice: null });
    expect((await priceLinesOf(product.variantId)).map((line) => line.event)).toEqual([
      'price.set',
    ]);
  });

  it('takes the word keep for a variant without a sale', async () => {
    const product = await newProduct();

    const res = await change(product, { price: 27, sale: 'keep' });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 27, salePrice: null });
  });

  it('puts the sale on from the new price and answers with the variant on sale', async () => {
    const product = await newProduct();
    const { endsAt } = sale();

    const res = await change(product, { price: 50, sale: { percent: 10, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({
      price: 50,
      salePrice: 45,
      saleEndsAt: endsAt,
      salePriorPrice: 20,
    });
  });
});
