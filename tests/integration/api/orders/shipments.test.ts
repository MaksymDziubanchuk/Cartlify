import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

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
import { takeLogs } from '../../../helpers/logs.js';
import { refuseMail, watchMail } from '../../../helpers/mail.js';
import { deliveryBody, placeOrder } from '../../../helpers/orders.js';

// PATCH /api/orders/:orderId/shipments/:shipmentId: an admin writes what the shop pays the carrier
// when it is known, and corrects the carrier, the number and the link of the send on its way. The
// buyer is mailed the new shipping details, never the cost; the cost is not mailed at all. Every
// change goes to the admin log

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

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const setStatus = (orderId: number, status: string, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/status`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: { status, ...extra },
  });

// a shipped manual order with a send, by the route; returns the ids
async function shipped(
  shipment: Record<string, unknown> = { carrier: 'DHL', trackingNumber: 'A1' },
  buyer?: TestUser,
) {
  const orderId = await placeOrder(
    app,
    csrf,
    buyer ?? (await newUser()),
    await createProduct({ price: 10, stock: 5 }),
    'paid',
    1,
    deliveryBody,
  );
  const res = await setStatus(orderId, 'shipped', { shipment });
  expect(res.statusCode).toBe(200);
  return { orderId, shipmentId: res.json().shipments[0].id as number };
}

const patchShipment = (
  orderId: number | string,
  shipmentId: number | string,
  payload: Record<string, unknown>,
  actor: TestUser = admin,
) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/shipments/${shipmentId}`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

const rowOf = (shipmentId: number) =>
  asAdmin((tx) => tx.orderShipment.findUniqueOrThrow({ where: { id: shipmentId } }));

const linesOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, action: 'ORDER_SHIPMENT_CHANGE' },
      orderBy: { id: 'asc' },
      select: { actorId: true, actorRole: true, meta: true },
    }),
  );

describe('PATCH /api/orders/:orderId/shipments/:shipmentId: the details of the send', () => {
  it('corrects the carrier, the number and the link of the send on its way', async () => {
    const buyer = await newUser({ name: 'Anna' });
    const { orderId, shipmentId } = await shipped({ carrier: 'DHL', trackingNumber: 'A1' }, buyer);

    const res = await patchShipment(orderId, shipmentId, {
      carrier: 'UPS',
      trackingNumber: 'B2',
      trackingUrl: 'https://track.example.com/B2',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: orderId,
      status: 'shipped',
      delivery: {
        shipment: {
          carrier: 'UPS',
          trackingNumber: 'B2',
          trackingUrl: 'https://track.example.com/B2',
        },
      },
      shipments: [{ id: shipmentId, carrier: 'UPS', trackingNumber: 'B2' }],
    });
    expect(await rowOf(shipmentId)).toMatchObject({ carrier: 'UPS', trackingNumber: 'B2' });
  });

  it('mails the buyer the new shipping details, all of them, and none of the cost', async () => {
    const buyer = await newUser({ name: 'Anna' });
    const { orderId, shipmentId } = await shipped(
      { carrier: 'DHL', trackingNumber: 'A1', cost: 7.5 },
      buyer,
    );
    const mails = watchMail();

    await patchShipment(orderId, shipmentId, {
      trackingNumber: 'B2',
      trackingUrl: 'https://track.example.com/B2',
    });

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: [buyer.email], accepted: true });
    expect(mails[0]!.subject).toBe(`Cartlify — The shipping details of order #${orderId} changed`);
    expect(mails[0]!.text).toContain('Carrier: DHL');
    expect(mails[0]!.text).toContain('Tracking number: B2');
    expect(mails[0]!.text).toContain('Follow your parcel: https://track.example.com/B2');
    expect(mails[0]!.text).not.toContain('7.5');
  });

  it('keeps the link when the number is cleared and mails the carrier with the link only', async () => {
    const { orderId, shipmentId } = await shipped({
      carrier: 'DHL',
      trackingNumber: 'A1',
      trackingUrl: 'https://track.example.com/A1',
    });
    const mails = watchMail();

    const res = await patchShipment(orderId, shipmentId, { trackingNumber: null });

    expect(res.statusCode).toBe(200);
    expect(res.json().delivery.shipment).toEqual({
      carrier: 'DHL',
      trackingNumber: null,
      trackingUrl: 'https://track.example.com/A1',
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('Carrier: DHL');
    expect(mails[0]!.text).toContain('Follow your parcel: https://track.example.com/A1');
    expect(mails[0]!.text).not.toContain('Tracking number');
  });

  it('writes the change to the admin log with the old and the new value of each field', async () => {
    const { orderId, shipmentId } = await shipped({ carrier: 'DHL', trackingNumber: 'A1' });

    await patchShipment(orderId, shipmentId, { carrier: 'UPS', trackingNumber: 'B2' });

    const lines = await linesOf(orderId);
    expect(lines).toEqual([
      {
        actorId: admin.id,
        actorRole: 'ADMIN',
        meta: [
          { field: 'shipment', old: shipmentId, new: shipmentId },
          { field: 'carrier', old: 'DHL', new: 'UPS' },
          { field: 'trackingNumber', old: 'A1', new: 'B2' },
        ],
      },
    ]);
  });

  it('clears a number and a link with null, and cuts the spaces around a text', async () => {
    const { orderId, shipmentId } = await shipped({
      carrier: 'DHL',
      trackingNumber: 'A1',
      trackingUrl: 'https://track.example.com/A1',
    });

    const cleared = await patchShipment(orderId, shipmentId, {
      trackingNumber: null,
      trackingUrl: null,
    });
    const trimmed = await patchShipment(orderId, shipmentId, { carrier: '  FedEx  ' });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().shipments[0]).toMatchObject({ trackingNumber: null, trackingUrl: null });
    expect(trimmed.json().shipments[0]).toMatchObject({ carrier: 'FedEx' });
  });

  it.each([
    ['clears the carrier while a number is there', { carrier: null }, 'SHIPMENT_CARRIER_REQUIRED'],
    [
      'clears the carrier while a link is there',
      { carrier: null, trackingNumber: null },
      'SHIPMENT_CARRIER_REQUIRED',
    ],
    ['writes a carrier of only spaces', { carrier: '   ' }, 'SHIPMENT_CARRIER_INVALID'],
  ])('refuses a change that %s', async (_case, payload, errorCode) => {
    const { orderId, shipmentId } = await shipped({
      carrier: 'DHL',
      trackingNumber: 'A1',
      trackingUrl: 'https://track.example.com/A1',
    });

    const res = await patchShipment(orderId, shipmentId, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect(await rowOf(shipmentId)).toMatchObject({ carrier: 'DHL', trackingNumber: 'A1' });
  });

  it.each([
    ['a link that is not https', { trackingUrl: 'http://track.example.com/1' }],
    ['a cost below zero', { cost: -1 }],
    ['a cost with a fraction of a cent', { cost: 1.005 }],
    ['a carrier of 101 characters', { carrier: 'x'.repeat(101) }],
    ['a body with nothing in it', {}],
  ])('refuses %s by the request schema', async (_case, payload) => {
    const { orderId, shipmentId } = await shipped();

    const res = await patchShipment(orderId, shipmentId, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a body with a field nobody knows and nothing else: the schema takes the field off', async () => {
    const { orderId, shipmentId } = await shipped();

    const res = await patchShipment(orderId, shipmentId, { foo: 1 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NO_FIELDS_TO_UPDATE' });
  });

  it('changes nothing, writes no line and mails nobody when the values are the ones it has', async () => {
    const { orderId, shipmentId } = await shipped({ carrier: 'DHL', trackingNumber: 'A1' });
    const mails = watchMail();

    const res = await patchShipment(orderId, shipmentId, { carrier: 'DHL', trackingNumber: 'A1' });

    expect(res.statusCode).toBe(200);
    expect(await linesOf(orderId)).toEqual([]);
    expect(mails).toEqual([]);
  });

  it('keeps the change when its mail cannot be sent, and logs it with the order id only', async () => {
    const buyer = await newUser();
    const { orderId, shipmentId } = await shipped({ carrier: 'DHL', trackingNumber: 'A1' }, buyer);
    refuseMail();

    const res = await patchShipment(orderId, shipmentId, { trackingNumber: 'B2' });

    expect(res.statusCode).toBe(200);
    expect((await rowOf(shipmentId)).trackingNumber).toBe('B2');
    const logged = takeLogs({ msg: 'order shipment changed mail was not sent' });
    expect(logged).toEqual([expect.objectContaining({ orderId })]);
    expect(JSON.stringify(logged)).not.toContain(buyer.email);
  });

  it('mails nobody when the account of the buyer is deleted', async () => {
    const buyer = await newUser();
    const { orderId, shipmentId } = await shipped({ carrier: 'DHL', trackingNumber: 'A1' }, buyer);
    const root = await newUser({ role: 'ROOT' });
    await app.inject({
      method: 'DELETE',
      url: `/api/users/${buyer.id}`,
      headers: withCsrf(csrf, accessCookie(root)),
    });
    const mails = watchMail();

    const res = await patchShipment(orderId, shipmentId, { trackingNumber: 'B2' });

    expect(res.statusCode).toBe(200);
    expect(mails).toEqual([]);
  });

  it.each([
    ['a send of a delivered order', 'delivered'],
    ['a send that was taken back', 'paid'],
  ])('refuses to change the carrier of %s', async (_case, stage) => {
    const { orderId, shipmentId } = await shipped();
    if (stage === 'delivered') await setStatus(orderId, 'delivered');
    if (stage === 'paid') await setStatus(orderId, 'paid', { keepShippingCost: true });

    const res = await patchShipment(orderId, shipmentId, { carrier: 'UPS' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'SHIPMENT_NOT_EDITABLE' });
    expect((await rowOf(shipmentId)).carrier).toBe('DHL');
  });

  it('answers 404 for a send of another order and for one that is not there', async () => {
    const first = await shipped();
    const second = await shipped();

    const other = await patchShipment(first.orderId, second.shipmentId, { carrier: 'UPS' });
    const missing = await patchShipment(first.orderId, 2_000_000_000, { carrier: 'UPS' });
    const noOrder = await patchShipment(2_000_000_000, 1, { carrier: 'UPS' });

    for (const res of [other, missing]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'SHIPMENT_NOT_FOUND' });
    }
    expect(noOrder.statusCode).toBe(404);
    expect(noOrder.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
  });

  it('refuses a buyer, also the owner of the order', async () => {
    const owner = await newUser();
    const { orderId, shipmentId } = await shipped({ carrier: 'DHL' }, owner);

    const res = await patchShipment(orderId, shipmentId, { carrier: 'UPS' }, owner);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('PATCH /api/orders/:orderId/shipments/:shipmentId: what the shop pays the carrier', () => {
  it('writes the cost later, with no mail to the buyer', async () => {
    const { orderId, shipmentId } = await shipped();
    const mails = watchMail();

    const res = await patchShipment(orderId, shipmentId, { cost: 7.5 });

    expect(res.statusCode).toBe(200);
    expect(res.json().shipments[0]).toMatchObject({ cost: 7.5, expense: true });
    expect(mails).toEqual([]);
    expect(await linesOf(orderId)).toEqual([
      expect.objectContaining({
        meta: [
          { field: 'shipment', old: shipmentId, new: shipmentId },
          { field: 'cost', old: null, new: 7.5 },
        ],
      }),
    ]);
  });

  it('corrects the cost, and takes the cost of zero', async () => {
    const { orderId, shipmentId } = await shipped({ carrier: 'DHL', cost: 7.5 });

    const lower = await patchShipment(orderId, shipmentId, { cost: 6.25 });
    const free = await patchShipment(orderId, shipmentId, { cost: 0 });
    const cleared = await patchShipment(orderId, shipmentId, { cost: null });

    expect(lower.json().shipments[0].cost).toBe(6.25);
    expect(free.json().shipments[0].cost).toBe(0);
    expect(cleared.json().shipments[0].cost).toBeNull();
  });

  // the carrier sends the invoice later, whatever became of the order
  it.each([
    ['shipped', 'shipped'],
    ['delivered', 'delivered'],
    ['taken back with the cost owed', 'paid'],
  ])('writes the cost of the send of an order that is %s', async (_case, stage) => {
    const { orderId, shipmentId } = await shipped();
    if (stage === 'delivered') await setStatus(orderId, 'delivered');
    if (stage === 'paid') await setStatus(orderId, 'paid', { keepShippingCost: true });

    const res = await patchShipment(orderId, shipmentId, { cost: 9 });

    expect(res.statusCode).toBe(200);
    expect(Number((await rowOf(shipmentId)).cost)).toBe(9);
  });

  it('refuses the cost of a send the shop owes nothing for', async () => {
    const { orderId, shipmentId } = await shipped({ carrier: 'DHL', cost: 5 });
    await setStatus(orderId, 'paid', { keepShippingCost: false });

    const res = await patchShipment(orderId, shipmentId, { cost: 9 });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'SHIPMENT_COST_NOT_OWED' });
    // the mistaken send cost nothing: 0 since the step back, and it stays 0
    expect(Number((await rowOf(shipmentId)).cost)).toBe(0);
  });

  it('writes the cost and the details at once, and mails the details', async () => {
    const { orderId, shipmentId } = await shipped({});
    const mails = watchMail();

    const res = await patchShipment(orderId, shipmentId, { cost: 4, trackingNumber: 'Z9' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SHIPMENT_CARRIER_REQUIRED' });
    expect(mails).toEqual([]);

    const withCarrier = await patchShipment(orderId, shipmentId, {
      cost: 4,
      carrier: 'UPS',
      trackingNumber: 'Z9',
    });

    expect(withCarrier.statusCode).toBe(200);
    expect(mails).toHaveLength(1);
  });
});

describe('POST /api/orders/status and the cost of a send', () => {
  it('shows the admin the cost in the list, and the buyer none of it', async () => {
    const owner = await newUser();
    const { orderId } = await shipped({ carrier: 'DHL', cost: 7.5 }, owner);

    const asAdminList = await app.inject({
      method: 'GET',
      url: `/api/orders?userId=${owner.id}`,
      headers: { cookie: accessCookie(admin) },
    });
    const asBuyerList = await app.inject({
      method: 'GET',
      url: '/api/orders',
      headers: { cookie: accessCookie(owner) },
    });

    expect(
      asAdminList.json().items.find((o: { id: number }) => o.id === orderId).shipments[0].cost,
    ).toBe(7.5);
    expect(JSON.stringify(asBuyerList.json())).not.toContain('"cost"');
    expect(JSON.stringify(asBuyerList.json())).not.toContain('"shipments"');
  });
});
