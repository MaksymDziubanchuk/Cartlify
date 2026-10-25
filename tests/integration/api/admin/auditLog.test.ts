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

const linesOf = (productId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'product', entityId: productId },
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

  // a delivery is written by a function of the database, in the name of the admin of the request
  it('keep them for a line a function of the database writes', async () => {
    const product = await createProduct({ price: 10, stock: 0 });

    const res = await app.inject({
      method: 'POST',
      url: '/api/products/stock/deliveries',
      headers: asActor(admin),
      payload: { source: 'supplier', items: [{ productId: product.id, quantity: 2, unitCost: 1 }] },
    });

    expect(res.statusCode).toBe(201);
    expect(await linesOf(product.id)).toEqual([
      { action: 'STOCK_DELIVERY', ip: '127.0.0.1', userAgent: AGENT },
    ]);
  });
});

describe('GET /api/admin/audit-log', () => {
  it('lists the lines of an actor, the newest first, with the actor and the request', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    await patchProduct(other, product.id, { name: `First ${Date.now()}` });
    await patchProduct(other, product.id, { price: 12 });

    const res = await readLog(admin, `actorId=${other.id}`);

    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      actor: { id: other.id, role: 'ADMIN' },
      actorRole: 'ADMIN',
      entityType: 'product',
      entityId: product.id,
      action: 'PRODUCT_UPDATE',
      changes: [{ field: 'price', old: '10', new: '12' }],
      ip: '127.0.0.1',
      userAgent: AGENT,
      createdAt: expect.any(String),
    });
    expect((items[0]!.id as number) > (items[1]!.id as number)).toBe(true);
  });

  it('keeps the lines of one thing and of some actions', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    await patchProduct(admin, product.id, { name: `Thing ${Date.now()}` });
    await app.inject({
      method: 'POST',
      url: '/api/products/stock/deliveries',
      headers: asActor(admin),
      payload: { source: 'supplier', items: [{ productId: product.id, quantity: 1, unitCost: 1 }] },
    });

    const all = await readLog(admin, `entityType=product&entityId=${product.id}`);
    const deliveries = await readLog(
      admin,
      `entityType=product&entityId=${product.id}&actions=STOCK_DELIVERY,STOCK_WRITE_OFF`,
    );

    expect(all.json().items.map((line: { action: string }) => line.action)).toEqual([
      'STOCK_DELIVERY',
      'PRODUCT_UPDATE',
    ]);
    expect(deliveries.json().items.map((line: { action: string }) => line.action)).toEqual([
      'STOCK_DELIVERY',
    ]);
  });

  // the changes of a line name their fields: the refund of a late payment is one of field refund
  it('keeps the lines with a change of one field', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    await patchProduct(admin, product.id, { name: `Field ${Date.now()}` });
    await patchProduct(admin, product.id, { price: 12 });

    const res = await readLog(admin, `entityType=product&entityId=${product.id}&field=price`);

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

    const ofAdmins = await readLog(someRoot, `entityId=${product.id}&actorRole=ADMIN`);
    const ofRoots = await readLog(someRoot, `entityId=${product.id}&actorRole=ROOT`);

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

  it('keeps the lines of a period', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    const before = new Date().toISOString();
    await patchProduct(admin, product.id, { name: `Period ${Date.now()}` });

    const inside = await readLog(admin, `entityId=${product.id}&from=${before}`);
    const outside = await readLog(admin, `entityId=${product.id}&to=${before}`);

    expect(inside.json().items).toHaveLength(1);
    expect(outside.json().items).toHaveLength(0);
  });

  it('goes page by page with its cursor', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    for (const price of [11, 12, 13]) await patchProduct(admin, product.id, { price });

    const seen: number[] = [];
    let cursor: string | undefined;
    do {
      const page = (
        await readLog(
          admin,
          `entityType=product&entityId=${product.id}&limit=2${cursor ? `&cursor=${cursor}` : ''}`,
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
    await patchProduct(admin, product.id, { price: 15 });

    const res = await readLog(admin, `entityType=product&entityId=${product.id}&format=csv`);

    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe(
      'id,createdAt,actorId,actorRole,action,entityType,entityId,ip,userAgent,changes',
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(',PRODUCT_UPDATE,product,');
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
  const historyOf = (actor: TestUser, productId: number) =>
    app.inject({
      method: 'GET',
      url: `/api/products/${productId}/price-history`,
      headers: { cookie: accessCookie(actor) },
    });

  it('lists the changes of the price, the newest first, with who made them', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    await patchProduct(admin, product.id, { price: 12 });
    await patchProduct(other, product.id, { price: 9 });

    const res = await historyOf(admin, product.id);

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([
      expect.objectContaining({
        oldPrice: 12,
        newPrice: 9,
        mode: 'fixed',
        value: -3,
        endsAt: null,
        actor: expect.objectContaining({ id: other.id }),
      }),
      expect.objectContaining({
        oldPrice: 10,
        newPrice: 12,
        actor: expect.objectContaining({ id: admin.id }),
      }),
    ]);
  });

  it('answers 404 for a product that does not exist', async () => {
    const res = await historyOf(admin, 2_000_000_000);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('refuses a user', async () => {
    const product = await createProduct({ price: 10, stock: 0 });

    const res = await historyOf(buyer, product.id);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});
