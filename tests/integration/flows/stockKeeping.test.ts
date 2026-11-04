import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';
import { placeOrder } from '../../helpers/orders.js';
import { journeyOf } from '../../helpers/returnJourney.js';

// The stock of a variant, each step with what its actor sees: an admin takes in a delivery, a
// buyer buys two units, the admin writes off a broken one; the batches, the movements of the stock
// and the log of the stock show each step with its cost and who made it, and the guest sees what is
// left. The rules of each step are the tests of api/products (stock) and api/admin (stock).
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const j = journeyOf(
  () => app,
  () => csrf,
);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Stock Buyer' });
});

afterAll(async () => {
  try {
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

describe('the stock of a variant', () => {
  it('takes in a delivery, sells, writes off and shows each step to the admin and the rest to the guest', async () => {
    const tag = uniqueTag();
    const product = await createProduct({ name: `Teapot ${tag}`, price: 25, stock: 0 });

    // a delivery of ten at 9 each
    const delivery = await j.post(admin, '/api/products/stock/deliveries', {
      source: 'supplier',
      supplier: `Clayworks ${tag}`,
      document: `INV-${tag}`,
      items: [{ variantId: product.variantId, quantity: 10, unitCost: 9 }],
    });
    expect(delivery.statusCode).toBe(201);
    const deliveryId = delivery.json().deliveryId as number;
    const batchId = delivery.json().batches[0].id as number;
    expect((await j.get(null, `/api/products/${product.id}`)).json().variant.stock).toBe(10);

    // a buyer buys two; a broken one is written off from the batch
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 2);
    const writeOff = await j.post(admin, '/api/products/stock/write-offs', {
      reason: 'damaged',
      note: 'Cracked lid',
      items: [{ variantId: product.variantId, quantity: 1, batchId }],
    });
    expect(writeOff.statusCode).toBe(201);
    const writeOffId = writeOff.json().writeOffId as number;

    // the batch: ten in, two sold, one written off, seven left worth 63
    const batches = await j.get(admin, `/api/admin/stock/batches?variantId=${product.variantId}`);
    expect(batches.json().items).toEqual([
      expect.objectContaining({
        id: batchId,
        quantity: 10,
        sold: 2,
        writtenOff: 1,
        remaining: 7,
        value: 63,
      }),
    ]);

    // the movements in the order they came, with their cost (what left the shelf counts below zero)
    const movements = await j.get(
      admin,
      `/api/admin/stock/movements?variantId=${product.variantId}&sortOrder=asc`,
    );
    expect(
      (movements.json().items as { kind: string; quantity: number; value: number }[]).map(
        ({ kind, quantity, value }) => ({ kind, quantity, value }),
      ),
    ).toEqual([
      { kind: 'delivery', quantity: 10, value: 90 },
      { kind: 'sale', quantity: -2, value: -18 },
      { kind: 'writeOff', quantity: -1, value: -9 },
    ]);

    // the log of the stock: who changed it and what was left after each change
    const log = await j.get(
      admin,
      `/api/admin/stock-log?variantId=${product.variantId}&sortOrder=asc`,
    );
    expect(
      (
        log.json().items as {
          event: string;
          stockAfter: number;
          deliveryId: number | null;
          orderId: number | null;
          writeOffId: number | null;
        }[]
      ).map(({ event, stockAfter, deliveryId: d, orderId: o, writeOffId: w }) => ({
        event,
        stockAfter,
        d,
        o,
        w,
      })),
    ).toEqual([
      { event: 'stock.delivery', stockAfter: 10, d: deliveryId, o: null, w: null },
      { event: 'stock.sale', stockAfter: 8, d: null, o: orderId, w: null },
      { event: 'stock.write_off', stockAfter: 7, d: null, o: null, w: writeOffId },
    ]);

    expect((await j.get(null, `/api/products/${product.id}`)).json().variant.stock).toBe(7);
  });
});
