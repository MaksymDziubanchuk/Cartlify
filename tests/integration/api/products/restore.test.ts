import { randomBytes } from 'node:crypto';
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
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';

// POST /api/products/:productId/restore puts a product taken out of the catalog back; an admin finds
// the products taken out, a buyer sees one only in an order of theirs

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;

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

// random letters: a name no other product has, nor one close to it
const randomWord = () =>
  Array.from(randomBytes(10), (byte) => String.fromCharCode(97 + (byte % 26))).join('');

const restore = (productId: number, actor: TestUser = admin) =>
  app.inject({
    method: 'POST',
    url: `/api/products/${productId}/restore`,
    headers: withCsrf(csrf, accessCookie(actor)),
  });

const cardOf = (productId: number, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: `/api/products/${productId}`,
    headers: actor ? { cookie: accessCookie(actor) } : {},
  });

describe('POST /api/products/:productId/restore', () => {
  it('puts the product back into the catalog and writes the change to the admin log', async () => {
    const product = await createProduct({ price: 10 });
    await deleteProductFromCatalog(product.id);

    const res = await restore(product.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: product.id, deletedAt: null });
    expect((await cardOf(product.id)).statusCode).toBe(200);
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'product', entityId: product.id, action: 'PRODUCT_UPDATE' },
        select: { actorId: true, meta: true },
      }),
    );
    expect(lines).toEqual([
      {
        actorId: admin.id,
        meta: [{ field: 'deletedAt', old: expect.any(String), new: null }],
      },
    ]);
  });

  it('answers 409 for a product of the catalog', async () => {
    const product = await createProduct({ price: 10 });

    const res = await restore(product.id);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_DELETED' });
  });

  it('answers 404 for a product that does not exist', async () => {
    const res = await restore(2_000_000_000);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('refuses a user', async () => {
    const product = await createProduct({ price: 10 });
    await deleteProductFromCatalog(product.id);

    const res = await restore(product.id, buyer);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('a product taken out of the catalog', () => {
  it('is found by an admin among the products taken out', async () => {
    const name = `Taken out ${randomWord()}`;
    const product = await createProduct({ price: 10, name });
    await deleteProductFromCatalog(product.id);

    const res = await app.inject({
      method: 'GET',
      url: `/api/products?deleted=true&search=${encodeURIComponent(name)}`,
      headers: { cookie: accessCookie(admin) },
    });

    // the search forgives a typo and finds names with some of the words too, the whole name first
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({ id: product.id, deletedAt: expect.any(String) });
  });

  // the person bought it: the order shows what it held, the catalog does not show it
  it('stays in a paid order of the buyer while the catalog and its card leave it out', async () => {
    const product = await createProduct({ price: 10, stock: 2 });
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid');
    await deleteProductFromCatalog(product.id);

    const order = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(buyer) },
    });

    expect(order.statusCode).toBe(200);
    expect(order.json().items).toEqual([expect.objectContaining({ productId: product.id })]);
    expect((await cardOf(product.id, buyer)).statusCode).toBe(404);
  });
});
