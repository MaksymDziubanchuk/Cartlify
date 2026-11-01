import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { shopToday } from '@helpers/shopDay.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, inCommittedTx } from '../../../helpers/db.js';
import { cartOf, waitingOrderOf } from '../../../helpers/dbOrders.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  putOnSale,
  receiveBatch,
  waitForSalesEnd,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { moveClock } from '../../../helpers/payments.js';
import {
  markVariantDeleted,
  priceLinesOf,
  priceRowOf,
  saleAuditOf,
} from '../../../helpers/variants.js';

// PATCH /api/products: the prices of many variants at once, the variants that fit the filter of the
// scope. A dry run lists them with their old and new price. The sales that are on get one word

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
// an order keeps its variant, so the products stay; the test database goes after the run
const products: TestProduct[] = [];
let clock: { restore: () => void } | null = null;

const DAY = 86_400_000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

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

const bulk = (payload: Record<string, unknown>, actor: TestUser = admin) =>
  app.inject({
    method: 'PATCH',
    url: '/api/products',
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

const priceOf = async (variantId: number) => (await priceRowOf(variantId)).price;

const saleRoute = (productId: number, variantId: number, percent = 25) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/sale`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { variantIds: [variantId], sale: { percent, endsAt: inMs(DAY) } },
  });

describe('PATCH /api/products', () => {
  // 1.15 times 1.1 is 1.2649999 in floating point: the price came out 1.26
  it('counts a percent in cents, half up: 1.15 plus 10 percent is 1.27', async () => {
    const product = await newProduct({ price: 1.15, stock: 1 });

    const res = await bulk({
      mode: 'percent',
      value: 10,
      scope: { variantIds: [product.variantId] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'PRODUCTS_PRICE_BULK_UPDATED', updatedCount: 1 });
    expect(await priceOf(product.variantId)).toBe(1.27);
  });

  it('changes a variant by an amount, the line of the log of prices says so', async () => {
    const product = await newProduct({ price: 10, stock: 1 });

    const res = await bulk({
      mode: 'fixed',
      value: -2.5,
      scope: { variantIds: [product.variantId] },
    });

    expect(res.statusCode).toBe(200);
    expect(await priceOf(product.variantId)).toBe(7.5);
    expect(await priceLinesOf(product.variantId)).toEqual([
      {
        mode: 'fixed',
        oldPrice: 10,
        newPrice: 7.5,
        value: -2.5,
        endsAt: null,
        actorId: admin.id,
        event: 'price.bulk',
        productId: product.id,
      },
    ]);
  });

  it('writes one line of the admin log for the whole change, with the reason', async () => {
    const product = await newProduct({ price: 10, stock: 1 });

    await bulk({
      mode: 'percent',
      value: 10,
      reason: 'Winter prices',
      scope: { variantIds: [product.variantId] },
    });

    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { event: 'product.price_bulk', actorId: admin.id },
        orderBy: { id: 'desc' },
        take: 1,
        select: { action: true, entityType: true, entityId: true, meta: true },
      }),
    );
    expect(lines[0]).toMatchObject({
      action: 'PRODUCT_PRICE_BULK_UPDATE',
      entityType: 'product',
      entityId: 0,
    });
    expect(lines[0]!.meta).toEqual(
      expect.arrayContaining([
        { field: 'mode', old: null, new: 'percent' },
        { field: 'value', old: null, new: 10 },
        { field: 'updatedCount', old: null, new: 1 },
        { field: 'reason', old: null, new: 'Winter prices' },
      ]),
    );
  });

  // the filter picks variants, not products: a product with other variants keeps their prices
  describe('picks the variants that fit the scope', () => {
    it('takes the variants named and leaves the others of their product', async () => {
      const product = await newProduct({ price: 10, stock: 1 });
      const second = await createVariant(product.id, { price: 20 });
      const third = await createVariant(product.id, { price: 30 });

      const res = await bulk({
        mode: 'fixed',
        value: 1,
        scope: { variantIds: [product.variantId, third.id] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().updatedCount).toBe(2);
      expect(await priceOf(product.variantId)).toBe(11);
      expect(await priceOf(second.id)).toBe(20);
      expect(await priceOf(third.id)).toBe(31);
    });

    it('takes every variant of the products named', async () => {
      const first = await newProduct({ price: 10, stock: 1 });
      const firstTwo = await createVariant(first.id, { price: 12 });
      const second = await newProduct({ price: 50, stock: 1 });
      const other = await newProduct({ price: 70, stock: 1 });

      const res = await bulk({
        mode: 'percent',
        value: 100,
        scope: { productIds: [first.id, second.id] },
      });

      expect(res.json().updatedCount).toBe(3);
      expect(await priceOf(first.variantId)).toBe(20);
      expect(await priceOf(firstTwo.id)).toBe(24);
      expect(await priceOf(second.variantId)).toBe(100);
      expect(await priceOf(other.variantId)).toBe(70);
    });

    it('takes the variants of the products of a category', async () => {
      const category = await createCategory();
      const inside = await newProduct({ price: 10, stock: 1, categoryId: category.id });
      const insideTwo = await createVariant(inside.id, { price: 20 });
      const outside = await newProduct({ price: 10, stock: 1 });

      const res = await bulk({ mode: 'fixed', value: 5, scope: { categoryId: category.id } });

      expect(res.json().updatedCount).toBe(2);
      expect(await priceOf(inside.variantId)).toBe(15);
      expect(await priceOf(insideTwo.id)).toBe(25);
      expect(await priceOf(outside.variantId)).toBe(10);
    });

    // the bounds are the usual price of each variant: a product with variants at 10 and 100 keeps
    // the one outside the bounds
    it('takes the variants whose usual price is within the bounds', async () => {
      const category = await createCategory();
      const cheap = await newProduct({ price: 10, stock: 1, categoryId: category.id });
      const dear = await createVariant(cheap.id, { price: 100 });
      const middle = await createVariant(cheap.id, { price: 50 });

      const res = await bulk({
        mode: 'fixed',
        value: 1,
        scope: { categoryId: category.id, minPrice: 20, maxPrice: 60 },
      });

      expect(res.json().updatedCount).toBe(1);
      expect(await priceOf(middle.id)).toBe(51);
      expect(await priceOf(cheap.variantId)).toBe(10);
      expect(await priceOf(dear.id)).toBe(100);
    });

    it('counts the bounds on the usual price, not on the sale price', async () => {
      const category = await createCategory();
      const product = await newProduct({ price: 100, stock: 1, categoryId: category.id });
      await saleRoute(product.id, product.variantId, 90);

      const res = await bulk({
        mode: 'fixed',
        value: 1,
        sale: 'keep',
        scope: { categoryId: category.id, maxPrice: 20 },
      });

      expect(res.json().updatedCount).toBe(0);
      expect(await priceOf(product.variantId)).toBe(100);
    });

    it('leaves out the variants taken out of sale, and those of a deleted product', async () => {
      const category = await createCategory();
      const product = await newProduct({ price: 10, stock: 1, categoryId: category.id });
      const out = await createVariant(product.id, { price: 20 });
      await markVariantDeleted(out.id);
      const gone = await newProduct({ price: 30, stock: 1, categoryId: category.id });
      await deleteProductFromCatalog(gone.id);

      const res = await bulk({ mode: 'fixed', value: 1, scope: { categoryId: category.id } });

      expect(res.json().updatedCount).toBe(1);
      expect(await priceOf(product.variantId)).toBe(11);
      expect(await priceOf(out.id)).toBe(20);
      expect(await priceOf(gone.variantId)).toBe(30);
    });

    it('takes only the variants taken out of sale when the scope asks for them', async () => {
      const category = await createCategory();
      const product = await newProduct({ price: 10, stock: 1, categoryId: category.id });
      const out = await createVariant(product.id, { price: 20 });
      await markVariantDeleted(out.id);
      const gone = await newProduct({ price: 30, stock: 1, categoryId: category.id });
      await deleteProductFromCatalog(gone.id);

      const res = await bulk({
        mode: 'fixed',
        value: 1,
        scope: { categoryId: category.id, deleted: true },
      });

      expect(res.json().updatedCount).toBe(2);
      expect(await priceOf(product.variantId)).toBe(10);
      expect(await priceOf(out.id)).toBe(21);
      expect(await priceOf(gone.variantId)).toBe(31);
    });

    it('combines the filters: the variants of the products named that fit the bounds', async () => {
      const first = await newProduct({ price: 10, stock: 1 });
      const firstDear = await createVariant(first.id, { price: 100 });
      const second = await newProduct({ price: 12, stock: 1 });

      const res = await bulk({
        mode: 'fixed',
        value: 1,
        scope: { productIds: [first.id], maxPrice: 50 },
      });

      expect(res.json().updatedCount).toBe(1);
      expect(await priceOf(first.variantId)).toBe(11);
      expect(await priceOf(firstDear.id)).toBe(100);
      expect(await priceOf(second.variantId)).toBe(12);
    });

    it('changes nothing and says so when no variant fits', async () => {
      const res = await bulk({
        mode: 'fixed',
        value: 1,
        scope: { variantIds: [2_000_000_000] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ message: 'PRODUCTS_PRICE_BULK_UPDATED', updatedCount: 0 });
    });
  });

  // in stock means what it means in the catalog: units free to buy, not the units the waiting
  // orders hold
  it('takes only the variants with free units when the scope asks for the ones in stock', async () => {
    const held = await newProduct({ price: 10, stock: 2 });
    await inCommittedTx((db) => waitingOrderOf(db, buyer.id, [[held.variantId, 2]]));
    const free = await newProduct({ price: 10, stock: 2 });

    const res = await bulk({
      mode: 'fixed',
      value: 1,
      scope: { variantIds: [held.variantId, free.variantId], inStock: true },
    });

    expect(res.statusCode).toBe(200);
    expect(await priceOf(held.variantId)).toBe(10);
    expect(await priceOf(free.variantId)).toBe(11);
  });

  it('takes the variants without free units when the scope asks for the ones out of stock', async () => {
    const held = await newProduct({ price: 10, stock: 2 });
    await inCommittedTx((db) => waitingOrderOf(db, buyer.id, [[held.variantId, 2]]));
    const free = await newProduct({ price: 10, stock: 2 });

    await bulk({
      mode: 'fixed',
      value: 1,
      scope: { variantIds: [held.variantId, free.variantId], inStock: false },
    });

    expect(await priceOf(held.variantId)).toBe(11);
    expect(await priceOf(free.variantId)).toBe(10);
  });

  // a variant in carts or with units past their day still gets its new price without the filter
  it('changes a variant held by orders and one with units over without the filter', async () => {
    const held = await newProduct({ price: 10, stock: 2 });
    await inCommittedTx((db) => cartOf(db, buyer.id, [[held.variantId, 2]]));
    const over = await newProduct({ price: 10, stock: 0 });
    await receiveBatch(over.id, { quantity: 3, expiresAt: shopToday() });
    clock = moveClock(2 * 86_400_000);

    const res = await bulk({
      mode: 'fixed',
      value: 1,
      scope: { variantIds: [held.variantId, over.variantId] },
    });

    expect(res.statusCode).toBe(200);
    expect(await priceOf(held.variantId)).toBe(11);
    expect(await priceOf(over.variantId)).toBe(11);
  });

  it('counts the units over as no free units', async () => {
    const over = await newProduct({ price: 10, stock: 0 });
    await receiveBatch(over.id, { quantity: 3, expiresAt: shopToday() });
    clock = moveClock(2 * 86_400_000);

    await bulk({ mode: 'fixed', value: 1, scope: { variantIds: [over.variantId], inStock: true } });

    expect(await priceOf(over.variantId)).toBe(10);
  });

  describe('with a dry run', () => {
    it('lists the variants with their old and new price and changes nothing', async () => {
      const category = await createCategory();
      const product = await newProduct({ price: 10, stock: 1, categoryId: category.id });
      const second = await createVariant(product.id, { price: 25.5 });

      const res = await bulk({
        mode: 'percent',
        value: 10,
        dryRun: true,
        scope: { categoryId: category.id },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        message: 'DRY_RUN',
        updatedCount: 2,
        variants: [
          {
            id: product.variantId,
            productId: product.id,
            name: expect.any(String),
            oldPrice: 10,
            newPrice: 11,
          },
          {
            id: second.id,
            productId: product.id,
            name: expect.any(String),
            oldPrice: 25.5,
            newPrice: 28.05,
          },
        ],
      });
      expect(await priceOf(product.variantId)).toBe(10);
      expect(await priceOf(second.id)).toBe(25.5);
      expect(await priceLinesOf(product.variantId)).toEqual([]);
    });

    it('lists no variants for a scope no variant fits', async () => {
      const res = await bulk({
        mode: 'fixed',
        value: 1,
        dryRun: true,
        scope: { variantIds: [2_000_000_000] },
      });

      expect(res.json()).toEqual({ message: 'DRY_RUN', updatedCount: 0, variants: [] });
    });

    // the sale needs no word for a dry run
    it('needs no word on the sales of the scope', async () => {
      const product = await newProduct({ price: 20, stock: 1 });
      await saleRoute(product.id, product.variantId);

      const res = await bulk({
        mode: 'fixed',
        value: 5,
        dryRun: true,
        scope: { variantIds: [product.variantId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().variants).toEqual([
        expect.objectContaining({ id: product.variantId, oldPrice: 20, newPrice: 25 }),
      ]);
    });

    it('counts the variants the stock filter keeps', async () => {
      const held = await newProduct({ price: 10, stock: 2 });
      await inCommittedTx((db) => waitingOrderOf(db, buyer.id, [[held.variantId, 2]]));
      const free = await newProduct({ price: 10, stock: 2 });

      const res = await bulk({
        mode: 'fixed',
        value: 1,
        dryRun: true,
        scope: { variantIds: [held.variantId, free.variantId], inStock: true },
      });

      expect(res.json().variants.map((variant: { id: number }) => variant.id)).toEqual([
        free.variantId,
      ]);
    });

    // the real run refuses it; the list shows the price that would come out
    it('lists a price below 0 and does not refuse it', async () => {
      const product = await newProduct({ price: 5, stock: 1 });

      const res = await bulk({
        mode: 'fixed',
        value: -8,
        dryRun: true,
        scope: { variantIds: [product.variantId] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().variants).toEqual([
        expect.objectContaining({ id: product.variantId, oldPrice: 5, newPrice: -3 }),
      ]);
    });
  });

  it('refuses a new price below 0 for a variant and changes none', async () => {
    const fine = await newProduct({ price: 50, stock: 1 });
    const cheap = await newProduct({ price: 5, stock: 1 });

    const res = await bulk({
      mode: 'fixed',
      value: -8,
      scope: { variantIds: [fine.variantId, cheap.variantId] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'BULK_PRICE_NEGATIVE_RESULT' });
    expect(await priceOf(fine.variantId)).toBe(50);
    expect(await priceOf(cheap.variantId)).toBe(5);
  });

  // a price past numeric(10, 2) made the database refuse the write: 500 instead of a refusal
  it('refuses a new price above the largest a variant holds and changes none', async () => {
    const fine = await newProduct({ price: 50, stock: 1 });
    const dear = await newProduct({ price: 60_000_000, stock: 1 });

    const res = await bulk({
      mode: 'percent',
      value: 100,
      scope: { variantIds: [fine.variantId, dear.variantId] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'BULK_PRICE_TOO_LARGE_RESULT',
      details: {
        variants: [{ variantId: dear.variantId, price: 120_000_000 }],
        maximum: 99_999_999.99,
      },
    });
    expect(await priceOf(fine.variantId)).toBe(50);
    expect(await priceOf(dear.variantId)).toBe(60_000_000);
  });

  it('leaves a variant whose price does not change out of the logs', async () => {
    const free = await newProduct({ price: 0, stock: 1 });

    const res = await bulk({
      mode: 'percent',
      value: 50,
      scope: { variantIds: [free.variantId] },
    });

    expect(res.json().updatedCount).toBe(0);
    expect(await priceLinesOf(free.variantId)).toEqual([]);
  });

  it.each([
    ['a user', () => buyer],
    ['a guest', () => null],
  ])('refuses %s', async (_who, actorOf) => {
    const actor = actorOf();
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/products',
      headers: withCsrf(csrf, actor ? accessCookie(actor) : ''),
      payload: { mode: 'fixed', value: 1 },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it.each([
    ['an unknown mode', { mode: 'double', value: 1 }, 'VALIDATION_ERROR'],
    ['a percent below -100', { mode: 'percent', value: -101 }, 'BULK_PRICE_PERCENT_TOO_LOW'],
    ['a category of 0', { mode: 'fixed', value: 1, scope: { categoryId: 0 } }, 'VALIDATION_ERROR'],
    [
      'bounds the wrong way round',
      { mode: 'fixed', value: 1, scope: { minPrice: 20, maxPrice: 10 } },
      'PRICE_RANGE_INVALID',
    ],
    [
      'an empty list of variants',
      { mode: 'fixed', value: 1, scope: { variantIds: [] } },
      'VALIDATION_ERROR',
    ],
    [
      'a variant named twice',
      { mode: 'fixed', value: 1, scope: { variantIds: [3, 3] } },
      'VALIDATION_ERROR',
    ],
  ])('refuses %s', async (_case, payload, code) => {
    const res = await bulk(payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: code });
  });
});

// the prices of many variants say what happens to their sales, the same for every one: keep them,
// or take them off; a new sale is set variant by variant. Taken off, each goes the way of one
// variant: the sale off with its lines, then the price. All of it or nothing
describe('PATCH /api/products with a sale on', () => {
  // a variant on sale and one without, in a product of their own
  const scopeOf = async () => {
    const product = await newProduct({ price: 20, stock: 1 });
    const plain = await createVariant(product.id, { price: 20 });
    await saleRoute(product.id, product.variantId);
    const saleLine = (await priceLinesOf(product.variantId))[0]!;
    return {
      product,
      plain,
      endsAt: saleLine.endsAt!,
      scope: { variantIds: [product.variantId, plain.id] },
    };
  };

  it('asks what to do with the sales of the scope, names the variants and changes nothing', async () => {
    const { product, plain, endsAt, scope } = await scopeOf();

    const res = await bulk({ mode: 'fixed', value: 5, scope });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_DECISION_REQUIRED',
      details: { variants: [{ variantId: product.variantId, salePrice: 15, saleEndsAt: endsAt }] },
    });
    expect(await priceOf(product.variantId)).toBe(20);
    expect(await priceOf(plain.id)).toBe(20);
  });

  it('counts the scope of a dry run without a word on the sales', async () => {
    const { scope } = await scopeOf();

    const res = await bulk({ mode: 'fixed', value: 5, scope, dryRun: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updatedCount: 2 });
  });

  it('keeps every sale and changes the prices', async () => {
    const { product, plain, endsAt, scope } = await scopeOf();

    const res = await bulk({ mode: 'fixed', value: 5, scope, sale: 'keep' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updatedCount: 2 });
    expect(await priceRowOf(product.variantId)).toMatchObject({
      price: 25,
      salePrice: 15,
      saleEndsAt: endsAt,
    });
    expect(await priceOf(plain.id)).toBe(25);
  });

  it('refuses to keep a sale a new price goes down to, naming the variant, and changes no variant', async () => {
    const { product, plain, endsAt, scope } = await scopeOf();

    const res = await bulk({ mode: 'percent', value: -50, scope, sale: 'keep' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_NOT_BELOW_PRICE',
      details: { variants: [{ variantId: product.variantId, salePrice: 15, price: 10 }] },
    });
    expect(await priceRowOf(product.variantId)).toMatchObject({
      price: 20,
      salePrice: 15,
      saleEndsAt: endsAt,
    });
    expect(await priceOf(plain.id)).toBe(20);
  });

  it('takes every sale off the way of one variant, then changes the prices', async () => {
    const { product, plain, endsAt, scope } = await scopeOf();

    const res = await bulk({ mode: 'percent', value: -50, scope, sale: 'remove' });

    expect(res.statusCode).toBe(200);
    expect(await priceRowOf(product.variantId)).toMatchObject({
      price: 10,
      salePrice: null,
      saleEndsAt: null,
    });
    expect(
      (await priceLinesOf(product.variantId)).map((line) => [
        line.event,
        line.mode,
        line.oldPrice,
        line.newPrice,
      ]),
    ).toEqual([
      ['price.sale_start', 'percent', 20, 15],
      ['price.sale_end', 'fixed', 15, 20],
      ['price.bulk', 'percent', 20, 10],
    ]);
    expect(await saleAuditOf(product.variantId)).toEqual([
      expect.objectContaining({ event: 'product.sale_set' }),
      expect.objectContaining({
        event: 'product.sale_remove_with_price',
        meta: expect.arrayContaining([
          { field: 'event', old: null, new: 'removed' },
          { field: 'saleEndsAt', old: endsAt, new: null },
        ]),
      }),
    ]);
    expect((await priceLinesOf(plain.id)).map((line) => [line.event, line.newPrice])).toEqual([
      ['price.bulk', 10],
    ]);
  });

  it('needs no word on the sales for a scope without one', async () => {
    const product = await newProduct({ price: 20, stock: 1 });

    const res = await bulk({ mode: 'fixed', value: 5, scope: { variantIds: [product.variantId] } });

    expect(res.statusCode).toBe(200);
    expect(await priceOf(product.variantId)).toBe(25);
  });

  it('needs no word on the sales that are over', async () => {
    const product = await newProduct({ price: 20, stock: 1 });
    await putOnSale(product.id, 15, 1_500);
    await waitForSalesEnd([product.id]);

    const res = await bulk({ mode: 'fixed', value: 5, scope: { variantIds: [product.variantId] } });

    expect(res.statusCode).toBe(200);
    expect(await priceRowOf(product.variantId)).toMatchObject({ price: 25, salePrice: 15 });
  });

  it('refuses another word on the sales', async () => {
    const { scope } = await scopeOf();

    const res = await bulk({ mode: 'fixed', value: 5, scope, sale: { percent: 10 } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});
