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
  deleteProductFromCatalog,
  receiveBatch,
  stockOf,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';

// POST /api/products/stock/deliveries and /write-offs: the stock of a product comes only with a
// delivery and goes out with a write-off (or a sale). A delivery takes in a batch of each of its
// products at its cost; a write-off takes free units from the batch named, or from the batches in
// the order a sale takes them (the one that ends first, then the oldest). The database keeps the
// batches and a line of the admin log for each product; a request changes all or nothing

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
// a product with batches keeps them, an order keeps its product: these stay for the run
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// a product without stock unless asked: the test takes in its own batches
const newProduct = async (opts: { stock?: number; price?: number } = {}) => {
  const product = await createProduct({ stock: 0, ...opts });
  products.push(product);
  return product;
};

const post = (path: string, payload: object, actor: TestUser = admin) =>
  app.inject({
    method: 'POST',
    url: `/api/products/stock/${path}`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

const deliver = (payload: object, actor?: TestUser) => post('deliveries', payload, actor);
const writeOff = (payload: object, actor?: TestUser) => post('write-offs', payload, actor);

const batchesOf = (productId: number) =>
  asAdmin((tx) =>
    tx.productBatch.findMany({
      where: { productId },
      orderBy: { id: 'asc' },
      select: { id: true, remaining: true },
    }),
  );

const linesOf = (productId: number, action: 'STOCK_DELIVERY' | 'STOCK_WRITE_OFF') =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'product', entityId: productId, action },
      orderBy: { id: 'asc' },
      select: { actorId: true, meta: true },
    }),
  );

type Change = { field: string; new: unknown };
const fieldOf = (meta: unknown, field: string) =>
  (meta as Change[]).find((change) => change.field === field)?.new;

// a day by the calendar of utc, yyyy-mm-dd
const utcDay = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('POST /api/products/stock/deliveries', () => {
  it('takes in the batches of a delivery of several products and answers with them', async () => {
    const first = await newProduct();
    const second = await newProduct();

    const res = await deliver({
      source: 'supplier',
      supplier: 'Acme',
      document: 'INV-1',
      note: 'Morning truck',
      items: [
        {
          productId: first.id,
          quantity: 10,
          unitCost: 2.5,
          expiresAt: utcDay(90),
          supplierBatchNumber: 'LOT-A',
        },
        { productId: second.id, quantity: 4, unitCost: 0 },
      ],
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.deliveryId).toMatch(UUID);
    expect(body.batches).toEqual([
      {
        id: expect.any(Number),
        productId: first.id,
        source: 'supplier',
        supplierBatchNumber: 'LOT-A',
        unitCost: 2.5,
        quantity: 10,
        remaining: 10,
        expiresAt: utcDay(90),
        createdAt: expect.any(String),
      },
      {
        id: expect.any(Number),
        productId: second.id,
        source: 'supplier',
        supplierBatchNumber: null,
        unitCost: 0,
        quantity: 4,
        remaining: 4,
        expiresAt: null,
        createdAt: expect.any(String),
      },
    ]);
    expect(body.products).toEqual([
      { id: first.id, stock: 10, totalStock: 10, reservedStock: 0, expiredStock: 0 },
      { id: second.id, stock: 4, totalStock: 4, reservedStock: 0, expiredStock: 0 },
    ]);
    expect(await stockOf(first.id)).toEqual({ stock: 10, reservedStock: 0 });

    // a line for each product, the same delivery in each
    const [line] = await linesOf(first.id, 'STOCK_DELIVERY');
    expect(line!.actorId).toBe(admin.id);
    expect(fieldOf(line!.meta, 'delivery')).toBe(body.deliveryId);
    expect(fieldOf(line!.meta, 'supplier')).toBe('Acme');
    expect(fieldOf(line!.meta, 'document')).toBe('INV-1');
    expect(fieldOf(line!.meta, 'note')).toBe('Morning truck');
    expect(fieldOf((await linesOf(second.id, 'STOCK_DELIVERY'))[0]!.meta, 'delivery')).toBe(
      body.deliveryId,
    );
  });

  it('takes in two batches of one product in one delivery, the product answers once', async () => {
    const product = await newProduct();

    const res = await deliver({
      source: 'supplier',
      items: [
        { productId: product.id, quantity: 3, unitCost: 1, expiresAt: utcDay(10) },
        { productId: product.id, quantity: 2, unitCost: 1.2, expiresAt: utcDay(40) },
      ],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().batches).toHaveLength(2);
    expect(res.json().products).toEqual([
      { id: product.id, stock: 5, totalStock: 5, reservedStock: 0, expiredStock: 0 },
    ]);
  });

  // an inventory finds more than the stock says, a buyer brings goods back: the admin gives the
  // cost they count at
  it.each(['surplus', 'customer_return'])('takes in a batch of %s', async (source) => {
    const product = await newProduct();

    const res = await deliver({
      source,
      items: [{ productId: product.id, quantity: 1, unitCost: 4 }],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().batches[0]).toMatchObject({ source, unitCost: 4 });
  });

  it('lets root take in a delivery', async () => {
    const product = await newProduct();

    const res = await deliver(
      { source: 'supplier', items: [{ productId: product.id, quantity: 1, unitCost: 1 }] },
      root,
    );

    expect(res.statusCode).toBe(201);
  });

  it('takes in nothing when one product of the delivery cannot take it', async () => {
    const kept = await newProduct();
    const removed = await newProduct();
    await deleteProductFromCatalog(removed.id);

    const res = await deliver({
      source: 'supplier',
      items: [
        { productId: kept.id, quantity: 5, unitCost: 1 },
        { productId: removed.id, quantity: 5, unitCost: 1 },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_NOT_FOUND',
      details: { productId: removed.id },
    });
    expect(await batchesOf(kept.id)).toEqual([]);
    expect(await stockOf(kept.id)).toEqual({ stock: 0, reservedStock: 0 });
  });

  it('refuses a product that does not exist', async () => {
    const res = await deliver({
      source: 'supplier',
      items: [{ productId: 2_000_000_000, quantity: 1, unitCost: 1 }],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('refuses a cost finer than a cent', async () => {
    const product = await newProduct();

    const res = await deliver({
      source: 'supplier',
      items: [{ productId: product.id, quantity: 1, unitCost: 1.555 }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'BATCH_UNIT_COST_INVALID' });
    expect(await batchesOf(product.id)).toEqual([]);
  });

  it('refuses a batch whose last good day is over and takes one good until today', async () => {
    const product = await newProduct();
    const item = (expiresAt: string) => ({
      productId: product.id,
      quantity: 1,
      unitCost: 1,
      expiresAt,
    });

    const over = await deliver({ source: 'supplier', items: [item(utcDay(-1))] });
    const today = await deliver({ source: 'supplier', items: [item(utcDay(0))] });

    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ errorCode: 'BATCH_EXPIRES_AT_INVALID' });
    expect(today.statusCode).toBe(201);
  });

  it.each([
    ['no items', { items: [] }],
    ['no source', { source: undefined }],
    ['an unknown source', { source: 'gift' }],
    ['no units', { items: [{ quantity: 0 }] }],
    ['a part of a unit', { items: [{ quantity: 1.5 }] }],
    ['a cost below zero', { items: [{ unitCost: -1 }] }],
    ['a cost that is not a number', { items: [{ unitCost: 'cheap' }] }],
    ['an end that is not a day', { items: [{ expiresAt: '2026-13-01' }] }],
    ['a supplier name over 200 characters', { supplier: 'x'.repeat(201) }],
    ['an invoice over 100 characters', { document: 'x'.repeat(101) }],
    ['a note over 500 characters', { note: 'x'.repeat(501) }],
    [
      'a number of the supplier over 100 characters',
      { items: [{ supplierBatchNumber: 'x'.repeat(101) }] },
    ],
  ])('refuses a delivery with %s', async (_case, patch) => {
    const product = await newProduct();
    const base = {
      source: 'supplier',
      items: [{ productId: product.id, quantity: 1, unitCost: 1 }],
    };
    const { items, ...rest } = patch as { items?: object[] };
    const payload = {
      ...base,
      ...rest,
      items: items ? items.map((item) => ({ ...base.items[0], ...item })) : base.items,
    };

    const res = await deliver(payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await batchesOf(product.id)).toEqual([]);
  });

  it('refuses more than 100 items in a delivery', async () => {
    const product = await newProduct();
    const items = Array.from({ length: 101 }, () => ({
      productId: product.id,
      quantity: 1,
      unitCost: 1,
    }));

    const res = await deliver({ source: 'supplier', items });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a user', async () => {
    const product = await newProduct();

    const res = await deliver(
      { source: 'supplier', items: [{ productId: product.id, quantity: 1, unitCost: 1 }] },
      await newUser(),
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('refuses a request without the csrf token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/products/stock/deliveries',
      headers: { cookie: accessCookie(admin) },
      payload: { source: 'supplier', items: [{ productId: 1, quantity: 1, unitCost: 1 }] },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
  });
});

describe('POST /api/products/stock/write-offs', () => {
  it('writes off units of the batch an admin names and answers with what it took', async () => {
    const product = await newProduct();
    const first = await receiveBatch(product.id, { quantity: 4, unitCost: 2 });
    const second = await receiveBatch(product.id, { quantity: 5, unitCost: 3 });

    const res = await writeOff({
      reason: 'damaged',
      note: 'Wet box',
      items: [{ productId: product.id, batchId: second, quantity: 2 }],
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.writeOffId).toMatch(UUID);
    expect(body.items).toEqual([
      {
        productId: product.id,
        quantity: 2,
        batches: [{ batchId: second, quantity: 2, unitCost: 3 }],
      },
    ]);
    expect(body.products).toEqual([
      { id: product.id, stock: 7, totalStock: 7, reservedStock: 0, expiredStock: 0 },
    ]);
    expect(await batchesOf(product.id)).toEqual([
      { id: first, remaining: 4 },
      { id: second, remaining: 3 },
    ]);

    const [line] = await linesOf(product.id, 'STOCK_WRITE_OFF');
    expect(line!.actorId).toBe(admin.id);
    expect(fieldOf(line!.meta, 'reason')).toBe('damaged');
    expect(fieldOf(line!.meta, 'writeOff')).toBe(body.writeOffId);
    expect(fieldOf(line!.meta, 'note')).toBe('Wet box');
  });

  it('writes off from the batches in the order a sale takes them when no batch is named', async () => {
    const product = await newProduct();
    const noEnd = await receiveBatch(product.id, { quantity: 3, unitCost: 1 });
    const soon = await receiveBatch(product.id, { quantity: 2, unitCost: 2, expiresAt: utcDay(5) });

    const res = await writeOff({
      reason: 'shortage',
      items: [{ productId: product.id, quantity: 3 }],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().items[0].batches).toEqual([
      { batchId: soon, quantity: 2, unitCost: 2 },
      { batchId: noEnd, quantity: 1, unitCost: 1 },
    ]);
  });

  // the batch named gives its units first, the rest of the product follows the order of a sale
  it('takes the units of a batch named before the units of the same product without one', async () => {
    const product = await newProduct();
    const older = await receiveBatch(product.id, { quantity: 3, unitCost: 1 });
    const named = await receiveBatch(product.id, {
      quantity: 2,
      unitCost: 2,
      expiresAt: utcDay(5),
    });

    const res = await writeOff({
      reason: 'expired',
      items: [
        { productId: product.id, quantity: 3 },
        { productId: product.id, batchId: named, quantity: 2 },
      ],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().items).toEqual([
      {
        productId: product.id,
        quantity: 3,
        batches: [{ batchId: older, quantity: 3, unitCost: 1 }],
      },
      {
        productId: product.id,
        quantity: 2,
        batches: [{ batchId: named, quantity: 2, unitCost: 2 }],
      },
    ]);
    expect(await stockOf(product.id)).toEqual({ stock: 0, reservedStock: 0 });
  });

  it('writes off nothing when one product has not enough free units, and names each of them', async () => {
    const plenty = await newProduct({ stock: 5 });
    const scarce = await newProduct({ stock: 1 });

    const res = await writeOff({
      reason: 'damaged',
      items: [
        { productId: plenty.id, quantity: 2 },
        { productId: scarce.id, quantity: 3 },
      ],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'INSUFFICIENT_AVAILABLE_STOCK',
      details: { products: [{ productId: scarce.id, available: 1, requested: 3 }] },
    });
    expect(await stockOf(plenty.id)).toEqual({ stock: 5, reservedStock: 0 });
  });

  it('counts the lines of one product together against its free units', async () => {
    const product = await newProduct({ stock: 3 });

    const res = await writeOff({
      reason: 'damaged',
      items: [
        { productId: product.id, quantity: 2 },
        { productId: product.id, quantity: 2 },
      ],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      details: { products: [{ productId: product.id, available: 3, requested: 4 }] },
    });
  });

  it('keeps the units the waiting orders hold', async () => {
    const product = await newProduct({ stock: 5 });
    await placeOrder(app, csrf, await newUser(), product, 'waiting', 4);

    const res = await writeOff({
      reason: 'damaged',
      items: [{ productId: product.id, quantity: 2 }],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'INSUFFICIENT_AVAILABLE_STOCK',
      details: { products: [{ productId: product.id, available: 1, requested: 2 }] },
    });
    expect(await stockOf(product.id)).toEqual({ stock: 5, reservedStock: 4 });
  });

  it('refuses more than the batch named has left', async () => {
    const product = await newProduct();
    const small = await receiveBatch(product.id, { quantity: 1 });
    await receiveBatch(product.id, { quantity: 5 });

    const res = await writeOff({
      reason: 'damaged',
      items: [{ productId: product.id, batchId: small, quantity: 2 }],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'BATCH_INSUFFICIENT',
      details: { batches: [{ batchId: small, remaining: 1, requested: 2 }] },
    });
  });

  it('refuses a batch of another product', async () => {
    const product = await newProduct({ stock: 2 });
    const foreign = await receiveBatch((await newProduct()).id, { quantity: 2 });

    const res = await writeOff({
      reason: 'damaged',
      items: [{ productId: product.id, batchId: foreign, quantity: 1 }],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'BATCH_NOT_FOUND',
      details: { batchId: foreign },
    });
  });

  it('writes off what a product removed from the catalog has left', async () => {
    const product = await newProduct({ stock: 2 });
    await deleteProductFromCatalog(product.id);

    const res = await writeOff({
      reason: 'defective',
      items: [{ productId: product.id, quantity: 2 }],
    });

    expect(res.statusCode).toBe(201);
    expect(await stockOf(product.id)).toEqual({ stock: 0, reservedStock: 0 });
  });

  it('refuses a product that does not exist', async () => {
    const res = await writeOff({
      reason: 'damaged',
      items: [{ productId: 2_000_000_000, quantity: 1 }],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('asks the reason other for a note that says what it is', async () => {
    const product = await newProduct({ stock: 2 });
    const item = { productId: product.id, quantity: 1 };

    const bare = await writeOff({ reason: 'other', note: '  ', items: [item] });
    const told = await writeOff({ reason: 'other', note: 'Sample for a blogger', items: [item] });

    expect(bare.statusCode).toBe(400);
    expect(bare.json()).toMatchObject({ errorCode: 'WRITE_OFF_NOTE_REQUIRED' });
    expect(told.statusCode).toBe(201);
    expect(await stockOf(product.id)).toEqual({ stock: 1, reservedStock: 0 });
  });

  it.each(['returned_to_supplier', 'shortage'])('writes off with the reason %s', async (reason) => {
    const product = await newProduct({ stock: 1 });

    const res = await writeOff({ reason, items: [{ productId: product.id, quantity: 1 }] });

    expect(res.statusCode).toBe(201);
  });

  it.each([
    ['no items', { items: [] }],
    ['no reason', { reason: undefined }],
    ['an unknown reason', { reason: 'stolen' }],
    ['no units', { items: [{ quantity: 0 }] }],
    ['a note over 500 characters', { note: 'x'.repeat(501) }],
  ])('refuses a write-off with %s', async (_case, patch) => {
    const product = await newProduct({ stock: 2 });
    const base = { reason: 'damaged', items: [{ productId: product.id, quantity: 1 }] };
    const { items, ...rest } = patch as { items?: object[] };
    const payload = {
      ...base,
      ...rest,
      items: items ? items.map((item) => ({ ...base.items[0], ...item })) : base.items,
    };

    const res = await writeOff(payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(await stockOf(product.id)).toEqual({ stock: 2, reservedStock: 0 });
  });

  it('refuses a user', async () => {
    const product = await newProduct({ stock: 1 });

    const res = await writeOff(
      { reason: 'damaged', items: [{ productId: product.id, quantity: 1 }] },
      await newUser(),
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('PATCH /api/products/:productId', () => {
  // the stock changes only with a delivery or a write-off, each with its line and reason
  it('refuses a stock and changes nothing', async () => {
    const product = await newProduct({ stock: 4 });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { name: 'Renamed', stock: 3 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_STOCK_NOT_ALLOWED' });
    expect(await stockOf(product.id)).toEqual({ stock: 4, reservedStock: 0 });
    const { name } = await asAdmin((tx) =>
      tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { name: true } }),
    );
    expect(name).not.toBe('Renamed');
  });
});
