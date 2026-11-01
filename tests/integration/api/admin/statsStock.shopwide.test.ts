import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  type TestUser,
} from '../../../helpers/factories.js';
import { markVariantDeleted } from '../../../helpers/variants.js';

// GET /api/admin/stats counts the products with no free unit (outOfStockTotal): a product of the
// catalog none of whose variants in sale has a free unit. The stock is the stock of a variant, so
// the number moves with a delivery or a write-off of one variant. The count is of the whole shop,
// so this file runs alone (shopwide) and reads the number before and after each step

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const outOfStockTotal = async (): Promise<number> => {
  const res = await app.inject({
    method: 'GET',
    url: '/api/admin/stats',
    headers: { cookie: accessCookie(admin) },
  });
  expect(res.statusCode).toBe(200);
  return res.json().products.outOfStockTotal;
};

const stock = async (path: 'deliveries' | 'write-offs', payload: object) => {
  const res = await app.inject({
    method: 'POST',
    url: `/api/products/stock/${path}`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });
  expect(res.statusCode).toBe(201);
};

const deliver = (variantId: number, quantity: number) =>
  stock('deliveries', { source: 'supplier', items: [{ variantId, quantity, unitCost: 1 }] });
const writeOff = (variantId: number, quantity: number) =>
  stock('write-offs', { reason: 'damaged', items: [{ variantId, quantity }] });

describe('the products out of stock in GET /api/admin/stats', () => {
  it('counts a new product without stock, and counts it no more once one variant has a free unit', async () => {
    const before = await outOfStockTotal();
    const product = await createProduct({ stock: 0 });
    const second = await createVariant(product.id, { stock: 0 });

    expect(await outOfStockTotal()).toBe(before + 1);

    await deliver(second.id, 2);
    expect(await outOfStockTotal()).toBe(before);

    // the other variant is still empty: the product has a unit in one of them
    await deliver(product.variantId, 1);
    expect(await outOfStockTotal()).toBe(before);

    await writeOff(second.id, 2);
    expect(await outOfStockTotal()).toBe(before);

    await writeOff(product.variantId, 1);
    expect(await outOfStockTotal()).toBe(before + 1);
  });

  it('does not count the units of a variant taken out of sale as free units of the product', async () => {
    const before = await outOfStockTotal();
    const product = await createProduct({ stock: 0 });
    const kept = await createVariant(product.id, { stock: 0 });
    await deliver(product.variantId, 5);
    expect(await outOfStockTotal()).toBe(before);

    await markVariantDeleted(product.variantId);

    // the product is still in the catalog and only its empty variant is in sale
    expect(await outOfStockTotal()).toBe(before + 1);

    await deliver(kept.id, 1);
    expect(await outOfStockTotal()).toBe(before);
  });

  it('leaves a product removed from the catalog out', async () => {
    const before = await outOfStockTotal();
    const product = await createProduct({ stock: 0 });
    expect(await outOfStockTotal()).toBe(before + 1);

    await deleteProductFromCatalog(product.id);

    expect(await outOfStockTotal()).toBe(before);
  });
});
