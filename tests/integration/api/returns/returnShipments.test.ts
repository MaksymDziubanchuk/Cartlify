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

// the parcels the shop paid to carry goods back from a buyer: POST /api/returns/:returnId/shipments
// records one (an admin or root), PATCH .../shipments/:shipmentId writes or corrects its cost. The
// card of the statement lists them, each step goes to the admin log, and the reports count the
// cost in the period of the time the admin gave (see the reports)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(admin.id, root.id, buyer.id);
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const send = (
  method: 'POST' | 'PATCH',
  url: string,
  payload: Record<string, unknown>,
  actor: TestUser | null = admin,
) =>
  app.inject({
    method,
    url,
    headers: actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf),
    payload,
  });

// a statement of the admin for a unit of a paid order of the buyer: its id, the order and the moment
// it was paid at, which no parcel is sent before
async function statement() {
  const product = await createProduct({ price: 10, stock: 20 });
  products.push(product);
  const orderId = await placeOrderOf(app, csrf, buyer, [{ item: product, quantity: 2 }], 'paid');
  const items = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
  );
  const res = await send('POST', '/api/returns', {
    orderId,
    items: [{ orderItemId: items[0]!.id, quantity: 1 }],
    basis: 'other',
    reason: 'defect',
  });
  expect(res.statusCode).toBe(201);
  const { paidAt } = await asAdmin((tx) =>
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
  );
  return { returnId: res.json().id as number, orderId, paidAt: paidAt! };
}

const record = (returnId: number, payload: Record<string, unknown>, actor = admin) =>
  send('POST', `/api/returns/${returnId}/shipments`, payload, actor);

const setCost = (returnId: number, shipmentId: number, cost: number, actor = admin) =>
  send('PATCH', `/api/returns/${returnId}/shipments/${shipmentId}`, { cost }, actor);

// a moment after the order was paid, never of the future: the test runs seconds after the payment
const afterPay = (paidAt: Date, ms: number) => new Date(paidAt.getTime() + ms).toISOString();

const PARCEL = {
  carrier: 'DHL',
  trackingNumber: 'JD0146000123',
  trackingUrl: 'https://track.example.com/JD0146000123',
  cost: 4.5,
};

describe('POST /api/returns/:returnId/shipments', () => {
  it('records the parcel and answers with the card, which lists it with its time and the admin who recorded it', async () => {
    const { returnId, paidAt } = await statement();
    const shippedAt = afterPay(paidAt, 1);

    const res = await record(returnId, { ...PARCEL, shippedAt });

    expect(res.statusCode).toBe(201);
    expect(res.json().shipments).toEqual([
      {
        id: expect.any(Number),
        ...PARCEL,
        shippedAt,
        recordedBy: { id: admin.id, name: null, email: admin.email },
        createdAt: expect.any(String),
      },
    ]);
  });

  it('lets root record one, keeps them in the order they were recorded, and leaves the unknown empty', async () => {
    const { returnId, paidAt } = await statement();

    await record(returnId, { ...PARCEL, shippedAt: afterPay(paidAt, 1) });
    const res = await record(returnId, { shippedAt: afterPay(paidAt, 2) }, root);

    expect(res.statusCode).toBe(201);
    expect(res.json().shipments).toHaveLength(2);
    expect(res.json().shipments[1]).toMatchObject({
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      cost: null,
      recordedBy: { id: root.id },
    });
  });

  it('writes the step to the log of the admin, naming the statement, the order and the parcel', async () => {
    const { returnId, orderId, paidAt } = await statement();
    const shippedAt = afterPay(paidAt, 1);

    const res = await record(returnId, { ...PARCEL, shippedAt });

    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.shipment_record' },
        select: { actor: { select: { id: true, role: true } }, meta: true },
      }),
    );
    expect(lines).toEqual([
      {
        actor: { id: admin.id, role: 'ADMIN' },
        meta: [
          { field: 'returnId', old: null, new: returnId },
          {
            field: 'shipment',
            old: null,
            new: {
              shipmentId: res.json().shipments[0].id,
              ...PARCEL,
              shippedAt,
            },
          },
        ],
      },
    ]);
  });

  it('refuses a time of the future and a time before the order was paid (400 RETURN_SHIPMENT_TIME_INVALID)', async () => {
    const { returnId } = await statement();

    for (const shippedAt of [
      new Date(Date.now() + 3_600_000).toISOString(),
      '2000-01-01T00:00:00.000Z',
    ]) {
      const res = await record(returnId, { ...PARCEL, shippedAt });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'RETURN_SHIPMENT_TIME_INVALID' });
    }
  });

  it('refuses a statement there is not (404), a body that is not one (400), a buyer (403) and a visitor without a login, who is a guest (403)', async () => {
    const { returnId, paidAt } = await statement();
    const shippedAt = afterPay(paidAt, 1);

    const missing = await record(2_000_000_000, { shippedAt });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ errorCode: 'RETURN_NOT_FOUND' });

    for (const body of [
      {},
      { shippedAt: 'yesterday' },
      { shippedAt, cost: -1 },
      { shippedAt, cost: 1.005 },
      { shippedAt, trackingUrl: 'http://track.example.com/1', carrier: 'DHL' },
      { shippedAt, carrier: '' },
    ]) {
      const res = await record(returnId, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }

    expect((await record(returnId, { shippedAt }, buyer)).statusCode).toBe(403);
    const anonymous = await send('POST', `/api/returns/${returnId}/shipments`, { shippedAt }, null);
    expect(anonymous.statusCode).toBe(403);
    expect(anonymous.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('refuses a number or a link without a carrier (400 RETURN_SHIPMENT_CARRIER_REQUIRED), and nothing is recorded', async () => {
    const { returnId, paidAt } = await statement();
    const shippedAt = afterPay(paidAt, 1);

    for (const body of [
      { shippedAt, trackingNumber: 'JD1' },
      { shippedAt, trackingUrl: 'https://track.example.com/1' },
      { shippedAt, carrier: '   ', trackingNumber: 'JD1' },
    ]) {
      const res = await record(returnId, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'RETURN_SHIPMENT_CARRIER_REQUIRED' });
    }
    expect(await asAdmin((tx) => tx.returnShipment.count({ where: { returnId } }))).toBe(0);
  });
});

describe('PATCH /api/returns/:returnId/shipments/:shipmentId', () => {
  it('writes the cost of a parcel recorded without one, then corrects it, and logs both', async () => {
    const { returnId, orderId, paidAt } = await statement();
    const made = await record(returnId, { shippedAt: afterPay(paidAt, 1) });
    const shipmentId = made.json().shipments[0].id as number;

    const written = await setCost(returnId, shipmentId, 6.25);
    const corrected = await setCost(returnId, shipmentId, 7, root);

    expect(written.statusCode).toBe(200);
    expect(written.json().shipments[0]).toMatchObject({ id: shipmentId, cost: 6.25 });
    expect(corrected.json().shipments[0]).toMatchObject({ cost: 7 });
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'return.shipment_cost' },
        orderBy: { id: 'asc' },
        select: { actor: { select: { id: true } }, meta: true },
      }),
    );
    expect(lines.map((line) => line.meta)).toEqual([
      [
        { field: 'returnId', old: null, new: returnId },
        { field: 'shipmentId', old: null, new: shipmentId },
        { field: 'cost', old: null, new: 6.25 },
      ],
      [
        { field: 'returnId', old: null, new: returnId },
        { field: 'shipmentId', old: null, new: shipmentId },
        { field: 'cost', old: 6.25, new: 7 },
      ],
    ]);
    expect(lines.map((line) => line.actor?.id)).toEqual([admin.id, root.id]);
  });

  it('keeps the time of the parcel, so the cost stays in the period it was sent in', async () => {
    const { returnId, paidAt } = await statement();
    const shippedAt = afterPay(paidAt, 3);
    const made = await record(returnId, { shippedAt });

    const res = await setCost(returnId, made.json().shipments[0].id, 3);

    expect(res.json().shipments[0].shippedAt).toBe(shippedAt);
  });

  it('refuses a parcel of another statement or there is not (404), a cost that is not one (400), a buyer (403)', async () => {
    const mine = await statement();
    const other = await statement();
    const made = await record(other.returnId, { shippedAt: afterPay(other.paidAt, 1) });
    const shipmentId = made.json().shipments[0].id as number;

    const notOfThis = await setCost(mine.returnId, shipmentId, 1);
    expect(notOfThis.statusCode).toBe(404);
    expect(notOfThis.json()).toMatchObject({ errorCode: 'RETURN_SHIPMENT_NOT_FOUND' });
    expect((await setCost(mine.returnId, 2_000_000_000, 1)).statusCode).toBe(404);

    for (const cost of [-1, 1.005]) {
      const res = await setCost(other.returnId, shipmentId, cost);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
    expect((await setCost(other.returnId, shipmentId, 1, buyer)).statusCode).toBe(403);
  });
});

describe('the card of a statement', () => {
  it('lists no parcel for a statement that has none', async () => {
    const { returnId } = await statement();

    const res = await app.inject({
      method: 'GET',
      url: `/api/returns/${returnId}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().shipments).toEqual([]);
    expect(res.json()).toMatchObject({ deductible: 0, warnings: [] });
  });

  // a reimbursement of the way back would pay for the parcel twice: the card warns, it does not
  // refuse; a statement outside the withdrawal has nothing to take off the transfer
  it('warns of a parcel the shop paid and has nothing to take off a statement outside the withdrawal', async () => {
    const { returnId, paidAt } = await statement();
    expect((await record(returnId, { ...PARCEL, shippedAt: afterPay(paidAt, 1) })).statusCode).toBe(
      201,
    );

    const res = await app.inject({
      method: 'GET',
      url: `/api/returns/${returnId}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deductible: 0, warnings: ['shop_paid_parcel'] });
  });
});
