import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  putOnSale,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';

// the variants of an admin with few free units (maxStock): like the other flags of an admin it
// lists every variant of the catalog with its condition, on sale or with an override too, and
// leaves the deleted ones out; the free units are the stock less the reserve and the units of the
// batches that are over, the number the list shows as stock. The alerts of low stock and no stock
// send an admin to it. The rows are variants then; inStock alone asks products (a product has free
// units when a variant of it has). A test looks at the products of a category of its own

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const list = (query: Record<string, string>, actor: TestUser = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/products?${new URLSearchParams(query)}`,
    headers: { cookie: accessCookie(actor) },
  });

type Row = { product: { id: number }; variant: { id: number }; stock: number };

const idsOf = (res: LightMyRequestResponse) =>
  (res.json().items as Row[]).map((item) => item.product.id);
const variantIdsOf = (res: LightMyRequestResponse) =>
  (res.json().items as Row[]).map((item) => item.variant.id);

describe('GET /api/products with maxStock', () => {
  it('lists every product of the catalog with free units up to the number, the fewest first', async () => {
    const { id: categoryId } = await createCategory();
    const none = await createProduct({ categoryId, price: 10, stock: 0 });
    const two = await createProduct({ categoryId, price: 10, stock: 2 });
    const onSale = await createProduct({ categoryId, price: 10, stock: 1 });
    await putOnSale(onSale.id, 5);
    const three = await createProduct({ categoryId, price: 10, stock: 3 });
    const deleted = await createProduct({ categoryId, price: 10, stock: 1 });
    await deleteProductFromCatalog(deleted.id);

    const res = await list({
      categoryIds: String(categoryId),
      maxStock: '2',
      sort: 'stock',
      order: 'asc',
    });

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([none.id, onSale.id, two.id]);
    expect(idsOf(res)).not.toContain(three.id);
  });

  it('takes the units the orders hold as not free', async () => {
    const { id: categoryId } = await createCategory();
    const product = await createProduct({ categoryId, price: 10, stock: 4 });
    await placeOrder(app, csrf, await createUser(), product, 'waiting', 3);

    const res = await list({ categoryIds: String(categoryId), maxStock: '1' });

    expect(idsOf(res)).toEqual([product.id]);
  });

  it('lists only the products with some free units with inStock', async () => {
    const { id: categoryId } = await createCategory();
    await createProduct({ categoryId, price: 10, stock: 0 });
    const few = await createProduct({ categoryId, price: 10, stock: 2 });

    const res = await list({ categoryIds: String(categoryId), maxStock: '5', inStock: 'true' });

    expect(idsOf(res)).toEqual([few.id]);
  });

  it('refuses a buyer', async () => {
    const buyer = await createUser();
    userIds.push(buyer.id);

    const res = await list({ maxStock: '2' }, buyer);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      errorCode: 'FILTER_FORBIDDEN',
      details: { filter: 'maxStock' },
    });
  });

  it.each(['-1', '1.5', 'few'])('refuses maxStock=%s', async (maxStock) => {
    const res = await list({ maxStock });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

// a product with several variants: the free units are the variant's
describe('GET /api/products with the stock of the variants of a product', () => {
  it('lists the variants with few free units, not the products', async () => {
    const { id: categoryId } = await createCategory();
    const product = await createProduct({ categoryId, price: 10, stock: 1 });
    const plenty = await createVariant(product.id, { price: 10, stock: 10 });
    const none = await createVariant(product.id, { price: 10, stock: 0 });

    const query = { categoryIds: String(categoryId), maxStock: '2', sort: 'stock', order: 'asc' };

    // every variant on a row of its own (the flag of an admin): the free units of the variant
    const res = await list({ ...query, group: 'false' });
    // the variants of a product with no main characteristic are one group; the filter keeps the
    // variants with few units in it, and the units of the group are theirs alone
    const grouped = await list(query);

    expect(variantIdsOf(res)).toEqual([none.id, product.variantId]);
    expect(variantIdsOf(res)).not.toContain(plenty.id);
    expect((res.json().items as Row[]).map((row) => row.stock)).toEqual([0, 1]);
    expect(res.json().total).toBe(2);
    expect(variantIdsOf(grouped)).toEqual([product.variantId]);
    expect((grouped.json().items as Row[]).map((row) => row.stock)).toEqual([1]);
    expect(grouped.json().total).toBe(1);
  });

  it('lists a product once with inStock when it has a variant with free units', async () => {
    const { id: categoryId } = await createCategory();
    const mixed = await createProduct({ categoryId, price: 10, stock: 0 });
    const free = await createVariant(mixed.id, { price: 10, stock: 3 });
    await createVariant(mixed.id, { price: 10, stock: 4 });
    const empty = await createProduct({ categoryId, price: 10, stock: 0 });
    await createVariant(empty.id, { price: 10, stock: 0 });

    const inStock = await list({ categoryIds: String(categoryId), inStock: 'true' });
    const outOfStock = await list({ categoryIds: String(categoryId), inStock: 'false' });

    // a product row: the main variant is the first with free units, the stock is the sum of them
    expect(inStock.json().items).toEqual([
      expect.objectContaining({
        product: expect.objectContaining({ id: mixed.id }),
        variant: expect.objectContaining({ id: free.id }),
        stock: 7,
      }),
    ]);
    expect(idsOf(outOfStock)).toEqual([empty.id]);
    expect(outOfStock.json().items[0]).toMatchObject({ stock: 0 });
  });

  it('lists the variants with free units with inStock when the rows are variants', async () => {
    const { id: categoryId } = await createCategory();
    const product = await createProduct({ categoryId, price: 10, stock: 0 });
    const free = await createVariant(product.id, { price: 11, stock: 3 });

    const inStock = await list({
      categoryIds: String(categoryId),
      inStock: 'true',
      sort: 'price',
      order: 'asc',
    });
    const outOfStock = await list({
      categoryIds: String(categoryId),
      inStock: 'false',
      sort: 'price',
      order: 'asc',
    });

    expect(variantIdsOf(inStock)).toEqual([free.id]);
    expect(variantIdsOf(outOfStock)).toEqual([product.variantId]);
  });
});
