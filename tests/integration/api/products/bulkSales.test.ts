import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';

// POST /api/products/sales puts sales on many products at once, all of them or none: each product
// with a sale of its own, or one sale for the products of the catalog of a category and its branch.
// Each sale is the one of PATCH /api/products/:productId/sale, with every line of the logs; a
// product that has the same sale already stays as it is

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;

const DAY = 86_400_000;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

const postSales = (payload: Record<string, unknown>, actor: TestUser = admin) =>
  app.inject({
    method: 'POST',
    url: '/api/products/sales',
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

const salesOf = async (ids: number[]) => {
  const rows = await asAdmin((tx) =>
    tx.product.findMany({
      where: { id: { in: ids } },
      orderBy: { id: 'asc' },
      select: { id: true, salePrice: true },
    }),
  );
  return rows.map((row) => ({
    id: row.id,
    salePrice: row.salePrice === null ? null : Number(row.salePrice),
  }));
};

const linesOf = (ids: number[]) =>
  asAdmin(async (tx) => ({
    prices: await tx.productPriceChangeLog.count({ where: { productId: { in: ids } } }),
    admin: await tx.adminAuditLog.count({
      where: { entityType: 'product', entityId: { in: ids }, action: 'PRODUCT_SALE' },
    }),
  }));

describe('POST /api/products/sales with a sale for each product', () => {
  it('puts each product on its own sale and writes the logs of each', async () => {
    const first = await createProduct({ price: 20 });
    const second = await createProduct({ price: 50 });
    const endsAt = inMs(DAY);

    const res = await postSales({
      items: [
        { productId: second.id, sale: { amount: 5, endsAt } },
        { productId: first.id, sale: { percent: 25, endsAt } },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().products).toEqual([
      expect.objectContaining({ id: second.id, price: 50, salePrice: 45, status: 'set' }),
      expect.objectContaining({ id: first.id, price: 20, salePrice: 15, status: 'set' }),
    ]);
    expect(await salesOf([first.id, second.id])).toEqual([
      { id: first.id, salePrice: 15 },
      { id: second.id, salePrice: 45 },
    ]);
    expect(await linesOf([first.id, second.id])).toEqual({ prices: 2, admin: 2 });
  });

  it('puts nothing on when a sale of one product does not fit its price', async () => {
    const cheap = await createProduct({ price: 4 });
    const other = await createProduct({ price: 20 });
    const endsAt = inMs(DAY);

    const res = await postSales({
      items: [
        { productId: other.id, sale: { percent: 10, endsAt } },
        { productId: cheap.id, sale: { amount: 5, endsAt } },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { products: [{ productId: cheap.id, price: 4 }] },
    });
    expect(await salesOf([cheap.id, other.id])).toEqual(
      [
        { id: cheap.id, salePrice: null },
        { id: other.id, salePrice: null },
      ].sort((a, b) => a.id - b.id),
    );
    expect(await linesOf([cheap.id, other.id])).toEqual({ prices: 0, admin: 0 });
  });

  it('answers 404 with the products that are not in the catalog', async () => {
    const product = await createProduct({ price: 20 });
    const gone = await createProduct({ price: 20 });
    await deleteProductFromCatalog(gone.id);

    const res = await postSales({
      items: [
        { productId: product.id, sale: { percent: 10, endsAt: inMs(DAY) } },
        { productId: gone.id, sale: { percent: 10, endsAt: inMs(DAY) } },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_NOT_FOUND',
      details: { productIds: [gone.id] },
    });
    expect(await salesOf([product.id])).toEqual([{ id: product.id, salePrice: null }]);
  });

  it('refuses a product named twice', async () => {
    const product = await createProduct({ price: 20 });

    const res = await postSales({
      items: [
        { productId: product.id, sale: { percent: 10, endsAt: inMs(DAY) } },
        { productId: product.id, sale: { percent: 20, endsAt: inMs(DAY) } },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'SALE_PRODUCTS_REPEATED',
      details: { productIds: [product.id] },
    });
  });

  it('refuses an end that is not ahead', async () => {
    const product = await createProduct({ price: 20 });

    const res = await postSales({
      items: [{ productId: product.id, sale: { percent: 10, endsAt: inMs(-DAY) } }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID' });
  });

  it('leaves a product with the same sale as it is', async () => {
    const product = await createProduct({ price: 20 });
    const payload = {
      items: [{ productId: product.id, sale: { percent: 10, endsAt: inMs(DAY) } }],
    };
    await postSales(payload);

    const res = await postSales(payload);

    expect(res.statusCode).toBe(200);
    expect(res.json().products).toEqual([
      expect.objectContaining({ id: product.id, salePrice: 18, status: 'unchanged' }),
    ]);
    expect(await linesOf([product.id])).toEqual({ prices: 1, admin: 1 });
  });

  it('refuses a user', async () => {
    const product = await createProduct({ price: 20 });

    const res = await postSales(
      { items: [{ productId: product.id, sale: { percent: 10, endsAt: inMs(DAY) } }] },
      buyer,
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('refuses a body with no items, or with items and a category', async () => {
    const product = await createProduct({ price: 20 });
    const sale = { percent: 10, endsAt: inMs(DAY) };

    for (const payload of [
      { items: [] },
      { items: [{ productId: product.id, sale }], categoryId: product.categoryId, sale },
    ]) {
      const res = await postSales(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
  });
});

describe('POST /api/products/sales for a category', () => {
  // Lamps > Desk lamps: a product in each, one taken out of the catalog
  async function lamps() {
    const tag = uniqueTag();
    const top = await createCategory({ name: `Lamps ${tag}` });
    const desk = await createCategory({ name: `Desk lamps ${tag}`, parentId: top.id });
    const floor = await createProduct({ price: 40, categoryId: top.id });
    const small = await createProduct({ price: 20, categoryId: desk.id });
    const gone = await createProduct({ price: 30, categoryId: desk.id });
    await deleteProductFromCatalog(gone.id);
    return { top, desk, floor, small, gone };
  }

  it('puts the products of the catalog of the whole branch on one sale', async () => {
    const { top, floor, small, gone } = await lamps();

    const res = await postSales({
      categoryId: top.id,
      sale: { percent: 10, endsAt: inMs(DAY) },
    });

    expect(res.statusCode).toBe(200);
    expect(
      res
        .json()
        .products.map((p: { id: number }) => p.id)
        .sort(),
    ).toEqual([floor.id, small.id].sort());
    expect(await salesOf([floor.id, small.id, gone.id])).toEqual(
      [
        { id: floor.id, salePrice: 36 },
        { id: small.id, salePrice: 18 },
        { id: gone.id, salePrice: null },
      ].sort((a, b) => a.id - b.id),
    );
  });

  it('puts only the products of the category itself on sale with branch=false', async () => {
    const { top, floor, small } = await lamps();

    const res = await postSales({
      categoryId: top.id,
      branch: false,
      sale: { percent: 10, endsAt: inMs(DAY) },
    });

    expect(res.json().products.map((p: { id: number }) => p.id)).toEqual([floor.id]);
    expect(await salesOf([small.id])).toEqual([{ id: small.id, salePrice: null }]);
  });

  it('puts nothing on when the amount is above the price of a product of the category', async () => {
    const { top, floor, small } = await lamps();

    const res = await postSales({ categoryId: top.id, sale: { amount: 25, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { products: [{ productId: small.id, price: 20 }] },
    });
    expect(await salesOf([floor.id])).toEqual([{ id: floor.id, salePrice: null }]);
  });

  it('answers 404 for a category that does not exist', async () => {
    const res = await postSales({
      categoryId: 2_000_000_000,
      sale: { percent: 10, endsAt: inMs(DAY) },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_NOT_FOUND' });
  });

  it('puts nothing on and answers an empty list for a category without products', async () => {
    const empty = await createCategory({ name: `Empty ${uniqueTag()}` });

    const res = await postSales({ categoryId: empty.id, sale: { percent: 10, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ products: [] });
  });
});
