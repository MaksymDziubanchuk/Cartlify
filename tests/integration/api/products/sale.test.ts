import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createFavorite,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  putOnSale,
  waitForSalesEnd,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { multipartBody } from '../../../helpers/multipart.js';
import { shippingData } from '../../../helpers/orders.js';

// the sale of a product (PATCH /api/products/:productId/sale): a discount by a percent of the price
// or by an amount of money, until an end in the future; the database keeps the sale price. While
// the sale lasts the product sells at the sale price: the cart, the confirm and its smallest
// payment, the sort and the filters of the catalog take it, and the answers show the sale next to
// the price. A sale past its end is no sale: the answers leave it out, though its fields stay in
// the row until a new sale writes over them. A price down to the sale price or below ends the sale.
// The log of prices names how a change was given (percent or fixed) and its size, negative for a
// change down: the start of a sale is a line with its end, a sale taken off goes from the sale
// price back to the price. The admin log gets every sale (PRODUCT_SALE) with what happened.
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

const patchProduct = (productId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

const getProduct = (productId: number) =>
  app.inject({ method: 'GET', url: `/api/products/${productId}` });

const listProducts = (query: Record<string, string>) =>
  app.inject({ method: 'GET', url: `/api/products?${new URLSearchParams(query)}` });

const idsOf = (res: LightMyRequestResponse) =>
  (res.json().items as Array<{ id: number }>).map((item) => item.id);

const addToCart = (user: TestUser, productId: number, quantity = 1) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/items',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { productId, quantity },
  });

const confirm = (user: TestUser, orderId: number) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(user)),
    payload: { orderId, ...shippingData },
  });

const saleRowOf = async (productId: number) => {
  const row = await asAdmin((tx) =>
    tx.product.findUniqueOrThrow({
      where: { id: productId },
      select: { price: true, salePrice: true, saleEndsAt: true },
    }),
  );
  return {
    price: Number(row.price),
    salePrice: row.salePrice === null ? null : Number(row.salePrice),
    saleEndsAt: row.saleEndsAt?.toISOString() ?? null,
  };
};

const priceLogOf = async (productId: number) => {
  const lines = await asAdmin((tx) =>
    tx.productPriceChangeLog.findMany({
      where: { productId },
      orderBy: { id: 'asc' },
      select: {
        mode: true,
        oldPrice: true,
        newPrice: true,
        value: true,
        endsAt: true,
        actorId: true,
      },
    }),
  );
  return lines.map((line) => ({
    mode: line.mode,
    oldPrice: Number(line.oldPrice),
    newPrice: Number(line.newPrice),
    value: Number(line.value),
    endsAt: line.endsAt?.toISOString() ?? null,
    actorId: line.actorId,
  }));
};

const productAuditOf = (productId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'product', entityId: productId },
      orderBy: { id: 'asc' },
      select: { action: true, actorId: true, meta: true },
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
  it('puts a product on sale by a percent of its price', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { percent: 25, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: product.id,
      price: 20,
      salePrice: 15,
      saleEndsAt: endsAt,
    });
    expect(await saleRowOf(product.id)).toEqual({ price: 20, salePrice: 15, saleEndsAt: endsAt });
    expect(await priceLogOf(product.id)).toEqual([saleStart({ percent: 25 }, 20, 15, endsAt)]);
    expect(await productAuditOf(product.id)).toEqual([
      saleAudit('start', {
        price: ['20', '20'],
        after: { salePrice: '15', endsAt },
        discount: { percent: 25 },
      }),
    ]);
  });

  it('puts a product on sale by an amount off its price', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { amount: 5, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 20, salePrice: 15, saleEndsAt: endsAt });
    expect(await priceLogOf(product.id)).toEqual([saleStart({ amount: 5 }, 20, 15, endsAt)]);
    expect(await productAuditOf(product.id)).toEqual([
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
  ])('gives a product away for %s', async (_case, discount: Discount) => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { ...discount, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 20, salePrice: 0 });
    expect(await priceLogOf(product.id)).toEqual([saleStart(discount, 20, 0, endsAt)]);
  });

  it('rounds the sale price to cents, a half cent up', async () => {
    const product = await newProduct(10.01);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { percent: 50, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 10.01, salePrice: 5.01 });
    expect(await priceLogOf(product.id)).toEqual([saleStart({ percent: 50 }, 10.01, 5.01, endsAt)]);
  });

  // an amount that does not come out in cents: the line keeps the discount the price got
  it('logs an amount off by the discount it came to in cents', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { amount: 5.555, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ salePrice: 14.45 });
    expect(await priceLogOf(product.id)).toEqual([
      { mode: 'fixed', oldPrice: 20, newPrice: 14.45, value: -5.55, endsAt, actorId: admin.id },
    ]);
  });

  it('lets root put a product on sale, in the logs in the name of root', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchSale(product.id, { sale: { amount: 1, endsAt } }, root);

    expect(res.statusCode).toBe(200);
    expect(await priceLogOf(product.id)).toEqual([
      saleStart({ amount: 1 }, 20, 19, endsAt, root.id),
    ]);
    expect(await productAuditOf(product.id)).toEqual([
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
    expect(res.json()).toMatchObject({ salePrice: 12, saleEndsAt: secondEnd });
    expect(await saleRowOf(product.id)).toEqual({
      price: 20,
      salePrice: 12,
      saleEndsAt: secondEnd,
    });
    expect(await priceLogOf(product.id)).toEqual([
      saleStart({ percent: 25 }, 20, 15, firstEnd),
      saleStart({ amount: 8 }, 20, 12, secondEnd),
    ]);
    expect((await productAuditOf(product.id)).at(-1)).toEqual(
      saleAudit('change', {
        price: ['20', '20'],
        before: { salePrice: '15', endsAt: firstEnd },
        after: { salePrice: '12', endsAt: secondEnd },
        discount: { amount: 8 },
      }),
    );
  });

  it('takes a sale off: the product sells at its price again', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);
    await patchSale(product.id, { sale: { percent: 25, endsAt } });

    const res = await patchSale(product.id, { sale: null });

    expect(res.statusCode).toBe(200);
    // the answer of an admin names the empty sale
    expect(res.json()).toMatchObject({
      id: product.id,
      price: 20,
      salePrice: null,
      saleEndsAt: null,
    });
    expect(await saleRowOf(product.id)).toEqual({ price: 20, salePrice: null, saleEndsAt: null });
    expect(await priceLogOf(product.id)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
      saleTakenOff(15, 20),
    ]);
    expect((await productAuditOf(product.id)).at(-1)).toEqual(
      saleAudit('removed', { price: ['20', '20'], before: { salePrice: '15', endsAt } }),
    );
  });

  // done already: nothing is written and the admin is told so
  it('refuses to take off a sale a product does not have', async () => {
    const product = await newProduct(20);

    const res = await patchSale(product.id, { sale: null });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ALREADY_REMOVED' });
    expect(await priceLogOf(product.id)).toEqual([]);
    expect(await productAuditOf(product.id)).toEqual([]);
  });

  it('refuses to take off a sale twice', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);
    await patchSale(product.id, { sale: { percent: 25, endsAt } });
    await patchSale(product.id, { sale: null });

    const res = await patchSale(product.id, { sale: null });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ALREADY_REMOVED' });
    expect(await priceLogOf(product.id)).toHaveLength(2);
    expect(await productAuditOf(product.id)).toHaveLength(2);
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
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ALREADY_SET' });
    expect(await priceLogOf(product.id)).toEqual([saleStart({ percent: 25 }, 20, 15, endsAt)]);
    expect(await productAuditOf(product.id)).toHaveLength(1);
  });

  it('changes a sale that is on to another end only', async () => {
    const product = await newProduct(20);
    const firstEnd = inMs(DAY);
    const secondEnd = inMs(2 * DAY);
    await patchSale(product.id, { sale: { percent: 25, endsAt: firstEnd } });

    const res = await patchSale(product.id, { sale: { percent: 25, endsAt: secondEnd } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ salePrice: 15, saleEndsAt: secondEnd });
    expect((await productAuditOf(product.id)).at(-1)).toEqual(
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
  ])('refuses %s', async (_case, payload) => {
    const product = await newProduct(20);

    const res = await patchSale(product.id, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await saleRowOf(product.id)).toMatchObject({ salePrice: null, saleEndsAt: null });
    expect(await priceLogOf(product.id)).toEqual([]);
    expect(await productAuditOf(product.id)).toEqual([]);
  });

  it('refuses an amount above the price, naming the price', async () => {
    const product = await newProduct(20);

    const res = await patchSale(product.id, { sale: { amount: 25, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { price: 20 },
    });
    expect(await saleRowOf(product.id)).toMatchObject({ salePrice: null });
    expect(await priceLogOf(product.id)).toEqual([]);
    expect(await productAuditOf(product.id)).toEqual([]);
  });

  // the sale price has to stay below the price once it is rounded to cents
  it.each([
    ['a percent of a price of a few cents', 0.05, { percent: 1 }],
    ['an amount below half a cent', 20, { amount: 0.004 }],
    ['any discount of a free product', 0, { percent: 50 }],
  ])('refuses a discount that comes to nothing: %s', async (_case, price, discount) => {
    const product = await newProduct(price);

    const res = await patchSale(product.id, { sale: { ...discount, endsAt: inMs(DAY) } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_TOO_SMALL' });
    expect(await saleRowOf(product.id)).toMatchObject({ salePrice: null });
  });

  it.each([
    ['in the past', -60_000],
    ['at the moment of the request', 0],
  ])('refuses an end %s', async (_case, ms) => {
    const product = await newProduct(20);

    const res = await patchSale(product.id, { sale: { percent: 10, endsAt: inMs(ms) } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID' });
    expect(await saleRowOf(product.id)).toMatchObject({ salePrice: null });
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
    expect(await saleRowOf(product.id)).toMatchObject({ salePrice: null });
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
    expect(await saleRowOf(product.id)).toMatchObject({ salePrice: null });
  });
});

// a price change of a product with a sale that is on says what happens to the sale: keep it, take
// it off, or a new one. Each goes step by step with every line of the logs: the old sale off, the
// price, the new sale from the new price; all of it or nothing
describe('PATCH /api/products/:productId with a sale on', () => {
  const productOnSale = async (endsAt = inMs(DAY)) => {
    const product = await newProduct(20);
    await patchSale(product.id, { sale: { percent: 25, endsAt } });
    return { product, endsAt };
  };

  const patchForm = (productId: number, fields: Record<string, string>) => {
    const { payload, headers } = multipartBody(
      Object.entries(fields).map(([name, value]) => ({ name, value })),
    );
    return app.inject({
      method: 'PATCH',
      url: `/api/products/${productId}`,
      headers: { ...withCsrf(csrf, accessCookie(admin)), ...headers },
      payload,
    });
  };

  it('asks what to do with the sale and changes nothing', async () => {
    const { product, endsAt } = await productOnSale();

    const res = await patchProduct(product.id, { price: 25 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_DECISION_REQUIRED',
      details: { salePrice: 15, saleEndsAt: endsAt },
    });
    expect(await saleRowOf(product.id)).toEqual({ price: 20, salePrice: 15, saleEndsAt: endsAt });
    expect(await priceLogOf(product.id)).toEqual([saleStart({ percent: 25 }, 20, 15, endsAt)]);
  });

  it('keeps the sale and changes the price only', async () => {
    const { product, endsAt } = await productOnSale();

    const res = await patchProduct(product.id, { price: 25, sale: 'keep' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 25, salePrice: 15, saleEndsAt: endsAt });
    expect(await priceLogOf(product.id)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
      priceChange('fixed', 20, 25, 5),
    ]);
  });

  it.each([
    ['to the sale price', 15],
    ['below it', 12],
  ])('refuses to keep a sale the price goes down %s, and changes nothing', async (_case, price) => {
    const { product, endsAt } = await productOnSale();

    const res = await patchProduct(product.id, { price, sale: 'keep' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_NOT_BELOW_PRICE',
      details: { salePrice: 15, price },
    });
    expect(await saleRowOf(product.id)).toEqual({ price: 20, salePrice: 15, saleEndsAt: endsAt });
  });

  it('takes the sale off, then changes the price', async () => {
    const { product, endsAt } = await productOnSale();

    const res = await patchProduct(product.id, { price: 12, sale: null });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 12, salePrice: null, saleEndsAt: null });
    expect(await priceLogOf(product.id)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
      saleTakenOff(15, 20),
      priceChange('fixed', 20, 12, -8),
    ]);
    expect((await productAuditOf(product.id)).slice(1)).toEqual([
      saleAudit('removed', { price: ['20', '20'], before: { salePrice: '15', endsAt } }),
      {
        action: 'PRODUCT_UPDATE',
        actorId: admin.id,
        meta: [{ field: 'price', old: '20', new: '12' }],
      },
    ]);
  });

  it('takes the old sale off, changes the price and puts the new sale on', async () => {
    const { product, endsAt } = await productOnSale();
    const newEnd = inMs(2 * DAY);

    const res = await patchProduct(product.id, {
      price: 30,
      sale: { amount: 5, endsAt: newEnd },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 30, salePrice: 25, saleEndsAt: newEnd });
    expect(await priceLogOf(product.id)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
      saleTakenOff(15, 20),
      priceChange('fixed', 20, 30, 10),
      saleStart({ amount: 5 }, 30, 25, newEnd),
    ]);
    expect((await productAuditOf(product.id)).slice(1)).toEqual([
      saleAudit('removed', { price: ['20', '20'], before: { salePrice: '15', endsAt } }),
      {
        action: 'PRODUCT_UPDATE',
        actorId: admin.id,
        meta: [{ field: 'price', old: '20', new: '30' }],
      },
      saleAudit('start', {
        price: ['30', '30'],
        after: { salePrice: '25', endsAt: newEnd },
        discount: { amount: 5 },
      }),
    ]);
  });

  // the new sale is counted from the new price: refused, it leaves everything as it was
  it('refuses a new sale that does not fit the new price and changes nothing', async () => {
    const { product, endsAt } = await productOnSale();

    const res = await patchProduct(product.id, {
      price: 30,
      sale: { amount: 40, endsAt: inMs(DAY) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_AMOUNT_TOO_HIGH',
      details: { price: 30 },
    });
    expect(await saleRowOf(product.id)).toEqual({ price: 20, salePrice: 15, saleEndsAt: endsAt });
    expect(await priceLogOf(product.id)).toHaveLength(1);
  });

  it('puts a sale on together with the price of a product without one', async () => {
    const product = await newProduct(20);
    const endsAt = inMs(DAY);

    const res = await patchProduct(product.id, {
      price: 30,
      sale: { percent: 50, endsAt },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 30, salePrice: 15, saleEndsAt: endsAt });
    expect(await priceLogOf(product.id)).toEqual([
      priceChange('fixed', 20, 30, 10),
      saleStart({ percent: 50 }, 30, 15, endsAt),
    ]);
  });

  it('needs no word on the sale for a product without one', async () => {
    const product = await newProduct(20);

    const res = await patchProduct(product.id, { price: 18 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 18 });
    expect(await priceLogOf(product.id)).toEqual([priceChange('fixed', 20, 18, -2)]);
  });

  it('needs no word on the sale for a change that leaves the price', async () => {
    const { product, endsAt } = await productOnSale();

    const res = await patchProduct(product.id, { name: 'Renamed on sale' });

    expect(res.statusCode).toBe(200);
    expect(await saleRowOf(product.id)).toEqual({ price: 20, salePrice: 15, saleEndsAt: endsAt });
  });

  // the sale alone has a route of its own
  it('refuses a word on the sale without a price', async () => {
    const { product } = await productOnSale();

    const res = await patchProduct(product.id, { sale: 'keep' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_REQUIRES_PRICE' });
  });

  describe('in a form', () => {
    it('asks what to do with the sale', async () => {
      const { product } = await productOnSale();

      const res = await patchForm(product.id, { price: '25' });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_DECISION_REQUIRED' });
    });

    it.each([
      ['keep', { price: 25, salePrice: 15 }],
      ['remove', { price: 25, salePrice: null }],
    ])('takes sale=%s', async (sale, row) => {
      const { product } = await productOnSale();

      const res = await patchForm(product.id, { price: '25', sale });

      expect(res.statusCode).toBe(200);
      expect(await saleRowOf(product.id)).toMatchObject(row);
    });

    // a new sale needs its fields, it comes as json or through the sale route
    it('refuses another word on the sale', async () => {
      const { product } = await productOnSale();

      const res = await patchForm(product.id, { price: '25', sale: 'percent:10' });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ACTION_INVALID' });
    });
  });
});

// the prices of many products say what happens to their sales, the same for every one: keep them,
// or take them off; a new sale is set product by product. Taken off, each goes the way of one
// product: the sale off with its lines, then the price. All of it or nothing
describe('PATCH /api/products with a sale on', () => {
  const bulk = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: '/api/products',
      headers: withCsrf(csrf, accessCookie(admin)),
      payload,
    });

  // a product on sale and one without, in their own categories
  const scopeOf = async () => {
    const onSale = await newProduct(20);
    const endsAt = inMs(DAY);
    await patchSale(onSale.id, { sale: { percent: 25, endsAt } });
    const plain = await newProduct(20);
    return { onSale, plain, endsAt, scope: { productIds: [onSale.id, plain.id] } };
  };

  it('asks what to do with the sales of the scope and changes nothing', async () => {
    const { onSale, plain, endsAt, scope } = await scopeOf();

    const res = await bulk({ mode: 'fixed', value: 5, scope });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_DECISION_REQUIRED',
      details: { products: [{ productId: onSale.id, salePrice: 15, saleEndsAt: endsAt }] },
    });
    expect((await saleRowOf(onSale.id)).price).toBe(20);
    expect((await saleRowOf(plain.id)).price).toBe(20);
  });

  it('counts the scope of a dry run without a word on the sales', async () => {
    const { scope } = await scopeOf();

    const res = await bulk({ mode: 'fixed', value: 5, scope, dryRun: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updatedCount: 2 });
  });

  it('keeps every sale and changes the prices', async () => {
    const { onSale, plain, endsAt, scope } = await scopeOf();

    const res = await bulk({ mode: 'fixed', value: 5, scope, sale: 'keep' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ updatedCount: 2 });
    expect(await saleRowOf(onSale.id)).toEqual({ price: 25, salePrice: 15, saleEndsAt: endsAt });
    expect((await saleRowOf(plain.id)).price).toBe(25);
  });

  it('refuses to keep a sale a new price goes down to, and changes no product', async () => {
    const { onSale, plain, endsAt, scope } = await scopeOf();

    const res = await bulk({ mode: 'percent', value: -50, scope, sale: 'keep' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_SALE_NOT_BELOW_PRICE',
      details: { products: [{ productId: onSale.id, salePrice: 15, price: 10 }] },
    });
    expect(await saleRowOf(onSale.id)).toEqual({ price: 20, salePrice: 15, saleEndsAt: endsAt });
    expect((await saleRowOf(plain.id)).price).toBe(20);
  });

  it('takes every sale off the way of one product, then changes the prices', async () => {
    const { onSale, plain, endsAt, scope } = await scopeOf();

    const res = await bulk({ mode: 'percent', value: -50, scope, sale: 'remove' });

    expect(res.statusCode).toBe(200);
    expect(await saleRowOf(onSale.id)).toEqual({ price: 10, salePrice: null, saleEndsAt: null });
    expect(await priceLogOf(onSale.id)).toEqual([
      saleStart({ percent: 25 }, 20, 15, endsAt),
      saleTakenOff(15, 20),
      priceChange('percent', 20, 10, -50),
    ]);
    expect((await productAuditOf(onSale.id)).at(-1)).toEqual(
      saleAudit('removed', { price: ['20', '20'], before: { salePrice: '15', endsAt } }),
    );
    expect(await priceLogOf(plain.id)).toEqual([priceChange('percent', 20, 10, -50)]);
  });

  it('needs no word on the sales for a scope without one', async () => {
    const product = await newProduct(20);

    const res = await bulk({ mode: 'fixed', value: 5, scope: { productIds: [product.id] } });

    expect(res.statusCode).toBe(200);
    expect((await saleRowOf(product.id)).price).toBe(25);
  });

  it('refuses another word on the sales', async () => {
    const { scope } = await scopeOf();

    const res = await bulk({ mode: 'fixed', value: 5, scope, sale: { percent: 10 } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('a sale in the answers', () => {
  let onSale: TestProduct;
  let endsAt: string;

  beforeAll(async () => {
    onSale = await newProduct(20);
    endsAt = inMs(DAY);
    const res = await patchSale(onSale.id, { sale: { percent: 25, endsAt } });
    if (res.statusCode !== 200) throw new Error(`the sale route answered ${res.statusCode}`);
  });

  it('shows the sale next to the price on the page of the product', async () => {
    const res = await getProduct(onSale.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 20, salePrice: 15, saleEndsAt: endsAt });
  });

  it('shows no sale of a product without one', async () => {
    const product = await newProduct(20);

    const res = await getProduct(product.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('salePrice');
    expect(res.json()).not.toHaveProperty('saleEndsAt');
  });

  it('shows the sale in the catalog', async () => {
    const res = await listProducts({ categoryIds: String(onSale.categoryId) });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({ id: onSale.id, price: 20, salePrice: 15, saleEndsAt: endsAt }),
    ]);
  });

  it('shows the sale in the favorites', async () => {
    const user = await newUser();
    await createFavorite(user.id, onSale.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/favorites',
      headers: { cookie: accessCookie(user) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        product: expect.objectContaining({ id: onSale.id, salePrice: 15, saleEndsAt: endsAt }),
      }),
    ]);
  });
});

describe('GET /api/products and the price a product sells at', () => {
  let cheap: TestProduct;
  let onSale: TestProduct;
  let middle: TestProduct;
  let categoryIds: string;

  beforeAll(async () => {
    cheap = await newProduct(10);
    onSale = await newProduct(30);
    middle = await newProduct(20);
    await putOnSale(onSale.id, 5);
    categoryIds = [cheap, onSale, middle].map((product) => product.categoryId).join(',');
  });

  it.each([
    ['asc', () => [onSale.id, cheap.id, middle.id]],
    ['desc', () => [middle.id, cheap.id, onSale.id]],
  ])('sorts by it going %s', async (order, ids) => {
    const res = await listProducts({ categoryIds, sort: 'price', order });

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual(ids());
  });

  it('filters by it', async () => {
    const below = await listProducts({ categoryIds, maxPrice: '8' });
    const above = await listProducts({ categoryIds, minPrice: '25' });

    expect(idsOf(below)).toEqual([onSale.id]);
    expect(idsOf(above)).toEqual([]);
  });

  it('sorts and filters a search by it', async () => {
    const res = await listProducts({
      categoryIds,
      search: 'Test product',
      sort: 'price',
      order: 'asc',
      maxPrice: '15',
    });

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([onSale.id, cheap.id]);
  });

  it('pages through a sort by it', async () => {
    const seen: number[] = [];
    let cursor: string | undefined;

    do {
      const res = await listProducts({
        categoryIds,
        sort: 'price',
        order: 'asc',
        limit: '1',
        ...(cursor ? { cursor } : {}),
      });
      expect(res.statusCode).toBe(200);
      seen.push(...idsOf(res));
      cursor = res.json().nextCursor;
    } while (cursor && seen.length < 10);

    expect(seen).toEqual([onSale.id, cheap.id, middle.id]);
  });
});

describe('the cart and a sale', () => {
  it('takes the sale price for an item', async () => {
    const user = await newUser();
    const product = await newProduct(20);
    await putOnSale(product.id, 15);

    const res = await addToCart(user, product.id, 2);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      total: 30,
      items: [expect.objectContaining({ productId: product.id, unitPrice: 15, totalPrice: 30 })],
    });
  });

  it('confirms an order at the sale price', async () => {
    const user = await newUser();
    const product = await newProduct(20);
    await putOnSale(product.id, 15);
    const added = await addToCart(user, product.id, 2);

    const res = await confirm(user, added.json().id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'waiting', total: 30 });
  });

  // the smallest payment is checked at the price the order is confirmed with
  it('refuses a total below the smallest payment at the sale price', async () => {
    const user = await newUser();
    const product = await newProduct(1);
    await putOnSale(product.id, 0.1);
    const added = await addToCart(user, product.id, 1);

    const res = await confirm(user, added.json().id);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_TOTAL_BELOW_MINIMUM' });
  });

  // a free product is bought together with something that costs the smallest payment
  it('confirms a free item next to a paid one', async () => {
    const user = await newUser();
    const free = await newProduct(10);
    const paid = await newProduct(1);
    await putOnSale(free.id, 0);
    await addToCart(user, free.id, 1);
    const added = await addToCart(user, paid.id, 1);

    const res = await confirm(user, added.json().id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'waiting', total: 1 });
  });

  it('refuses an order of a free item alone', async () => {
    const user = await newUser();
    const free = await newProduct(10);
    await putOnSale(free.id, 0);
    const added = await addToCart(user, free.id, 1);

    const res = await confirm(user, added.json().id);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_TOTAL_BELOW_MINIMUM' });
  });
});

// sales that end a moment after they start: the tests wait for the end by both clocks, the one of
// the database that prices the orders and the one of the app that answers
describe('a sale past its end', () => {
  const ENDS_IN_MS = 1_500;
  let shown: TestProduct;
  let listed: TestProduct;
  let carted: TestProduct;
  let takenOff: TestProduct;
  let writtenOver: TestProduct;
  let priceDown: TestProduct;
  let buyer: TestUser;
  let orderId: number;

  beforeAll(async () => {
    [shown, listed, carted, takenOff, writtenOver, priceDown] = (await Promise.all(
      Array.from({ length: 6 }, () => newProduct(20)),
    )) as [TestProduct, TestProduct, TestProduct, TestProduct, TestProduct, TestProduct];
    const all = [shown, listed, carted, takenOff, writtenOver, priceDown];
    for (const product of all) await putOnSale(product.id, 15, ENDS_IN_MS);

    // an item put in the cart while the sale was on, at the sale price
    buyer = await newUser();
    const added = await addToCart(buyer, carted.id, 1);
    if (added.json().items?.[0]?.unitPrice !== 15) {
      throw new Error('the cart did not take the sale price before the end of the sale');
    }
    orderId = added.json().id;

    await waitForSalesEnd(all.map((product) => product.id));
  });

  it('leaves the sale out of the page of the product', async () => {
    const res = await getProduct(shown.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 20 });
    expect(res.json()).not.toHaveProperty('salePrice');
    expect(res.json()).not.toHaveProperty('saleEndsAt');
  });

  // an admin sees the fields of the row, a sale past its end too
  it('shows an admin the sale that is over as the row keeps it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/products/${shown.id}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 20, salePrice: 15 });
    expect(Date.parse(res.json().saleEndsAt)).toBeLessThanOrEqual(Date.now());
  });

  it('sorts and filters the catalog by the price again', async () => {
    const atSalePrice = await listProducts({
      categoryIds: String(listed.categoryId),
      maxPrice: '16',
    });
    const atPrice = await listProducts({ categoryIds: String(listed.categoryId), maxPrice: '20' });

    expect(idsOf(atSalePrice)).toEqual([]);
    expect(idsOf(atPrice)).toEqual([listed.id]);
    expect(atPrice.json().items[0]).not.toHaveProperty('salePrice');
  });

  it('refuses to confirm an item at the sale price, the cart then shows the price', async () => {
    const res = await confirm(buyer, orderId);
    const cart = await app.inject({
      method: 'GET',
      url: '/api/orders/current',
      headers: { cookie: accessCookie(buyer) },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_PRICES_CHANGED' });
    expect(cart.json()).toMatchObject({
      total: 20,
      items: [expect.objectContaining({ productId: carted.id, unitPrice: 20 })],
    });
  });

  // a sale that is over is no sale: there is nothing to take off, its fields stay in the row
  it('refuses to take off a sale that is over and writes nothing', async () => {
    const before = await saleRowOf(takenOff.id);

    const res = await patchSale(takenOff.id, { sale: null });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ALREADY_REMOVED' });
    expect(await saleRowOf(takenOff.id)).toEqual(before);
    expect(await priceLogOf(takenOff.id)).toEqual([]);
    expect(await productAuditOf(takenOff.id)).toEqual([]);
  });

  // a sale that is over was no sale: the new one starts, it changes none
  it('writes a new sale over it, from the price', async () => {
    const endsAt = inMs(DAY);

    const res = await patchSale(writtenOver.id, { sale: { amount: 2, endsAt } });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ salePrice: 18, saleEndsAt: endsAt });
    expect(await priceLogOf(writtenOver.id)).toEqual([saleStart({ amount: 2 }, 20, 18, endsAt)]);
    expect(await productAuditOf(writtenOver.id)).toEqual([
      saleAudit('start', {
        price: ['20', '20'],
        after: { salePrice: '18', endsAt },
        discount: { amount: 2 },
      }),
    ]);
  });

  it('empties it with no line of its end when the price goes down to it', async () => {
    const res = await patchProduct(priceDown.id, { price: 14 });

    expect(res.statusCode).toBe(200);
    expect(await saleRowOf(priceDown.id)).toEqual({ price: 14, salePrice: null, saleEndsAt: null });
    expect(await priceLogOf(priceDown.id)).toEqual([priceChange('fixed', 20, 14, -6)]);
    expect((await productAuditOf(priceDown.id)).map((line) => line.action)).toEqual([
      'PRODUCT_UPDATE',
    ]);
  });
});
