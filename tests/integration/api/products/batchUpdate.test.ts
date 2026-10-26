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
import { productSafety } from '../../../helpers/productSafety.js';

// PATCH /api/products/batch changes many products at once, each with fields of its own, all of
// them or none: the change of each is the one of PATCH /api/products/:productId, with its checks,
// the steps of its sale and every line of the logs, without images. A refusal names in
// details.products every product refused the same way, and nothing is changed. The rows are
// locked by id, so two such requests over the same products wait for each other

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;

const DAY = 86_400_000;
const MISSING_ID = 2_000_000_000;

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
const sku = () => `SKU-${uniqueTag()}`;

const patchBatch = (payload: Record<string, unknown>, actor: TestUser = admin) =>
  app.inject({
    method: 'PATCH',
    url: '/api/products/batch',
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

// a product on a sale of 25% off 20 through the sale route, with its lines of the logs
const productOnSale = async () => {
  const product = await createProduct({ price: 20 });
  const endsAt = inMs(DAY);
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/products/${product.id}/sale`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { sale: { percent: 25, endsAt } },
  });
  expect(res.statusCode).toBe(200);
  return { product, endsAt };
};

const rowsOf = async (ids: number[]) => {
  const rows = await asAdmin((tx) =>
    tx.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, sku: true, price: true, salePrice: true, categoryId: true },
    }),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id)!;
    return {
      id,
      name: row.name,
      sku: row.sku,
      price: Number(row.price),
      salePrice: row.salePrice === null ? null : Number(row.salePrice),
      categoryId: row.categoryId,
    };
  });
};

const priceLogOf = async (productId: number) => {
  const lines = await asAdmin((tx) =>
    tx.productPriceChangeLog.findMany({
      where: { productId },
      orderBy: { id: 'asc' },
      select: { mode: true, oldPrice: true, newPrice: true },
    }),
  );
  return lines.map((line) => [line.mode, Number(line.oldPrice), Number(line.newPrice)]);
};

const productUpdatesOf = (productId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'product', entityId: productId, action: 'PRODUCT_UPDATE' },
      orderBy: { id: 'asc' },
      select: { actorId: true, meta: true },
    }),
  );

const fieldsOf = (meta: unknown) => (meta as Array<{ field: string }>).map((c) => c.field).sort();

describe('PATCH /api/products/batch', () => {
  it('changes each product with fields of its own and writes the logs of each', async () => {
    const first = await createProduct({ price: 20 });
    const second = await createProduct({ price: 30 });
    const category = await createCategory();
    const name = `Batch product ${uniqueTag()}`;
    const code = sku();

    // the order of the request is no order of ids: the answer keeps the one of the request
    const res = await patchBatch({
      items: [
        { productId: second.id, name, sku: code, categoryId: category.id },
        { productId: first.id, price: 25, safety: productSafety },
      ],
    });

    expect(res.statusCode).toBe(200);
    const products = res.json().products as Array<Record<string, unknown>>;
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({
      id: second.id,
      name,
      sku: code,
      price: 30,
      category: { id: category.id, name: category.name },
      lastUnitCost: 1,
    });
    expect(products[0]).toHaveProperty('totalStock', 5);
    expect(products[1]).toMatchObject({
      id: first.id,
      price: 25,
      safety: { manufacturer: productSafety.manufacturer },
    });

    expect(await rowsOf([first.id, second.id])).toEqual([
      expect.objectContaining({ id: first.id, price: 25 }),
      expect.objectContaining({ id: second.id, name, sku: code, categoryId: category.id }),
    ]);
    expect(await priceLogOf(first.id)).toEqual([['fixed', 20, 25]]);
    expect(await priceLogOf(second.id)).toEqual([]);

    const [firstLine] = await productUpdatesOf(first.id);
    const [secondLine] = await productUpdatesOf(second.id);
    expect(firstLine!.actorId).toBe(admin.id);
    expect(fieldsOf(firstLine!.meta)).toEqual(['price', 'safety']);
    expect(fieldsOf(secondLine!.meta)).toEqual(['categoryId', 'name', 'sku']);
  });

  it('takes a word on the sale of each product on sale: keep, off, or a new sale', async () => {
    const kept = await productOnSale();
    const off = await productOnSale();
    const renewed = await productOnSale();
    const newEnd = inMs(2 * DAY);

    const res = await patchBatch({
      items: [
        { productId: kept.product.id, price: 25, sale: 'keep' },
        { productId: off.product.id, price: 25, sale: null },
        { productId: renewed.product.id, price: 40, sale: { percent: 10, endsAt: newEnd } },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().products).toEqual([
      expect.objectContaining({ id: kept.product.id, price: 25, salePrice: 15 }),
      expect.objectContaining({ id: off.product.id, price: 25, salePrice: null }),
      expect.objectContaining({
        id: renewed.product.id,
        price: 40,
        salePrice: 36,
        saleEndsAt: newEnd,
      }),
    ]);

    expect(await priceLogOf(kept.product.id)).toEqual([
      ['percent', 20, 15],
      ['fixed', 20, 25],
    ]);
    expect(await priceLogOf(off.product.id)).toEqual([
      ['percent', 20, 15],
      ['fixed', 15, 20],
      ['fixed', 20, 25],
    ]);
    expect(await priceLogOf(renewed.product.id)).toEqual([
      ['percent', 20, 15],
      ['fixed', 15, 20],
      ['fixed', 20, 40],
      ['percent', 40, 36],
    ]);
  });

  it('changes nothing and names every product on sale that got a price without a word', async () => {
    const plain = await createProduct({ price: 20 });
    const first = await productOnSale();
    const second = await productOnSale();
    const name = `Kept name ${uniqueTag()}`;

    const res = await patchBatch({
      items: [
        { productId: plain.id, name },
        { productId: first.product.id, price: 25 },
        { productId: second.product.id, price: 26 },
      ],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_DECISION_REQUIRED',
      details: {
        products: [
          { productId: first.product.id, salePrice: 15, saleEndsAt: first.endsAt },
          { productId: second.product.id, salePrice: 15, saleEndsAt: second.endsAt },
        ],
      },
    });
    const [plainRow, ...onSale] = await rowsOf([plain.id, first.product.id, second.product.id]);
    expect(plainRow!.name).not.toBe(name);
    expect(onSale.map((row) => [row.price, row.salePrice])).toEqual([
      [20, 15],
      [20, 15],
    ]);
    expect(await productUpdatesOf(plain.id)).toEqual([]);
    expect(await priceLogOf(first.product.id)).toEqual([['percent', 20, 15]]);
  });

  it('refuses keep for a price down to the sale price', async () => {
    const { product } = await productOnSale();
    const other = await createProduct({ price: 20 });

    const res = await patchBatch({
      items: [
        { productId: other.id, price: 21 },
        { productId: product.id, price: 15, sale: 'keep' },
      ],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_NOT_BELOW_PRICE',
      details: { products: [{ productId: product.id, salePrice: 15, price: 15 }] },
    });
    expect(await priceLogOf(other.id)).toEqual([]);
  });

  it('puts nothing on when a new sale does not fit the new price', async () => {
    const product = await createProduct({ price: 20 });
    const other = await createProduct({ price: 20 });

    const res = await patchBatch({
      items: [
        { productId: other.id, price: 30 },
        { productId: product.id, price: 4, sale: { amount: 5, endsAt: inMs(DAY) } },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { products: [{ productId: product.id, price: 4 }] },
    });
    expect((await rowsOf([product.id, other.id])).map((row) => row.price)).toEqual([20, 20]);
    expect(await priceLogOf(product.id)).toEqual([]);
    expect(await priceLogOf(other.id)).toEqual([]);
  });

  it('swaps the article numbers of two products, the admin log keeps old and new', async () => {
    const first = await createProduct();
    const second = await createProduct();
    const [firstCode, secondCode] = [sku(), sku()];
    await asAdmin(async (tx) => {
      await tx.product.update({ where: { id: first.id }, data: { sku: firstCode } });
      await tx.product.update({ where: { id: second.id }, data: { sku: secondCode } });
    });

    const res = await patchBatch({
      items: [
        { productId: first.id, sku: secondCode },
        { productId: second.id, sku: firstCode },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect((await rowsOf([first.id, second.id])).map((row) => row.sku)).toEqual([
      secondCode,
      firstCode,
    ]);
    expect((await productUpdatesOf(first.id)).map((line) => line.meta)).toEqual([
      [{ field: 'sku', old: firstCode, new: secondCode }],
    ]);
  });

  it('gives a product the article number of a product removed from the catalog', async () => {
    const gone = await createProduct();
    const product = await createProduct();
    const code = sku();
    await asAdmin((tx) => tx.product.update({ where: { id: gone.id }, data: { sku: code } }));
    await deleteProductFromCatalog(gone.id);

    const res = await patchBatch({ items: [{ productId: product.id, sku: code }] });

    expect(res.statusCode).toBe(200);
    expect(res.json().products).toEqual([expect.objectContaining({ id: product.id, sku: code })]);
  });

  it('refuses an article number another product has and one two products of it take', async () => {
    const holder = await createProduct();
    const [first, second, third] = [
      await createProduct(),
      await createProduct(),
      await createProduct(),
    ];
    const held = sku();
    const twice = sku();
    await asAdmin((tx) => tx.product.update({ where: { id: holder.id }, data: { sku: held } }));

    const res = await patchBatch({
      items: [
        { productId: first.id, sku: held.toLowerCase() },
        { productId: second.id, sku: twice },
        { productId: third.id, sku: ` ${twice.toLowerCase()} ` },
      ],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SKU_TAKEN',
      details: {
        products: [{ productId: first.id }, { productId: second.id }, { productId: third.id }],
      },
    });
    expect((await rowsOf([first.id, second.id, third.id])).map((row) => row.sku)).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('answers 404 with the products it cannot change', async () => {
    const product = await createProduct({ price: 20 });
    const gone = await createProduct({ price: 20 });
    await deleteProductFromCatalog(gone.id);

    const res = await patchBatch({
      items: [
        { productId: product.id, price: 21 },
        { productId: MISSING_ID, name: 'Nobody' },
        // a new sale goes on a product of the catalog only
        { productId: gone.id, price: 30, sale: { percent: 10, endsAt: inMs(DAY) } },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_NOT_FOUND',
      details: { products: [{ productId: MISSING_ID }, { productId: gone.id }] },
    });
    expect((await rowsOf([product.id])).map((row) => row.price)).toEqual([20]);
  });

  it('answers 404 for a category that is not there', async () => {
    const product = await createProduct();
    const other = await createProduct({ price: 20 });

    const res = await patchBatch({
      items: [
        { productId: other.id, price: 21 },
        { productId: product.id, categoryId: MISSING_ID },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'CATEGORY_NOT_FOUND',
      details: { products: [{ productId: product.id }] },
    });
    expect(await priceLogOf(other.id)).toEqual([]);
  });

  it.each([
    ['nothing to change', {}, 'NO_FIELDS_TO_UPDATE'],
    ['a stock', { stock: 5 }, 'PRODUCT_STOCK_NOT_ALLOWED'],
    ['a word on the sale without a price', { sale: 'keep' }, 'PRODUCT_SALE_REQUIRES_PRICE'],
    ['a name of spaces', { name: '   ' }, 'PRODUCT_NAME_INVALID'],
    [
      'an override without its end',
      { popularityOverride: 5 },
      'POPULARITY_OVERRIDE_UNTIL_REQUIRED',
    ],
  ])('refuses %s with the product it holds for, and changes nothing', async (_, fields, code) => {
    const fine = await createProduct({ price: 20 });
    const refused = await createProduct({ price: 20 });

    const res = await patchBatch({
      items: [
        { productId: fine.id, price: 21 },
        { productId: refused.id, ...fields },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: code,
      details: { products: [{ productId: refused.id }] },
    });
    expect((await rowsOf([fine.id])).map((row) => row.price)).toEqual([20]);
  });

  it('refuses a product named twice', async () => {
    const product = await createProduct();

    const res = await patchBatch({
      items: [
        { productId: product.id, name: 'One' },
        { productId: product.id, name: 'Two' },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCTS_REPEATED',
      details: { productIds: [product.id] },
    });
  });

  it('refuses an empty list and more than 100 products', async () => {
    const many = Array.from({ length: 101 }, (_, index) => ({ productId: index + 1, name: 'x' }));

    for (const items of [[], many]) {
      const res = await patchBatch({ items });

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toBe('VALIDATION_ERROR');
    }
  });

  it('lets only an admin or root change products', async () => {
    const product = await createProduct();

    const res = await patchBatch({ items: [{ productId: product.id, name: 'Mine' }] }, buyer);

    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe('INSUFFICIENT_ROLE');
  });

  it('answers with the card of a product without an image', async () => {
    const product = await createProduct();
    await asAdmin((tx) => tx.productImage.deleteMany({ where: { productId: product.id } }));
    const name = `Bare ${uniqueTag()}`;

    const res = await patchBatch({ items: [{ productId: product.id, name }] });

    expect(res.statusCode).toBe(200);
    expect(res.json().products).toEqual([
      expect.objectContaining({ id: product.id, name, images: [] }),
    ]);
  });

  it('lets two requests over the same products in another order both go through', async () => {
    const first = await createProduct({ price: 20 });
    const second = await createProduct({ price: 20 });
    const [firstName, secondName] = [`First ${uniqueTag()}`, `Second ${uniqueTag()}`];

    const [prices, names] = await Promise.all([
      patchBatch({
        items: [
          { productId: first.id, price: 21 },
          { productId: second.id, price: 22 },
        ],
      }),
      patchBatch({
        items: [
          { productId: second.id, name: secondName },
          { productId: first.id, name: firstName },
        ],
      }),
    ]);

    expect([prices.statusCode, names.statusCode]).toEqual([200, 200]);
    expect(await rowsOf([first.id, second.id])).toEqual([
      expect.objectContaining({ name: firstName, price: 21 }),
      expect.objectContaining({ name: secondName, price: 22 }),
    ]);
  });
});
