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
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrderOf } from '../../../helpers/orders.js';

// the parcel the goods go back to the shop in, as an admin confirms it: POST
// /api/returns/:returnId/proof/confirm says who paid the carrier (the shop, cost, or the buyer,
// buyerPaid from the receipt), and POST /api/returns/:returnId/receive confirms a parcel not
// confirmed yet in the same step (parcel), since goods that came or were lost have a result only
// with it. The rules of the sums are the database's (db/returnParcels.test.ts); here the bodies, the
// answers and the admin log

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(admin.id, buyer.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const post = (url: string, payload: Record<string, unknown> = {}, actor: TestUser = admin) =>
  app.inject({
    method: 'POST',
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

// a statement of an admin for one unit of a paid order: the shop pays the way back (not a
// withdrawal), so a parcel the shop did not pay needs the sum of the buyer
async function statement() {
  const product = await createProduct({ price: 10, stock: 20 });
  products.push(product);
  const orderId = await placeOrderOf(app, csrf, buyer, [{ item: product, quantity: 1 }], 'paid');
  const [item] = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
  );
  const made = await post('/api/returns', {
    orderId,
    items: [{ orderItemId: item!.id, quantity: 1 }],
    basis: 'other',
    reason: 'defect',
    description: 'The box came open.',
  });
  expect(made.statusCode).toBe(201);
  return { orderId, returnId: made.json().id as number, rowId: made.json().items[0].id as number };
}

const auditOf = (orderId: number, event: string) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, event },
      select: { meta: true },
    }),
  );

describe('POST /api/returns/:returnId/proof/confirm with the sums of the parcel', () => {
  it('sets what the buyer paid from the receipt, in the card and in the admin log', async () => {
    const { orderId, returnId } = await statement();

    const res = await post(`/api/returns/${returnId}/proof/confirm`, { buyerPaid: 6.5 });

    expect(res.statusCode).toBe(200);
    expect(res.json().parcels).toEqual([
      expect.objectContaining({
        direction: 'to_shop',
        buyerPaid: 6.5,
        cost: null,
        confirmedBy: expect.objectContaining({ id: admin.id }),
      }),
    ]);
    const [line] = await auditOf(orderId, 'return.proof_confirm');
    expect(JSON.stringify(line!.meta)).toContain('"field":"buyerPaid"');
    expect(JSON.stringify(line!.meta)).toContain('6.5');
  });

  it('writes what the shop paid the carrier as the cost of the parcel, with no sum of the buyer', async () => {
    const { orderId, returnId } = await statement();

    const res = await post(`/api/returns/${returnId}/proof/confirm`, { cost: 4 });

    expect(res.statusCode).toBe(200);
    expect(res.json().parcels).toEqual([
      expect.objectContaining({ direction: 'to_shop', cost: 4, buyerPaid: null }),
    ]);
    const [line] = await auditOf(orderId, 'return.proof_confirm');
    expect(JSON.stringify(line!.meta)).toContain('"field":"cost"');
  });

  it('asks the sum of the buyer when the shop pays the way back and did not pay the carrier (400), and takes no two sums (400)', async () => {
    const { returnId } = await statement();
    const url = `/api/returns/${returnId}/proof/confirm`;

    const none = await post(url);
    const both = await post(url, { buyerPaid: 3, cost: 4 });
    const card = await app.inject({
      method: 'GET',
      url: `/api/returns/${returnId}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(none.statusCode).toBe(400);
    expect(none.json()).toMatchObject({ errorCode: 'RETURN_PARCEL_SUM_REQUIRED' });
    expect(both.statusCode).toBe(400);
    expect(both.json()).toMatchObject({ errorCode: 'RETURN_PARCEL_SUM_INVALID' });
    // nothing was confirmed
    expect(card.json().parcels).toEqual([]);
  });

  it('refuses a sum that is not money (400 VALIDATION_ERROR)', async () => {
    const { returnId } = await statement();

    const res = await post(`/api/returns/${returnId}/proof/confirm`, { buyerPaid: -1 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('POST /api/returns/:returnId/receive with the parcel', () => {
  it('gives no result to goods that came while the parcel is not confirmed and not given (409 RETURN_PARCEL_REQUIRED)', async () => {
    const { returnId, rowId } = await statement();

    const res = await post(`/api/returns/${returnId}/receive`, {
      results: [{ itemId: rowId, quantity: 1, goods: 'to_stock' }],
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_PARCEL_REQUIRED' });
  });

  it('marks goods that did not arrive with no parcel', async () => {
    const { returnId, rowId } = await statement();

    const res = await post(`/api/returns/${returnId}/receive`, {
      results: [{ itemId: rowId, quantity: 1, goods: 'not_arrived' }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().parcels).toEqual([]);
  });

  it('confirms a parcel nobody told of in the same step, and keeps its number out of the admin log', async () => {
    const { orderId, returnId, rowId } = await statement();

    const res = await post(`/api/returns/${returnId}/receive`, {
      results: [{ itemId: rowId, quantity: 1, goods: 'to_stock' }],
      parcel: { buyerPaid: 3, carrier: 'DHL', trackingNumber: 'JD0146000555' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().parcels).toEqual([
      expect.objectContaining({
        direction: 'to_shop',
        carrier: 'DHL',
        trackingNumber: 'JD0146000555',
        buyerPaid: 3,
        confirmedAt: expect.any(String),
        confirmedBy: expect.objectContaining({ id: admin.id }),
      }),
    ]);
    const [line] = await auditOf(orderId, 'return.receive');
    const text = JSON.stringify(line!.meta);
    expect(text).toContain('"field":"parcel"');
    expect(text).toContain('DHL');
    expect(text).not.toContain('JD0146000555');
  });

  it('takes the cost the shop paid for the parcel in the same step', async () => {
    const { returnId, rowId } = await statement();

    const res = await post(`/api/returns/${returnId}/receive`, {
      results: [{ itemId: rowId, quantity: 1, goods: 'to_stock' }],
      parcel: { cost: 5 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().parcels).toEqual([
      expect.objectContaining({ direction: 'to_shop', cost: 5, buyerPaid: null }),
    ]);
  });

  it('asks the sum of the buyer in the step as at the confirmation (400 RETURN_PARCEL_SUM_REQUIRED)', async () => {
    const { returnId, rowId } = await statement();

    const res = await post(`/api/returns/${returnId}/receive`, {
      results: [{ itemId: rowId, quantity: 1, goods: 'to_stock' }],
      parcel: { carrier: 'DHL' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'RETURN_PARCEL_SUM_REQUIRED' });
  });

  it('needs no parcel once it is confirmed', async () => {
    const { returnId, rowId } = await statement();
    await post(`/api/returns/${returnId}/proof/confirm`, { buyerPaid: 2 });

    const res = await post(`/api/returns/${returnId}/receive`, {
      results: [{ itemId: rowId, quantity: 1, goods: 'to_stock' }],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().parcels).toEqual([expect.objectContaining({ buyerPaid: 2 })]);
  });
});
