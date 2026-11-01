import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  putOnSale,
  waitForSalesEnd,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  markVariantDeleted,
  priceLinesOf,
  priceRowOf,
  saleAuditOf,
} from '../../../helpers/variants.js';

// the sale of the variants of a product (PATCH /api/products/:productId/sale): a discount by a
// percent of the price or by an amount of money, until an end in the future; the database keeps the
// sale price. The variants are the ones named, or every variant for sale; each is counted from its
// own price. While the sale lasts the variant sells at the sale price, and the answers show the sale
// next to the price. A sale past its end is no sale: the answers leave it out, though its fields stay
// in the row until a new sale writes over them. A price down to the sale price or below ends the sale.
// The log of prices names how a change was given (percent or fixed) and its size, negative for a
// change down: the start of a sale is a line with its end, a sale taken off goes from the sale price
// back to the price. The admin log gets every sale (PRODUCT_SALE) about the variant with what happened.
// The effects of a sale on the cart, the list and the favorites are in saleEffects.test.ts.
// Lines of the logs stay for good, so the products of the file stay too, removed from the catalog

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const DAY = 86_400_000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const cents = (value: number) => Math.round(value * 100) / 100;

async function newProduct(price = 20) {
  const product = await createProduct({ price, stock: 50 });
  products.push(product);
  return product;
}

// a product with a second and a third variant at prices of their own, the first one at 20
async function newProductOfThree(prices: [number, number, number] = [20, 40, 10]) {
  const product = await newProduct(prices[0]);
  const second = await createVariant(product.id, { price: prices[1], stock: 5 });
  const third = await createVariant(product.id, { price: prices[2], stock: 5 });
  return { product, variantIds: [product.variantId, second.id, third.id] };
}

async function newUser(role: TestUser['role'] = 'USER') {
  const user = await createUser({ role });
  userIds.push(user.id);
  return user;
}

const patchSale = (productId: number, payload: unknown, actor: TestUser | null = admin) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/sale`,
    headers: withCsrf(csrf, actor ? accessCookie(actor) : ''),
    payload: payload as Record<string, unknown>,
  });

const patchVariant = (productId: number, variantId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/variants/${variantId}`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

const getCard = (productId: number, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: `/api/products/${productId}`,
    ...(actor ? { headers: { cookie: accessCookie(actor) } } : {}),
  });

const saleRowOf = async (variantId: number) => {
  const { price, salePrice, saleEndsAt } = await priceRowOf(variantId);
  return { price, salePrice, saleEndsAt };
};

// the log of prices of a variant: the lines the app wrote
const priceLogOf = async (variantId: number) =>
  (await priceLinesOf(variantId)).map(({ event: _event, productId: _productId, ...line }) => line);

// the lines of the admin log of the sales of a variant
const variantAuditOf = async (variantId: number) =>
  (await saleAuditOf(variantId)).map(({ event: _event, ...line }) => line);

// every kind of line of the admin log about a variant, but the ones of its stock
const auditLinesOf = (variantId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: {
        entityType: 'variant',
        entityId: variantId,
        action: { notIn: ['STOCK_DELIVERY'] },
      },
      orderBy: { id: 'asc' },
      select: { action: true, event: true, actorId: true, meta: true },
    }),
  );

type Discount = { percent: number } | { amount: number };

// a change of the price in the log of prices, made by the admin of the file
const priceChange = (mode: string, oldPrice: number, newPrice: number, value: number) => ({
  mode,
  oldPrice,
  newPrice,
  value,
  endsAt: null,
  actorId: admin.id,
});

// the start of a sale in the log of prices: the mode of the discount, its size, negative since the
// price goes down (an amount the way it came out in cents), and the end of the sale
const saleStart = (
  discount: Discount,
  oldPrice: number,
  newPrice: number,
  endsAt: string,
  actorId = admin.id,
) => ({
  mode: 'percent' in discount ? 'percent' : 'fixed',
  oldPrice,
  newPrice,
  value: 'percent' in discount ? -discount.percent : -cents(oldPrice - newPrice),
  endsAt,
  actorId,
});

// a sale taken off in the log of prices: from the sale price back to the price, by an amount
const saleTakenOff = (salePrice: number, price: number) =>
  priceChange('fixed', salePrice, price, cents(price - salePrice));

type ShownSale = { salePrice: string; endsAt: string };

// a line of the admin log of a sale: what happened, the price before and after, the sale before
// and after, and the discount the admin gave; prices the way the app writes them, '15' and '15.5'
const saleAudit = (
  event: 'start' | 'change' | 'removed' | 'ended_by_price',
  args: {
    price: [string, string];
    before?: ShownSale;
    after?: ShownSale;
    discount?: Discount;
    actorId?: number;
  },
) => ({
  action: 'PRODUCT_SALE',
  actorId: args.actorId ?? admin.id,
  meta: [
    { field: 'event', old: null, new: event },
    { field: 'price', old: args.price[0], new: args.price[1] },
    { field: 'salePrice', old: args.before?.salePrice ?? null, new: args.after?.salePrice ?? null },
    { field: 'saleEndsAt', old: args.before?.endsAt ?? null, new: args.after?.endsAt ?? null },
    ...(args.discount ? [{ field: 'discount', old: null, new: args.discount }] : []),
  ],
});

// the answer of the sale route for a variant
const shown = (
  product: TestProduct,
  variantId: number,
  fields: Record<string, unknown>,
  status: 'set' | 'unchanged' | 'removed',
) =>
  expect.objectContaining({
    id: variantId,
    productId: product.id,
    name: expect.any(String),
    ...fields,
    status,
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser('ADMIN');
  root = await newUser('ROOT');
});

afterAll(async () => {
  try {
    for (const product of products) await deleteProductFromCatalog(product.id);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('PATCH /api/products/:productId/sale', () => {
  it('puts a variant on sale by a percent of its price', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { percent: 25, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      variants: [
        {
          id: product.variantId,
          productId: product.id,
          name: expect.any(String),
          price: 20,
          salePrice: 15,
          saleEndsAt: endsAt,
          salePriorPrice: 20,
          status: 'set',
        },
      ],
    });
    expect(await saleRowOf(product.variantId)).toEqual({
      price: 20,
      salePrice: 15,
      saleEndsAt: endsAt,
    });
    expect(await priceLogOf(product.variantId)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
    ]);
    // the lines are about the variant, the event says which route wrote them
    expect(await auditLinesOf(product.variantId)).toEqual([
      {
        ...saleAudit('start', {
          price: ['20', '20'],
          after: { salePrice: '15', endsAt },
          discount: { percent: 25 },
        }),
        event: 'product.sale_set',
      },
    ]);
    expect(await priceLinesOf(product.variantId)).toEqual([
      expect.objectContaining({ event: 'price.sale_start', productId: product.id }),
    ]);
  });

  it('puts a variant on sale by an amount off its price', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { amount: 5, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      shown(product, product.variantId, { price: 20, salePrice: 15 }, 'set'),
    ]);
    expect(await priceLogOf(product.variantId)).toEqual([saleStart({ amount: 5 }, 20, 15, endsAt)]);
    expect(await variantAuditOf(product.variantId)).toEqual([
      saleAudit('start', {
        price: ['20', '20'],
        after: { salePrice: '15', endsAt },
        discount: { amount: 5 },
      }),
    ]);
  });

  it.each([
    ['a percent of 100', { percent: 100 }],
    ['an amount of the whole price', { amount: 20 }],
  ])('gives a variant away for %s', async (_case, discount: Discount) => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { ...discount, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      shown(product, product.variantId, { price: 20, salePrice: 0 }, 'set'),
    ]);
    expect(await priceLogOf(product.variantId)).toEqual([saleStart(discount, 20, 0, endsAt)]);
  });

  it('rounds the sale price to cents, a half cent up', async () => {
    const product = await newProduct(10.01);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { percent: 50, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants[0]).toMatchObject({ price: 10.01, salePrice: 5.01 });
    expect(await priceLogOf(product.variantId)).toEqual([
      saleStart({ percent: 50 }, 10.01, 5.01, endsAt),
    ]);
  });

  // an amount that does not come out in cents: the line keeps the discount the price got
  it('logs an amount off by the discount it came to in cents', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { amount: 5.555, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants[0]).toMatchObject({ salePrice: 14.45 });
    expect(await priceLogOf(product.variantId)).toEqual([
      { mode: 'fixed', oldPrice: 20, newPrice: 14.45, value: -5.55, endsAt, actorId: admin.id },
    ]);
  });

  it('lets root put a variant on sale, in the logs in the name of root', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { amount: 1, endsAt } }, root);

    expect(res.statusCode).toBe(200);
    expect(await priceLogOf(product.variantId)).toEqual([
      saleStart({ amount: 1 }, 20, 19, endsAt, root.id),
    ]);
    expect(await variantAuditOf(product.variantId)).toEqual([
      saleAudit('start', {
        price: ['20', '20'],
        after: { salePrice: '19', endsAt },
        discount: { amount: 1 },
        actorId: root.id,
      }),
    ]);
  });

  // the start of a new sale goes from the price, the same line whatever sale was on before; the
  // admin log tells it is a change and what the sale was
  it('writes a new sale over the one that is on', async () => {
    const product = await newProduct(20);
    const firstEnd = inMs(DAY);
    const secondEnd = inMs(2 * DAY);
    await patchSale(product.id, { sale: { percent: 25, endsAt: firstEnd } });

    const res = await patchSale(product.id, { sale: { amount: 8, endsAt: secondEnd } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants[0]).toMatchObject({
      salePrice: 12,
      saleEndsAt: secondEnd,
      status: 'set',
    });
    expect(await saleRowOf(product.variantId)).toEqual({
      price: 20,
      salePrice: 12,
      saleEndsAt: secondEnd,
    });
    expect(await priceLogOf(product.variantId)).toEqual([
      saleStart({ percent: 25 }, 20, 15, firstEnd),
      saleStart({ amount: 8 }, 20, 12, secondEnd),
    ]);
    expect((await variantAuditOf(product.variantId)).at(-1)).toEqual(
      saleAudit('change', {
        price: ['20', '20'],
        before: { salePrice: '15', endsAt: firstEnd },
        after: { salePrice: '12', endsAt: secondEnd },
        discount: { amount: 8 },
      }),
    );
  });

  it('takes a sale off: the variant sells at its price again', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);
    await patchSale(product.id, { sale: { percent: 25, endsAt } });

    const res = await patchSale(product.id, { sale: null });

    expect(res.statusCode).toBe(200);
    // the answer names the empty sale
    expect(res.json().variants).toEqual([
      {
        id: product.variantId,
        productId: product.id,
        name: expect.any(String),
        price: 20,
        salePrice: null,
        saleEndsAt: null,
        salePriorPrice: null,
        status: 'removed',
      },
    ]);
    expect(await saleRowOf(product.variantId)).toEqual({
      price: 20,
      salePrice: null,
      saleEndsAt: null,
    });
    expect(await priceLogOf(product.variantId)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
      saleTakenOff(15, 20),
    ]);
    expect((await auditLinesOf(product.variantId)).at(-1)).toEqual({
      ...saleAudit('removed', { price: ['20', '20'], before: { salePrice: '15', endsAt } }),
      event: 'product.sale_remove',
    });
  });

  // done already: nothing is written and the admin is told so
  it('refuses to take off a sale a variant does not have', async () => {
    const product = await newProduct(20);

    const res = await patchSale(product.id, { sale: null });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_ALREADY_REMOVED',
      details: { variantIds: [product.variantId] },
    });
    expect(await priceLogOf(product.variantId)).toEqual([]);
    expect(await variantAuditOf(product.variantId)).toEqual([]);
  });

  it('refuses to take off a sale twice', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);
    await patchSale(product.id, { sale: { percent: 25, endsAt } });
    await patchSale(product.id, { sale: null });

    const res = await patchSale(product.id, { sale: null });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ALREADY_REMOVED' });
    expect(await priceLogOf(product.variantId)).toHaveLength(2);
    expect(await variantAuditOf(product.variantId)).toHaveLength(2);
  });

  // the same sale price and the same end, whether given by a percent or by an amount
  it.each([
    ['the same discount', { percent: 25 }],
    ['another discount that comes to the same sale price', { amount: 5 }],
  ])('refuses the sale that is on already: %s', async (_case, discount) => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);
    await patchSale(product.id, { sale: { percent: 25, endsAt } });

    const res = await patchSale(product.id, { sale: { ...discount, endsAt } });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_ALREADY_SET',
      details: { variantIds: [product.variantId] },
    });
    expect(await priceLogOf(product.variantId)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
    ]);
    expect(await variantAuditOf(product.variantId)).toHaveLength(1);
  });

  it('changes a sale that is on to another end only', async () => {
    const product = await newProduct(20);
    const firstEnd = inMs(DAY);
    const secondEnd = inMs(2 * DAY);
    await patchSale(product.id, { sale: { percent: 25, endsAt: firstEnd } });

    const res = await patchSale(product.id, { sale: { percent: 25, endsAt: secondEnd } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants[0]).toMatchObject({ salePrice: 15, saleEndsAt: secondEnd });
    expect((await variantAuditOf(product.variantId)).at(-1)).toEqual(
      saleAudit('change', {
        price: ['20', '20'],
        before: { salePrice: '15', endsAt: firstEnd },
        after: { salePrice: '15', endsAt: secondEnd },
        discount: { percent: 25 },
      }),
    );
  });

  const endsAt = inMs(DAY);

  it.each([
    ['no sale', {}],
    ['an empty sale', { sale: {} }],
    ['a sale without an end', { sale: { percent: 10 } }],
    ['a sale without a discount', { sale: { endsAt } }],
    ['a percent of 0', { sale: { percent: 0, endsAt } }],
    ['a negative percent', { sale: { percent: -5, endsAt } }],
    ['a percent over 100', { sale: { percent: 101, endsAt } }],
    ['an amount of 0', { sale: { amount: 0, endsAt } }],
    ['a negative amount', { sale: { amount: -1, endsAt } }],
    ['both a percent and an amount', { sale: { percent: 10, amount: 1, endsAt } }],
    ['an end that is no date', { sale: { percent: 10, endsAt: 'next week' } }],
    ['a sale that is no object', { sale: 'off' }],
    ['an empty list of variants', { variantIds: [], sale: null }],
    ['a variant named twice', { variantIds: [5, 5], sale: null }],
    ['a variant id of 0', { variantIds: [0], sale: null }],
    ['a variant id that is no number', { variantIds: ['x'], sale: null }],
  ])('refuses %s', async (_case, payload) => {
    const product = await newProduct(20);

    const res = await patchSale(product.id, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await saleRowOf(product.variantId)).toMatchObject({ salePrice: null, saleEndsAt: null });
    expect(await priceLogOf(product.variantId)).toEqual([]);
    expect(await variantAuditOf(product.variantId)).toEqual([]);
  });

  it('refuses an amount above the price, naming the variant and its price', async () => {
    const product = await newProduct(20);

    const res = await patchSale(product.id, { sale: { amount: 25, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { variants: [{ variantId: product.variantId, price: 20 }] },
    });
    expect(await saleRowOf(product.variantId)).toMatchObject({ salePrice: null });
    expect(await priceLogOf(product.variantId)).toEqual([]);
    expect(await variantAuditOf(product.variantId)).toEqual([]);
  });

  // the sale price has to stay below the price once it is rounded to cents
  it.each([
    ['a percent of a price of a few cents', 0.05, { percent: 1 }],
    ['an amount below half a cent', 20, { amount: 0.004 }],
    ['any discount of a free variant', 0, { percent: 50 }],
  ])('refuses a discount that comes to nothing: %s', async (_case, price, discount) => {
    const product = await newProduct(price);

    const res = await patchSale(product.id, { sale: { ...discount, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_TOO_SMALL',
      details: { variants: [{ variantId: product.variantId }] },
    });
    expect(await saleRowOf(product.variantId)).toMatchObject({ salePrice: null });
  });

  it.each([
    ['in the past', -60_000],
    ['at the moment of the request', 0],
  ])('refuses an end %s', async (_case, ms) => {
    const product = await newProduct(20);

    const res = await patchSale(product.id, { sale: { percent: 10, endsAt: inMs(ms) } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID' });
    expect(await saleRowOf(product.variantId)).toMatchObject({ salePrice: null });
  });

  it('answers 404 for a product that does not exist', async () => {
    const res = await patchSale(2_147_483_647, { sale: { percent: 10, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  // a product removed from the catalog sells no more, a sale of it is no use
  it('answers 404 for a product removed from the catalog and changes nothing', async () => {
    const product = await newProduct(20);
    await deleteProductFromCatalog(product.id);

    const res = await patchSale(product.id, { sale: { percent: 10, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    expect(await saleRowOf(product.variantId)).toMatchObject({ salePrice: null });
  });

  it.each([
    ['a user', () => newUser()],
    ['a guest', async () => null],
  ])('refuses %s', async (_who, actorOf) => {
    const product = await newProduct(20);

    const res = await patchSale(
      product.id,
      { sale: { percent: 10, endsAt: inMs(DAY) } },
      await actorOf(),
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(await saleRowOf(product.variantId)).toMatchObject({ salePrice: null });
  });
});

// a product has variants at prices of their own: the route puts a sale on all of them or on the
// ones named, each from its own price, and answers with the state of each
describe('PATCH /api/products/:productId/sale for the variants of a product', () => {
  it('puts every variant for sale on sale, each from its own price', async () => {
    const { product, variantIds } = await newProductOfThree([20, 40, 10]);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { percent: 25, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      shown(product, variantIds[0]!, { price: 20, salePrice: 15, salePriorPrice: 20 }, 'set'),
      shown(product, variantIds[1]!, { price: 40, salePrice: 30, salePriorPrice: 40 }, 'set'),
      shown(product, variantIds[2]!, { price: 10, salePrice: 7.5, salePriorPrice: 10 }, 'set'),
    ]);
    expect((await Promise.all(variantIds.map(saleRowOf))).map((row) => row.salePrice)).toEqual([
      15, 30, 7.5,
    ]);
    // a line of the logs for each variant
    expect(await priceLogOf(variantIds[1]!)).toEqual([saleStart({ percent: 25 }, 40, 30, endsAt)]);
    expect(await variantAuditOf(variantIds[2]!)).toEqual([
      saleAudit('start', {
        price: ['10', '10'],
        after: { salePrice: '7.5', endsAt },
        discount: { percent: 25 },
      }),
    ]);
  });

  it('leaves out the variants that are taken out of sale', async () => {
    const { product, variantIds } = await newProductOfThree();
    await markVariantDeleted(variantIds[1]!);

    const res = await patchSale(product.id, { sale: { percent: 50, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants.map((variant: { id: number }) => variant.id)).toEqual([
      variantIds[0],
      variantIds[2],
    ]);
    expect((await saleRowOf(variantIds[1]!)).salePrice).toBeNull();
  });

  it('puts only the variants named on sale, and answers in their order', async () => {
    const { product, variantIds } = await newProductOfThree();

    const res = await patchSale(product.id, {
      variantIds: [variantIds[2], variantIds[0]],
      sale: { percent: 50, endsAt: inMs(DAY) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants.map((variant: { id: number }) => variant.id)).toEqual([
      variantIds[2],
      variantIds[0],
    ]);
    expect((await saleRowOf(variantIds[1]!)).salePrice).toBeNull();
    expect((await saleRowOf(variantIds[0]!)).salePrice).toBe(10);
  });

  // the same money off each: all of them or none
  it('takes an amount off each variant', async () => {
    const { product, variantIds } = await newProductOfThree([20, 40, 10]);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { amount: 5, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants.map((variant: { salePrice: number }) => variant.salePrice)).toEqual([
      15, 35, 5,
    ]);
    expect(await priceLogOf(variantIds[2]!)).toEqual([saleStart({ amount: 5 }, 10, 5, endsAt)]);
  });

  it('refuses the whole request and names the variants an amount is above, putting nothing on', async () => {
    const { product, variantIds } = await newProductOfThree([20, 3, 4]);

    const res = await patchSale(product.id, { sale: { amount: 5, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: {
        variants: [
          { variantId: variantIds[1], price: 3 },
          { variantId: variantIds[2], price: 4 },
        ],
      },
    });
    for (const id of variantIds) {
      expect((await saleRowOf(id)).salePrice).toBeNull();
      expect(await priceLogOf(id)).toEqual([]);
    }
  });

  it('refuses the whole request and names the variants a discount comes to nothing for', async () => {
    const { product, variantIds } = await newProductOfThree([20, 0, 0.05]);

    const res = await patchSale(product.id, { sale: { percent: 1, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_TOO_SMALL',
      details: { variants: [{ variantId: variantIds[1] }, { variantId: variantIds[2] }] },
    });
    expect((await saleRowOf(variantIds[0]!)).salePrice).toBeNull();
  });

  it('answers the state of each variant: the one that has the sale already stays as it is', async () => {
    const { product, variantIds } = await newProductOfThree([20, 40, 10]);
    const endsAt = inMs(DAY);
    await patchSale(product.id, { variantIds: [variantIds[0]], sale: { percent: 25, endsAt } });

    const res = await patchSale(product.id, { sale: { percent: 25, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      shown(product, variantIds[0]!, { salePrice: 15 }, 'unchanged'),
      shown(product, variantIds[1]!, { salePrice: 30 }, 'set'),
      shown(product, variantIds[2]!, { salePrice: 7.5 }, 'set'),
    ]);
    expect(await priceLogOf(variantIds[0]!)).toHaveLength(1);
    expect(await priceLogOf(variantIds[1]!)).toHaveLength(1);
  });

  it('is done already, 409 with nothing written, when every variant has the same sale', async () => {
    const { product, variantIds } = await newProductOfThree();
    const endsAt = inMs(DAY);
    await patchSale(product.id, { sale: { percent: 25, endsAt } });

    const res = await patchSale(product.id, { sale: { percent: 25, endsAt } });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_ALREADY_SET',
      details: { variantIds },
    });
    for (const id of variantIds) expect(await priceLogOf(id)).toHaveLength(1);
  });

  it('takes the sales off the variants that have one and leaves the others as they are', async () => {
    const { product, variantIds } = await newProductOfThree([20, 40, 10]);
    const endsAt = inMs(DAY);
    await patchSale(product.id, {
      variantIds: [variantIds[0], variantIds[2]],
      sale: { percent: 50, endsAt },
    });

    const res = await patchSale(product.id, { sale: null });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      shown(product, variantIds[0]!, { price: 20, salePrice: null, saleEndsAt: null }, 'removed'),
      shown(product, variantIds[1]!, { price: 40, salePrice: null, saleEndsAt: null }, 'unchanged'),
      shown(product, variantIds[2]!, { price: 10, salePrice: null, saleEndsAt: null }, 'removed'),
    ]);
    expect(await priceLogOf(variantIds[0]!)).toEqual([
      saleStart({ percent: 50 }, 20, 10, endsAt),
      saleTakenOff(10, 20),
    ]);
    expect(await priceLogOf(variantIds[1]!)).toEqual([]);
  });

  it('takes the sale off only the variants named', async () => {
    const { product, variantIds } = await newProductOfThree();
    await patchSale(product.id, { sale: { percent: 50, endsAt: inMs(DAY) } });

    const res = await patchSale(product.id, { variantIds: [variantIds[1]], sale: null });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      shown(product, variantIds[1]!, { salePrice: null }, 'removed'),
    ]);
    expect((await saleRowOf(variantIds[0]!)).salePrice).toBe(10);
    expect((await saleRowOf(variantIds[1]!)).salePrice).toBeNull();
  });

  it('is done already, 409, when no variant has a sale to take off', async () => {
    const { product, variantIds } = await newProductOfThree();

    const res = await patchSale(product.id, { sale: null });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_ALREADY_REMOVED',
      details: { variantIds },
    });
  });

  it('answers 404 for a variant of another product and names it', async () => {
    const { product, variantIds } = await newProductOfThree();
    const other = await newProduct(20);

    const res = await patchSale(product.id, {
      variantIds: [variantIds[0], other.variantId, 2_000_000_000],
      sale: { percent: 10, endsAt: inMs(DAY) },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANT_NOT_FOUND',
      details: { variantIds: [other.variantId, 2_000_000_000] },
    });
    expect((await saleRowOf(variantIds[0]!)).salePrice).toBeNull();
  });

  it('answers 404 for a variant taken out of sale: it sells no more', async () => {
    const { product, variantIds } = await newProductOfThree();
    await markVariantDeleted(variantIds[1]!);

    const res = await patchSale(product.id, {
      variantIds: [variantIds[0], variantIds[1]],
      sale: { percent: 10, endsAt: inMs(DAY) },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANT_NOT_FOUND',
      details: { variantIds: [variantIds[1]] },
    });
    expect((await saleRowOf(variantIds[0]!)).salePrice).toBeNull();
  });

  it('answers 404 for a product none of whose variants is for sale', async () => {
    const product = await newProduct(20);
    await markVariantDeleted(product.variantId);

    const res = await patchSale(product.id, { sale: { percent: 10, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
  });

  it('keeps the lowest price of the first sale on the variants a new sale replaces', async () => {
    const { product, variantIds } = await newProductOfThree([20, 40, 10]);
    await patchSale(product.id, { sale: { percent: 10, endsAt: inMs(DAY) } });

    const res = await patchSale(product.id, { sale: { percent: 50, endsAt: inMs(2 * DAY) } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants).toEqual([
      shown(product, variantIds[0]!, { salePrice: 10, salePriorPrice: 20 }, 'set'),
      shown(product, variantIds[1]!, { salePrice: 20, salePriorPrice: 40 }, 'set'),
      shown(product, variantIds[2]!, { salePrice: 5, salePriorPrice: 10 }, 'set'),
    ]);
  });
});

// a price change of a variant with a sale that is on says what happens to the sale: keep it, take
// it off, or a new one. Each goes step by step with every line of the logs: the old sale off, the
// price, the new sale from the new price; all of it or nothing
describe('PATCH /api/products/:productId/variants/:variantId with a sale on', () => {
  const variantOnSale = async (endsAt = inMs(DAY)) => {
    const product = await newProduct(20);
    await patchSale(product.id, { sale: { percent: 25, endsAt } });
    return { product, endsAt };
  };

  it('asks what to do with the sale and changes nothing', async () => {
    const { product, endsAt } = await variantOnSale();

    const res = await patchVariant(product.id, product.variantId, { price: 25 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_DECISION_REQUIRED',
      details: { salePrice: 15, saleEndsAt: endsAt },
    });
    expect(await saleRowOf(product.variantId)).toEqual({
      price: 20,
      salePrice: 15,
      saleEndsAt: endsAt,
    });
    expect(await priceLogOf(product.variantId)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
    ]);
  });

  it('keeps the sale and changes the price only', async () => {
    const { product, endsAt } = await variantOnSale();

    const res = await patchVariant(product.id, product.variantId, { price: 25, sale: 'keep' });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 25, salePrice: 15, saleEndsAt: endsAt });
    expect(await priceLogOf(product.variantId)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
      priceChange('fixed', 20, 25, 5),
    ]);
  });

  it.each([
    ['to the sale price', 15],
    ['below it', 12],
  ])('refuses to keep a sale the price goes down %s, and changes nothing', async (_case, price) => {
    const { product, endsAt } = await variantOnSale();

    const res = await patchVariant(product.id, product.variantId, { price, sale: 'keep' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_NOT_BELOW_PRICE',
      details: { salePrice: 15, price },
    });
    expect(await saleRowOf(product.variantId)).toEqual({
      price: 20,
      salePrice: 15,
      saleEndsAt: endsAt,
    });
  });

  it('takes the sale off, then changes the price', async () => {
    const { product, endsAt } = await variantOnSale();

    const res = await patchVariant(product.id, product.variantId, { price: 12, sale: 'remove' });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 12, salePrice: null, saleEndsAt: null });
    expect(await priceLogOf(product.variantId)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
      saleTakenOff(15, 20),
      priceChange('fixed', 20, 12, -8),
    ]);
    expect((await auditLinesOf(product.variantId)).slice(1)).toEqual([
      {
        ...saleAudit('removed', { price: ['20', '20'], before: { salePrice: '15', endsAt } }),
        event: 'product.sale_remove_with_price',
      },
      {
        action: 'OTHER',
        event: 'variant.update',
        actorId: admin.id,
        meta: [{ field: 'price', old: '20', new: '12' }],
      },
    ]);
  });

  it('takes the old sale off, changes the price and puts the new sale on', async () => {
    const { product, endsAt } = await variantOnSale();
    const newEnd = inMs(2 * DAY);

    const res = await patchVariant(product.id, product.variantId, {
      price: 30,
      sale: { amount: 5, endsAt: newEnd },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 30, salePrice: 25, saleEndsAt: newEnd });
    expect(await priceLogOf(product.variantId)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
      saleTakenOff(15, 20),
      priceChange('fixed', 20, 30, 10),
      saleStart({ amount: 5 }, 30, 25, newEnd),
    ]);
    expect((await auditLinesOf(product.variantId)).slice(1)).toEqual([
      {
        ...saleAudit('removed', { price: ['20', '20'], before: { salePrice: '15', endsAt } }),
        event: 'product.sale_remove_with_price',
      },
      {
        action: 'OTHER',
        event: 'variant.update',
        actorId: admin.id,
        meta: [{ field: 'price', old: '20', new: '30' }],
      },
      {
        ...saleAudit('start', {
          price: ['30', '30'],
          after: { salePrice: '25', endsAt: newEnd },
          discount: { amount: 5 },
        }),
        event: 'product.sale_set_with_price',
      },
    ]);
  });

  // the new sale is counted from the new price: refused, it leaves everything as it was
  it('refuses a new sale that does not fit the new price and changes nothing', async () => {
    const { product, endsAt } = await variantOnSale();

    const res = await patchVariant(product.id, product.variantId, {
      price: 30,
      sale: { amount: 40, endsAt: inMs(DAY) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { price: 30 },
    });
    expect(await saleRowOf(product.variantId)).toEqual({
      price: 20,
      salePrice: 15,
      saleEndsAt: endsAt,
    });
    expect(await priceLogOf(product.variantId)).toHaveLength(1);
  });

  it('puts a sale on together with the price of a variant without one', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchVariant(product.id, product.variantId, {
      price: 30,
      sale: { percent: 50, endsAt },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 30, salePrice: 15, saleEndsAt: endsAt });
    expect(await priceLogOf(product.variantId)).toEqual([
      priceChange('fixed', 20, 30, 10),
      saleStart({ percent: 50 }, 30, 15, endsAt),
    ]);
  });

  it('needs no word on the sale for a variant without one', async () => {
    const product = await newProduct(20);

    const res = await patchVariant(product.id, product.variantId, { price: 18 });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 18 });
    expect(await priceLogOf(product.variantId)).toEqual([priceChange('fixed', 20, 18, -2)]);
  });

  it('needs no word on the sale for a change that leaves the price', async () => {
    const { product, endsAt } = await variantOnSale();

    const res = await patchVariant(product.id, product.variantId, { sku: `ON-SALE-${endsAt}` });

    expect(res.statusCode).toBe(200);
    expect(await saleRowOf(product.variantId)).toEqual({
      price: 20,
      salePrice: 15,
      saleEndsAt: endsAt,
    });
  });

  it('needs no word on the sale when the price stays the same', async () => {
    const { product, endsAt } = await variantOnSale();

    const res = await patchVariant(product.id, product.variantId, { price: 20 });

    expect(res.statusCode).toBe(200);
    expect(await saleRowOf(product.variantId)).toEqual({
      price: 20,
      salePrice: 15,
      saleEndsAt: endsAt,
    });
    expect(await priceLogOf(product.variantId)).toHaveLength(1);
  });

  // the sale alone has a route of its own
  it.each(['keep', 'remove'])('refuses the word %s on the sale without a price', async (sale) => {
    const { product } = await variantOnSale();

    const res = await patchVariant(product.id, product.variantId, { sale, sku: 'WORD-ALONE' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_REQUIRES_PRICE' });
  });

  it.each([
    ['null', null],
    ['another word', 'percent:10'],
    ['a sale without an end', { percent: 10 }],
    ['both a percent and an amount', { percent: 10, amount: 1, endsAt: inMs(DAY) }],
  ])('refuses %s as the word on the sale', async (_case, sale) => {
    const { product } = await variantOnSale();

    const res = await patchVariant(product.id, product.variantId, { price: 25, sale });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

// the price of a variant sets the sale price while the sale lasts; the sale is no sale past its end
describe('a sale in the answers', () => {
  let onSale: TestProduct;
  let plain: TestProduct;
  let endsAt: string;

  beforeAll(async () => {
    onSale = await newProduct(20);
    plain = await newProduct(20);
    endsAt = inMs(DAY);
    const res = await patchSale(onSale.id, { sale: { percent: 25, endsAt } });
    if (res.statusCode !== 200) throw new Error(`the sale route answered ${res.statusCode}`);
  });

  it('shows the sale next to the price on the card of the product', async () => {
    const res = await getCard(onSale.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 20, salePrice: 15, saleEndsAt: endsAt });
    expect(res.json().variants).toEqual([
      expect.objectContaining({ id: onSale.variantId, salePrice: 15 }),
    ]);
  });

  it('shows the sale on the variant on its own', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/products/${onSale.id}/variants/${onSale.variantId}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 20, salePrice: 15, saleEndsAt: endsAt });
  });

  it('shows no sale of a variant without one', async () => {
    const res = await getCard(plain.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).not.toHaveProperty('salePrice');
    expect(res.json().variant).not.toHaveProperty('saleEndsAt');
  });

  it('shows an admin the sale as the row keeps it, null without one', async () => {
    const withSale = await getCard(onSale.id, admin);
    const without = await getCard(plain.id, admin);

    expect(withSale.json().variant).toMatchObject({ salePrice: 15, saleEndsAt: endsAt });
    expect(without.json().variant).toMatchObject({
      salePrice: null,
      saleEndsAt: null,
      salePriorPrice: null,
    });
  });
});

// sales that end a moment after they start: the tests wait for the end by both clocks, the one of
// the database that prices the orders and the one of the app that answers
describe('a sale past its end', () => {
  const ENDS_IN_MS = 1_500;
  let shownOnCard: TestProduct;
  let takenOff: TestProduct;
  let writtenOver: TestProduct;
  let priceDown: TestProduct;

  beforeAll(async () => {
    [shownOnCard, takenOff, writtenOver, priceDown] = (await Promise.all(
      Array.from({ length: 4 }, () => newProduct(20)),
    )) as [TestProduct, TestProduct, TestProduct, TestProduct];
    const all = [shownOnCard, takenOff, writtenOver, priceDown];
    for (const product of all) await putOnSale(product.id, 15, ENDS_IN_MS);

    await waitForSalesEnd(all.map((product) => product.id));
  });

  it('leaves the sale out of the card of the product', async () => {
    const res = await getCard(shownOnCard.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 20 });
    expect(res.json().variant).not.toHaveProperty('salePrice');
    expect(res.json().variant).not.toHaveProperty('saleEndsAt');
  });

  // an admin sees the fields of the row, a sale past its end too
  it('shows an admin the sale that is over as the row keeps it', async () => {
    const res = await getCard(shownOnCard.id, admin);

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ price: 20, salePrice: 15 });
    expect(Date.parse(res.json().variant.saleEndsAt)).toBeLessThanOrEqual(Date.now());
  });

  // a sale that is over is no sale: there is nothing to take off, its fields stay in the row
  it('refuses to take off a sale that is over and writes nothing', async () => {
    const before = await saleRowOf(takenOff.variantId);

    const res = await patchSale(takenOff.id, { sale: null });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ALREADY_REMOVED' });
    expect(await saleRowOf(takenOff.variantId)).toEqual(before);
    expect(await priceLogOf(takenOff.variantId)).toEqual([]);
    expect(await variantAuditOf(takenOff.variantId)).toEqual([]);
  });

  // a sale that is over was no sale: the new one starts, it changes none
  it('writes a new sale over it, from the price', async () => {
    const endsAt = inMs(DAY);

    const res = await patchSale(writtenOver.id, { sale: { amount: 2, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json().variants[0]).toMatchObject({ salePrice: 18, saleEndsAt: endsAt });
    expect(await priceLogOf(writtenOver.variantId)).toEqual([
      saleStart({ amount: 2 }, 20, 18, endsAt),
    ]);
    expect(await variantAuditOf(writtenOver.variantId)).toEqual([
      saleAudit('start', {
        price: ['20', '20'],
        after: { salePrice: '18', endsAt },
        discount: { amount: 2 },
      }),
    ]);
  });

  it('empties it with no line of its end when the price goes down to it', async () => {
    const res = await patchVariant(priceDown.id, priceDown.variantId, { price: 14 });

    expect(res.statusCode).toBe(200);
    expect(await saleRowOf(priceDown.variantId)).toEqual({
      price: 14,
      salePrice: null,
      saleEndsAt: null,
    });
    expect(await priceLogOf(priceDown.variantId)).toEqual([priceChange('fixed', 20, 14, -6)]);
    expect((await auditLinesOf(priceDown.variantId)).map((line) => line.event)).toEqual([
      'variant.update',
    ]);
  });
});
