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
import { deliveryBody } from '../../../helpers/orders.js';
import { placePaidOrder } from '../../../helpers/payments.js';

// POST /api/orders/:orderId/cancel for an order shipped by hand: the buyer is refunded in full, the
// delivery too; the carrier may have been paid already, and the admin says so: the cost of the send
// stays owed (an expense of the shop) or is not (nothing was paid). An order that has no send on its
// way needs no answer

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const { address: _address, ...person } = deliveryBody;
const pickupBody = { ...person, method: 'pickup' };

const setStatus = (orderId: number, status: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/status`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { status, ...extra },
  });

const cancel = (orderId: number, payload?: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/cancel`,
    headers: withCsrf(csrf, accessCookie(admin)),
    ...(payload ? { payload } : {}),
  });

// a paid order, with a payment Stripe knows: the cancel refunds it
const paidOrder = async (delivery: Record<string, unknown> = deliveryBody) =>
  (
    await placePaidOrder(app, csrf, await newUser(), await createProduct({ price: 10, stock: 5 }), {
      delivery,
    })
  ).orderId;

async function shippedOrder(
  delivery: Record<string, unknown> = deliveryBody,
  shipment: Record<string, unknown> = { carrier: 'DHL', cost: 7 },
) {
  const orderId = await paidOrder(delivery);
  const res = await setStatus(orderId, 'shipped', delivery.method === 'pickup' ? {} : { shipment });
  expect(res.statusCode).toBe(200);
  return orderId;
}

const sendsOf = (orderId: number) =>
  asAdmin((tx) => tx.orderShipment.findMany({ where: { orderId }, orderBy: { id: 'asc' } }));

const lineOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findFirstOrThrow({
      where: { entityType: 'order', entityId: orderId, action: 'ORDER_STATUS_CHANGE' },
      orderBy: { id: 'desc' },
      select: { meta: true },
    }),
  );

describe('POST /api/orders/:orderId/cancel of a shipped manual order', () => {
  it('keeps the cost of the send as owed when the carrier was paid', async () => {
    const orderId = await shippedOrder();

    const res = await cancel(orderId, { shippingPaid: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'cancelled' });
    const [send] = await sendsOf(orderId);
    expect(send).toMatchObject({ expense: true, rolledBackAt: null });
    expect(Number(send!.cost)).toBe(7);
  });

  it('makes the send cost nothing when the carrier was not paid, and logs the cost it had', async () => {
    const orderId = await shippedOrder();

    const res = await cancel(orderId, { shippingPaid: false });

    expect(res.statusCode).toBe(200);
    const [send] = await sendsOf(orderId);
    expect(send).toMatchObject({ expense: false });
    expect(Number(send!.cost)).toBe(0);
    expect((await lineOf(orderId)).meta).toEqual(
      expect.arrayContaining([
        { field: 'shippingPaid', old: null, new: false },
        { field: 'shippingCost', old: 7, new: 0 },
      ]),
    );
  });

  it('asks which of them it is', async () => {
    const orderId = await shippedOrder();

    const res = await cancel(orderId);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SHIPPING_PAID_REQUIRED' });
    const refusedAgain = await cancel(orderId, {});
    expect(refusedAgain.statusCode).toBe(400);
    expect(refusedAgain.json()).toMatchObject({ errorCode: 'SHIPPING_PAID_REQUIRED' });
  });

  it('writes the answer to the admin log with the cancel', async () => {
    const orderId = await shippedOrder();

    await cancel(orderId, { shippingPaid: true });

    expect((await lineOf(orderId)).meta).toEqual(
      expect.arrayContaining([
        { field: 'status', old: 'shipped', new: 'cancelled' },
        { field: 'shippingPaid', old: null, new: true },
      ]),
    );
  });

  it('lets the cost of an owed send be written after the cancel', async () => {
    const orderId = await shippedOrder(deliveryBody, { carrier: 'DHL' });
    await cancel(orderId, { shippingPaid: true });
    const [send] = await sendsOf(orderId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/shipments/${send!.id}`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { cost: 8 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().shipments[0]).toMatchObject({ cost: 8, expense: true });
  });

  it('refuses the cost of a send that owes nothing after the cancel', async () => {
    const orderId = await shippedOrder();
    await cancel(orderId, { shippingPaid: false });
    const [send] = await sendsOf(orderId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/orders/${orderId}/shipments/${send!.id}`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { cost: 8 },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'SHIPMENT_COST_NOT_OWED' });
  });

  it('refuses the answer for an order that has no send on its way', async () => {
    const paid = await paidOrder();
    const pickup = await shippedOrder(pickupBody);

    for (const orderId of [paid, pickup]) {
      const res = await cancel(orderId, { shippingPaid: true });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'SHIPPING_PAID_NOT_ALLOWED' });
    }
  });

  it('cancels a paid order and a pickup with no answer, as before', async () => {
    const paid = await paidOrder();
    const pickup = await shippedOrder(pickupBody);

    expect((await cancel(paid)).statusCode).toBe(200);
    expect((await cancel(pickup)).statusCode).toBe(200);
  });

  it('leaves a send that was taken back as it was when its order is cancelled', async () => {
    const orderId = await shippedOrder();
    await setStatus(orderId, 'paid', { keepShippingCost: true });

    const res = await cancel(orderId);

    expect(res.statusCode).toBe(200);
    const [send] = await sendsOf(orderId);
    expect(send).toMatchObject({ expense: true });
    expect(send!.rolledBackAt).not.toBeNull();
  });
});
