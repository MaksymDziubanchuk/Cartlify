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
  createVariant,
  deleteProductFromCatalog,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { markVariantDeleted } from '../../../helpers/variants.js';

// POST /api/products/sales puts sales on many variants at once, all of them or none: each variant
// with a sale of its own, or all the variants of a product, or one sale for the variants of the
// products of the catalog of a category and its branch. Each sale is the one of
// PATCH /api/products/:productId/sale, with every line of the logs, counted from the price of its
// variant; a variant that has the same sale already stays as it is

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

// the sale price of each variant, by id
const salesOf = async (ids: number[]) => {
  const rows = await asAdmin((tx) =>
    tx.productVariant.findMany({
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
    prices: await tx.productPriceChangeLog.count({ where: { variantId: { in: ids } } }),
    admin: await tx.adminAuditLog.count({
      where: { entityType: 'variant', entityId: { in: ids }, action: 'PRODUCT_SALE' },
    }),
  }));

const idsOfAnswer = (res: { json: () => { variants: Array<{ id: number }> } }) =>
  res.json().variants.map((variant) => variant.id);

describe('POST /api/products/sales with a sale for each variant', () => {
  it('puts each variant on its own sale and writes the logs of each', async () => {
    const first = await createProduct({ price: 20 });
    const second = await createProduct({ price: 50 });
    const endsAt = inMs(DAY);

    const res = await postSales({
      items: [
        { variantId: second.variantId, sale: { amount: 5, endsAt } },
        { variantId: first.variantId, sale: { percent: 25, endsAt } },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      expect.objectContaining({
        id: second.variantId,
        productId: second.id,
        name: expect.any(String),
        price: 50,
        salePrice: 45,
        saleEndsAt: endsAt,
        salePriorPrice: 50,
        status: 'set',
      }),
      expect.objectContaining({
        id: first.variantId,
        productId: first.id,
        price: 20,
        salePrice: 15,
        status: 'set',
      }),
    ]);
    expect(await salesOf([first.variantId, second.variantId])).toEqual([
      { id: first.variantId, salePrice: 15 },
      { id: second.variantId, salePrice: 45 },
    ]);
    expect(await linesOf([first.variantId, second.variantId])).toEqual({ prices: 2, admin: 2 });
  });

  it('writes the lines of the admin log about the variant, with the event of the route of many', async () => {
    const product = await createProduct({ price: 20 });

    await postSales({
      items: [{ variantId: product.variantId, sale: { percent: 10, endsAt: inMs(DAY) } }],
    });

    const [line] = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'variant', entityId: product.variantId, action: 'PRODUCT_SALE' },
        select: { event: true, actorId: true },
      }),
    );
    expect(line).toEqual({ event: 'product.sale_set_bulk', actorId: admin.id });
  });

  it('puts nothing on when a sale of one variant does not fit its price', async () => {
    const cheap = await createProduct({ price: 4 });
    const other = await createProduct({ price: 20 });
    const endsAt = inMs(DAY);

    const res = await postSales({
      items: [
        { variantId: other.variantId, sale: { percent: 10, endsAt } },
        { variantId: cheap.variantId, sale: { amount: 5, endsAt } },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { variants: [{ variantId: cheap.variantId, price: 4 }] },
    });
    expect(await salesOf([cheap.variantId, other.variantId])).toEqual(
      [
        { id: cheap.variantId, salePrice: null },
        { id: other.variantId, salePrice: null },
      ].sort((a, b) => a.id - b.id),
    );
    expect(await linesOf([cheap.variantId, other.variantId])).toEqual({ prices: 0, admin: 0 });
  });

  it('names every variant a sale comes to nothing for', async () => {
    const free = await createProduct({ price: 0 });
    const few = await createProduct({ price: 0.05 });
    const fine = await createProduct({ price: 20 });
    const endsAt = inMs(DAY);

    const res = await postSales({
      items: [
        { variantId: free.variantId, sale: { percent: 50, endsAt } },
        { variantId: few.variantId, sale: { percent: 1, endsAt } },
        { variantId: fine.variantId, sale: { percent: 50, endsAt } },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_TOO_SMALL',
      details: { variants: [{ variantId: free.variantId }, { variantId: few.variantId }] },
    });
    expect((await salesOf([fine.variantId]))[0]!.salePrice).toBeNull();
  });

  it('answers 404 with the variants that are not for sale', async () => {
    const product = await createProduct({ price: 20 });
    const gone = await createProduct({ price: 20 });
    await deleteProductFromCatalog(gone.id);
    const out = await createVariant(product.id, { price: 20 });
    await markVariantDeleted(out.id);

    const res = await postSales({
      items: [
        { variantId: product.variantId, sale: { percent: 10, endsAt: inMs(DAY) } },
        { variantId: gone.variantId, sale: { percent: 10, endsAt: inMs(DAY) } },
        { variantId: out.id, sale: { percent: 10, endsAt: inMs(DAY) } },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANT_NOT_FOUND',
      details: { variantIds: [gone.variantId, out.id].sort((a, b) => a - b) },
    });
    expect(await salesOf([product.variantId])).toEqual([
      { id: product.variantId, salePrice: null },
    ]);
  });

  it('refuses a variant named twice', async () => {
    const product = await createProduct({ price: 20 });

    const res = await postSales({
      items: [
        { variantId: product.variantId, sale: { percent: 10, endsAt: inMs(DAY) } },
        { variantId: product.variantId, sale: { percent: 20, endsAt: inMs(DAY) } },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'SALE_VARIANTS_REPEATED',
      details: { variantIds: [product.variantId] },
    });
  });

  it('refuses an end that is not ahead, naming the item', async () => {
    const product = await createProduct({ price: 20 });

    const res = await postSales({
      items: [
        { variantId: product.variantId, sale: { percent: 10, endsAt: inMs(DAY) } },
        { productId: product.id, sale: { percent: 10, endsAt: inMs(-DAY) } },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID',
      details: { items: [{ index: 1, productId: product.id }] },
    });
  });

  it('names the variant of an item whose end is not ahead', async () => {
    const product = await createProduct({ price: 20 });

    const res = await postSales({
      items: [{ variantId: product.variantId, sale: { percent: 10, endsAt: inMs(-DAY) } }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID',
      details: { items: [{ index: 0, variantId: product.variantId }] },
    });
  });

  it('leaves a variant with the same sale as it is', async () => {
    const product = await createProduct({ price: 20 });
    const payload = {
      items: [{ variantId: product.variantId, sale: { percent: 10, endsAt: inMs(DAY) } }],
    };
    await postSales(payload);

    const res = await postSales(payload);

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      expect.objectContaining({ id: product.variantId, salePrice: 18, status: 'unchanged' }),
    ]);
    expect(await linesOf([product.variantId])).toEqual({ prices: 1, admin: 1 });
  });

  it('refuses a user', async () => {
    const product = await createProduct({ price: 20 });

    const res = await postSales(
      { items: [{ variantId: product.variantId, sale: { percent: 10, endsAt: inMs(DAY) } }] },
      buyer,
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('refuses a body with no items, with items and a category, or with an item that names no variant or two things', async () => {
    const product = await createProduct({ price: 20 });
    const sale = { percent: 10, endsAt: inMs(DAY) };

    for (const payload of [
      { items: [] },
      { items: [{ variantId: product.variantId, sale }], categoryId: product.categoryId, sale },
      { items: [{ sale }] },
      { items: [{ variantId: product.variantId, productId: product.id, sale }] },
      { items: [{ variantId: product.variantId }] },
    ]) {
      const res = await postSales(payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
  });
});

describe('POST /api/products/sales with a sale for a product', () => {
  it('puts all the variants for sale of the product on the sale, each from its own price', async () => {
    const product = await createProduct({ price: 20 });
    const second = await createVariant(product.id, { price: 40 });
    const out = await createVariant(product.id, { price: 60 });
    await markVariantDeleted(out.id);
    const endsAt = inMs(DAY);

    const res = await postSales({
      items: [{ productId: product.id, sale: { percent: 25, endsAt } }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      expect.objectContaining({ id: product.variantId, price: 20, salePrice: 15, status: 'set' }),
      expect.objectContaining({ id: second.id, price: 40, salePrice: 30, status: 'set' }),
    ]);
    expect(await salesOf([out.id])).toEqual([{ id: out.id, salePrice: null }]);
  });

  it('takes an item of a variant and an item of a product together', async () => {
    const product = await createProduct({ price: 20 });
    const second = await createVariant(product.id, { price: 40 });
    const other = await createProduct({ price: 10 });
    const endsAt = inMs(DAY);

    const res = await postSales({
      items: [
        { variantId: other.variantId, sale: { amount: 2, endsAt } },
        { productId: product.id, sale: { amount: 5, endsAt } },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(idsOfAnswer(res)).toEqual([other.variantId, product.variantId, second.id]);
    expect((await salesOf([product.variantId, second.id])).map((row) => row.salePrice)).toEqual([
      15, 35,
    ]);
  });

  it('refuses a variant named by itself and by its product', async () => {
    const product = await createProduct({ price: 20 });
    await createVariant(product.id, { price: 40 });
    const sale = { percent: 10, endsAt: inMs(DAY) };

    const res = await postSales({
      items: [
        { productId: product.id, sale },
        { variantId: product.variantId, sale },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'SALE_VARIANTS_REPEATED',
      details: { variantIds: [product.variantId] },
    });
  });

  it('refuses a product named twice', async () => {
    const product = await createProduct({ price: 20 });
    const sale = { percent: 10, endsAt: inMs(DAY) };

    const res = await postSales({
      items: [
        { productId: product.id, sale },
        { productId: product.id, sale: { percent: 20, endsAt: inMs(DAY) } },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SALE_VARIANTS_REPEATED' });
  });

  it('puts nothing on when an amount is above the price of one variant of the product', async () => {
    const product = await createProduct({ price: 20 });
    const cheap = await createVariant(product.id, { price: 3 });

    const res = await postSales({
      items: [{ productId: product.id, sale: { amount: 5, endsAt: inMs(DAY) } }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { variants: [{ variantId: cheap.id, price: 3 }] },
    });
    expect(await salesOf([product.variantId, cheap.id])).toEqual([
      { id: product.variantId, salePrice: null },
      { id: cheap.id, salePrice: null },
    ]);
  });

  it('answers 404 with the products that are not in the catalog', async () => {
    const product = await createProduct({ price: 20 });
    const gone = await createProduct({ price: 20 });
    await deleteProductFromCatalog(gone.id);

    const res = await postSales({
      items: [
        { productId: product.id, sale: { percent: 10, endsAt: inMs(DAY) } },
        { productId: gone.id, sale: { percent: 10, endsAt: inMs(DAY) } },
        { productId: 2_000_000_000, sale: { percent: 10, endsAt: inMs(DAY) } },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_NOT_FOUND',
      details: { productIds: [gone.id, 2_000_000_000] },
    });
    expect(await salesOf([product.variantId])).toEqual([
      { id: product.variantId, salePrice: null },
    ]);
  });

  it('answers 404 for a product none of whose variants is for sale', async () => {
    const product = await createProduct({ price: 20 });
    const bare = await createProduct({ price: 20 });
    await markVariantDeleted(bare.variantId);

    const res = await postSales({
      items: [
        { productId: product.id, sale: { percent: 10, endsAt: inMs(DAY) } },
        { productId: bare.id, sale: { percent: 10, endsAt: inMs(DAY) } },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANT_NOT_FOUND',
      details: { productIds: [bare.id] },
    });
    expect((await salesOf([product.variantId]))[0]!.salePrice).toBeNull();
  });
});

describe('POST /api/products/sales for a category', () => {
  // Lamps > Desk lamps: a product in each, one taken out of the catalog, and a variant taken out of
  // sale next to a variant for sale
  async function lamps() {
    const tag = uniqueTag();
    const top = await createCategory({ name: `Lamps ${tag}` });
    const desk = await createCategory({ name: `Desk lamps ${tag}`, parentId: top.id });
    const floor = await createProduct({ price: 40, categoryId: top.id });
    const small = await createProduct({ price: 20, categoryId: desk.id });
    const smallBlue = await createVariant(small.id, { price: 30 });
    const smallOut = await createVariant(small.id, { price: 50 });
    await markVariantDeleted(smallOut.id);
    const gone = await createProduct({ price: 30, categoryId: desk.id });
    await deleteProductFromCatalog(gone.id);
    return { top, desk, floor, small, smallBlue, smallOut, gone };
  }

  it('puts the variants of the products of the catalog of the whole branch on one sale', async () => {
    const { top, floor, small, smallBlue, smallOut, gone } = await lamps();

    const res = await postSales({
      categoryId: top.id,
      sale: { percent: 10, endsAt: inMs(DAY) },
    });

    expect(res.statusCode).toBe(200);
    expect(idsOfAnswer(res).sort((a, b) => a - b)).toEqual(
      [floor.variantId, small.variantId, smallBlue.id].sort((a, b) => a - b),
    );
    expect(
      await salesOf([floor.variantId, small.variantId, smallBlue.id, smallOut.id, gone.variantId]),
    ).toEqual(
      [
        { id: floor.variantId, salePrice: 36 },
        { id: small.variantId, salePrice: 18 },
        { id: smallBlue.id, salePrice: 27 },
        { id: smallOut.id, salePrice: null },
        { id: gone.variantId, salePrice: null },
      ].sort((a, b) => a.id - b.id),
    );
  });

  it('puts only the variants of the products of the category itself on sale with branch=false', async () => {
    const { top, floor, small } = await lamps();

    const res = await postSales({
      categoryId: top.id,
      branch: false,
      sale: { percent: 10, endsAt: inMs(DAY) },
    });

    expect(idsOfAnswer(res)).toEqual([floor.variantId]);
    expect(await salesOf([small.variantId])).toEqual([{ id: small.variantId, salePrice: null }]);
  });

  it('puts nothing on when the amount is above the price of a variant of the category', async () => {
    const { top, floor, small } = await lamps();

    const res = await postSales({ categoryId: top.id, sale: { amount: 25, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { variants: [{ variantId: small.variantId, price: 20 }] },
    });
    expect(await salesOf([floor.variantId])).toEqual([{ id: floor.variantId, salePrice: null }]);
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
    expect(res.json()).toEqual({ variants: [] });
  });

  it('refuses an end that is not ahead', async () => {
    const empty = await createCategory({ name: `Late ${uniqueTag()}` });

    const res = await postSales({
      categoryId: empty.id,
      sale: { percent: 10, endsAt: inMs(-DAY) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID' });
  });
});
