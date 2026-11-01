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
  type TestUser,
} from '../../../helpers/factories.js';

// the admin log keeps the address and the browser of the request a line came from, the lines the
// database functions write too; admin and root read it with filters (GET /api/admin/audit-log)
// and the history of the price of a product (GET /api/products/:productId/price-history). Other
// files write lines at the same time: a test looks only at the lines of its own actors

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let other: TestUser;
let buyer: TestUser;

const AGENT = 'Cartlify admin test browser';

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  other = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, other.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const asActor = (actor: TestUser) => ({
  ...withCsrf(csrf, accessCookie(actor)),
  'user-agent': AGENT,
});

const patchProduct = (actor: TestUser, productId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
    headers: asActor(actor),
    payload,
  });

// the price of a variant is its own: the change is the one of the variant, its line is about it
const patchPrice = (actor: TestUser, product: { id: number; variantId: number }, price: number) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${product.id}/variants/${product.variantId}`,
    headers: asActor(actor),
    payload: { price },
  });

const linesOf = (productId: number, entityType: 'product' | 'variant' = 'product') =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType, entityId: productId },
      orderBy: { id: 'asc' },
      select: { action: true, ip: true, userAgent: true },
    }),
  );

const readLog = (actor: TestUser, query: string) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/audit-log?${query}`,
    headers: { cookie: accessCookie(actor) },
  });

describe('the lines of the admin log', () => {
  it('keep the address and the browser of the request', async () => {
    const product = await createProduct({ price: 10, stock: 0 });

    await patchProduct(admin, product.id, { name: `Renamed ${Date.now()}` });

    expect(await linesOf(product.id)).toEqual([
      { action: 'PRODUCT_UPDATE', ip: '127.0.0.1', userAgent: AGENT },
    ]);
  });

  // a delivery is written by a function of the database, in the name of the admin of the request;
  // the line is about the variant whose stock grew
  it('keep them for the line of a delivery', async () => {
    const product = await createProduct({ price: 10, stock: 0 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/products/stock/deliveries',
      headers: asActor(admin),
      payload: {
        source: 'supplier',
        items: [{ variantId: product.variantId, quantity: 2, unitCost: 1 }],
      },
    });

    expect(res.statusCode).toBe(201);
    expect(await linesOf(product.variantId, 'variant')).toEqual([
      { action: 'STOCK_DELIVERY', ip: '127.0.0.1', userAgent: AGENT },
    ]);
    expect(await linesOf(product.id)).toEqual([]);
  });
});

describe('GET /api/admin/audit-log', () => {
  it('lists the lines of an actor, the newest first, with the actor and the request', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    await patchProduct(other, product.id, { name: `First ${Date.now()}` });
    await patchPrice(other, product, 12);

    const res = await readLog(admin, `actorId=${other.id}`);

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    // the price is the variant's: the line is about the variant
    expect(items[0]).toMatchObject({
      actor: { id: other.id, role: 'ADMIN' },
      actorRole: 'ADMIN',
      entityType: 'variant',
      entityId: product.variantId,
      action: 'OTHER',
      event: 'variant.update',
      changes: [{ field: 'price', old: '10', new: '12' }],
      ip: '127.0.0.1',
      userAgent: AGENT,
      createdAt: expect.any(String),
    });
    expect(items[1]).toMatchObject({ entityType: 'product', entityId: product.id });
    expect((items[0]!.id as number) > (items[1]!.id as number)).toBe(true);
  });

  it('keeps the lines of one thing and of some actions', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    await patchProduct(admin, product.id, { name: `Thing ${Date.now()}` });
    await app.inject({
      method: 'POST',
      url: '/api/products/stock/deliveries',
      headers: asActor(admin),
      payload: {
        source: 'supplier',
        items: [{ variantId: product.variantId, quantity: 1, unitCost: 1 }],
      },
    });

    const ofProduct = await readLog(admin, `entityType=product&entityId=${product.id}`);
    const ofVariant = await readLog(admin, `entityType=variant&entityId=${product.variantId}`);
    const deliveries = await readLog(
      admin,
      `entityType=variant&entityId=${product.variantId}&actions=STOCK_DELIVERY,STOCK_WRITE_OFF`,
    );

    // the name is the product's, the stock is the variant's
    expect(ofProduct.json().items.map((line: { action: string }) => line.action)).toEqual([
      'PRODUCT_UPDATE',
    ]);
    expect(ofVariant.json().items.map((line: { action: string }) => line.action)).toEqual([
      'STOCK_DELIVERY',
    ]);
    expect(deliveries.json().items).toEqual([
      expect.objectContaining({
        entityType: 'variant',
        entityId: product.variantId,
        action: 'STOCK_DELIVERY',
        event: 'stock.delivery',
      }),
    ]);
  });

  // the lines of the stock name the events of the dictionary, for a delivery and for a write-off
  it('keeps the lines of the stock events of a variant, a delivery and a write-off', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    const operationIds: string[] = [];
    for (const [url, payload] of [
      [
        '/api/products/stock/deliveries',
        {
          source: 'supplier',
          items: [{ variantId: product.variantId, quantity: 3, unitCost: 1 }],
        },
      ],
      [
        '/api/products/stock/write-offs',
        { reason: 'damaged', items: [{ variantId: product.variantId, quantity: 1 }] },
      ],
    ] as const) {
      const res = await app.inject({ method: 'POST', url, headers: asActor(admin), payload });
      expect(res.statusCode).toBe(201);
      // the answer names the operation; its line in the admin log carries the same id
      operationIds.push(res.json().deliveryId ?? res.json().writeOffId);
    }

    const both = await readLog(
      admin,
      `entityType=variant&entityId=${product.variantId}&events=stock.delivery,stock.write_off&sortOrder=asc`,
    );
    const onlyWriteOffs = await readLog(
      admin,
      `entityType=variant&entityId=${product.variantId}&events=stock.write_off`,
    );

    expect(both.statusCode).toBe(200);
    expect(
      both.json().items.map((line: { event: string; action: string }) => [line.event, line.action]),
    ).toEqual([
      ['stock.delivery', 'STOCK_DELIVERY'],
      ['stock.write_off', 'STOCK_WRITE_OFF'],
    ]);
    expect(onlyWriteOffs.json().items).toEqual([
      expect.objectContaining({
        event: 'stock.write_off',
        // one line for the whole write-off: its id, the reason, how many variants and units
        changes: [
          { field: 'writeOffId', old: null, new: operationIds[1] },
          { field: 'reason', old: null, new: 'damaged' },
          { field: 'variants', old: null, new: 1 },
          { field: 'quantity', old: null, new: 1 },
        ],
      }),
    ]);
  });

  it('does not keep the lines of the stock of a variant under the entity type product', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    await app.inject({
      method: 'POST',
      url: '/api/products/stock/deliveries',
      headers: asActor(admin),
      payload: {
        source: 'supplier',
        items: [{ variantId: product.variantId, quantity: 1, unitCost: 1 }],
      },
    });

    // the id of the variant under the type product is the id of some other product (or none)
    const wrongType = await readLog(
      admin,
      `entityType=product&entityId=${product.variantId}&actions=STOCK_DELIVERY`,
    );

    expect(wrongType.json().items).toEqual([]);
  });

  // the changes of a line name their fields: the refund of a late payment is one of field refund
  it('keeps the lines with a change of one field', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    await patchProduct(admin, product.id, { name: `Field ${Date.now()}` });
    await patchPrice(admin, product, 12);

    const res = await readLog(
      admin,
      `entityType=variant&entityId=${product.variantId}&field=price`,
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().total).toBe(1);
    expect(res.json().items[0].changes).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'price' })]),
    );
  });

  // root reads what the admins did: the lines written with the role of an admin
  it('keeps the lines written with one role', async () => {
    const someRoot = await createUser({ role: 'ROOT' });
    const product = await createProduct({ price: 10, stock: 0 });
    await patchProduct(admin, product.id, { name: `Admin ${Date.now()}` });
    await patchProduct(someRoot, product.id, { name: `Root ${Date.now()}` });

    const ofAdmins = await readLog(
      someRoot,
      `entityType=product&entityId=${product.id}&actorRole=ADMIN`,
    );
    const ofRoots = await readLog(
      someRoot,
      `entityType=product&entityId=${product.id}&actorRole=ROOT`,
    );

    expect(ofAdmins.json().items.map((line: { actor: { id: number } }) => line.actor.id)).toEqual([
      admin.id,
    ]);
    expect(ofRoots.json().items.map((line: { actor: { id: number } }) => line.actor.id)).toEqual([
      someRoot.id,
    ]);
    await closeSessions([someRoot.id]);
  });

  it.each(['actorRole=GUEST', 'field=bad%20field'])('refuses %s', async (query) => {
    const res = await readLog(admin, query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // the numbers of products, categories and orders repeat: a line of another file about a category
  // with the same number is no line of this product, so every query names the kind of the thing
  // the period starts at the time of the line itself: the database dates it by its own clock,
  // which is not the clock of the test
  it('keeps the lines of a period: from its start, taken in, to its end, left out', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    const patched = await patchProduct(admin, product.id, { name: `Period ${Date.now()}` });
    expect(patched.statusCode).toBe(200);
    const [line] = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'product', entityId: product.id },
        select: { createdAt: true },
      }),
    );
    const at = encodeURIComponent(line!.createdAt.toISOString());

    const inside = await readLog(admin, `entityType=product&entityId=${product.id}&from=${at}`);
    const outside = await readLog(admin, `entityType=product&entityId=${product.id}&to=${at}`);

    expect(inside.json().items).toHaveLength(1);
    expect(outside.json().items).toHaveLength(0);
  });

  it('goes page by page with its cursor', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    for (const price of [11, 12, 13]) await patchPrice(admin, product, price);

    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = (
        await readLog(
          admin,
          `entityType=variant&entityId=${product.variantId}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
        )
      ).json() as { items: Array<{ id: number }>; nextCursor?: string | null };
      seen.push(...page.items.map((line) => line.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(seen).toHaveLength(3);
    expect([...seen].sort((a, b) => b - a)).toEqual(seen);
  });

  it('gives the lines as a csv file', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    await patchPrice(admin, product, 15);

    const res = await readLog(admin, `entityType=variant&entityId=${product.variantId}&format=csv`);

    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'id,createdAt,actorId,actorName,actorEmail,actorRole,action,event,entityType,entityId,ip,userAgent,changes',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(',OTHER,variant.update,variant,');
  });

  it('refuses a user', async () => {
    const res = await readLog(buyer, '');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('refuses a period that ends before it starts', async () => {
    const res = await readLog(admin, 'from=2026-10-02T00:00:00.000Z&to=2026-10-01T00:00:00.000Z');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'INVALID_STATS_PERIOD' });
  });
});

describe('GET /api/products/:productId/price-history', () => {
  const historyOf = (actor: TestUser, productId: number, query = '') =>
    app.inject({
      method: 'GET',
      url: `/api/products/${productId}/price-history${query}`,
      headers: { cookie: accessCookie(actor) },
    });

  it('lists the changes of the price, the newest first, with the variant and who made them', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    await patchPrice(admin, product, 12);
    await patchPrice(other, product, 9);

    const res = await historyOf(admin, product.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        variant: {
          id: product.variantId,
          position: 1,
          name: expect.any(String),
          sku: null,
        },
        oldPrice: 12,
        newPrice: 9,
        mode: 'fixed',
        value: -3,
        endsAt: null,
        event: 'price.set',
        actor: expect.objectContaining({ id: other.id }),
      }),
      expect.objectContaining({
        variant: expect.objectContaining({ id: product.variantId }),
        oldPrice: 10,
        newPrice: 12,
        actor: expect.objectContaining({ id: admin.id }),
      }),
    ]);
  });

  // every variant of the product has a history of its own, the product lists them all
  it('lists the changes of all the variants of the product, and of one when asked', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    const second = await createVariant(product.id, {
      price: 50,
      sku: `HIST-${Date.now()}`,
      stock: 0,
    });
    await patchPrice(admin, product, 11);
    await patchPrice(admin, { id: product.id, variantId: second.id }, 55);
    await patchPrice(admin, product, 12);

    const all = await historyOf(admin, product.id);
    const ofSecond = await historyOf(admin, product.id, `?variantId=${second.id}`);

    expect(all.statusCode).toBe(200);
    expect(
      all
        .json()
        .items.map((line: { variant: { id: number }; newPrice: number }) => [
          line.variant.id,
          line.newPrice,
        ]),
    ).toEqual([
      [product.variantId, 12],
      [second.id, 55],
      [product.variantId, 11],
    ]);
    expect(ofSecond.statusCode).toBe(200);
    expect(ofSecond.json().items).toEqual([
      expect.objectContaining({
        variant: expect.objectContaining({ id: second.id, position: 2 }),
        oldPrice: 50,
        newPrice: 55,
      }),
    ]);
    expect(ofSecond.json().items[0].variant.sku).toMatch(/^HIST-/);
  });

  it('keeps the history of a product taken out of the catalog', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    await patchPrice(admin, product, 12);
    await asAdmin((tx) =>
      tx.product.update({ where: { id: product.id }, data: { deletedAt: new Date() } }),
    );

    const res = await historyOf(admin, product.id, `?variantId=${product.variantId}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
  });

  it('goes page by page with its cursor', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    for (const price of [11, 12, 13]) await patchPrice(admin, product, price);

    const first = await historyOf(admin, product.id, '?limit=2');
    const second = await historyOf(admin, product.id, `?limit=2&cursor=${first.json().nextCursor}`);

    expect(first.json().items.map((line: { newPrice: number }) => line.newPrice)).toEqual([13, 12]);
    expect(second.json().items.map((line: { newPrice: number }) => line.newPrice)).toEqual([11]);
    expect(second.json().nextCursor).toBeNull();
  });

  it('answers 404 for a product that does not exist', async () => {
    const res = await historyOf(admin, 2_000_000_000);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('answers 404 for a variant that is not a variant of the product', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    const stranger = await createProduct({ price: 10, stock: 0 });

    const res = await historyOf(admin, product.id, `?variantId=${stranger.variantId}`);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
  });

  it.each([['?variantId=0'], ['?variantId=abc'], ['?limit=0']])('refuses %s', async (query) => {
    const product = await createProduct({ price: 10, stock: 0 });

    const res = await historyOf(admin, product.id, query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a cursor of another list', async () => {
    const product = await createProduct({ price: 10, stock: 0 });

    const res = await historyOf(admin, product.id, '?cursor=eyJpZCI6MX0');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });

  it('refuses a user', async () => {
    const product = await createProduct({ price: 10, stock: 0 });

    const res = await historyOf(buyer, product.id);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});
