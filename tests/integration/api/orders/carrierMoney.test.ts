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
import { placePaidOrder } from '../../../helpers/payments.js';
import { closeOpenSessions } from '../../../helpers/stripe.js';

// POST /api/orders/:orderId/shipments/:shipmentId/carrier-money: root (or a money admin) records
// money a carrier paid the shop outside the app for a send of the order it lost or damaged:
// money of the shop, no cost of the send. The function of the database is
// db/moneyReceived.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  userIds.push(admin.id, root.id);
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const send = (method: 'POST' | 'PATCH', url: string, payload: object, actor: TestUser) =>
  app.inject({ method, url, headers: withCsrf(csrf, accessCookie(actor)), payload });

// a paid order the admin sent with a carrier and a cost: its send
async function sentOrder() {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const { orderId } = await placePaidOrder(app, csrf, buyer, product, { quantity: 1 });
  const shipped = await send(
    'PATCH',
    `/api/orders/${orderId}/status`,
    { status: 'shipped', shipment: { carrier: 'DHL', cost: 6 } },
    admin,
  );
  expect(shipped.statusCode).toBe(200);
  const [shipment] = shipped.json().shipments as { id: number }[];
  return { orderId, shipmentId: shipment!.id, buyer };
}

const dbNow = async () =>
  (
    await asAdmin((tx) => tx.$queryRaw<{ now: Date }[]>`select (now() at time zone 'UTC') as now`)
  )[0]!.now.toISOString();

const carrierMoney = async (
  orderId: number,
  shipmentId: number,
  body: Record<string, unknown> = {},
  actor: TestUser = root,
) =>
  send(
    'POST',
    `/api/orders/${orderId}/shipments/${shipmentId}/carrier-money`,
    {
      amount: 25,
      method: 'bank_transfer',
      note: 'The carrier lost the parcel.',
      at: await dbNow(),
      ...body,
    },
    actor,
  );

describe('money a carrier paid for a send', () => {
  it('is money of the shop: one line that names the send, the cost of the send stays as it was', async () => {
    const order = await sentOrder();

    const res = await carrierMoney(order.orderId, order.shipmentId);

    expect(res.statusCode).toBe(200);
    const card = res.json();
    expect(card.shipments).toEqual([expect.objectContaining({ id: order.shipmentId, cost: 6 })]);
    expect(card.money).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'money.received',
          purpose: 'shipping',
          part: 'whole',
          amount: 25,
        }),
      ]),
    );
    const audit = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: order.orderId, event: 'order.carrier_money' },
        select: { actorId: true },
      }),
    );
    expect(audit).toEqual([{ actorId: root.id }]);
  });

  it('refuses a send of another order, an admin without the right, and a sum of nothing', async () => {
    const order = await sentOrder();
    const other = await sentOrder();

    const foreign = await carrierMoney(order.orderId, other.shipmentId);
    const byAdmin = await carrierMoney(order.orderId, order.shipmentId, {}, admin);
    const zero = await carrierMoney(order.orderId, order.shipmentId, { amount: 0 });
    const future = await carrierMoney(order.orderId, order.shipmentId, {
      at: '2999-01-01T00:00:00.000Z',
    });

    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ errorCode: 'MONEY_RECEIVED_NOT_FOUND' });
    expect(byAdmin.statusCode).toBe(403);
    expect(byAdmin.json()).toMatchObject({ errorCode: 'MONEY_MANAGER_REQUIRED' });
    expect(zero.statusCode).toBe(400);
    expect(zero.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(future.statusCode).toBe(400);
    expect(future.json()).toMatchObject({ errorCode: 'MONEY_RECEIVED_AT_INVALID' });
  });
});
