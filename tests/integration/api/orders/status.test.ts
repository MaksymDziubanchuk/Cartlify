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
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { refuseMail, watchMail, type SentMail } from '../../../helpers/mail.js';
import {
  addShipment,
  deliveryAnswer,
  deliveryBody,
  orderRowOf,
  placeOrder,
  placeUnconfirmedOrder,
} from '../../../helpers/orders.js';

// PATCH /api/orders/:orderId/status: an admin moves a paid order along its delivery, paid to
// shipped to delivered, and one step back. Shipping a manual order records the send (who carries it,
// the number, the link, what the shop pays); a pickup is shipped when it is ready to be collected.
// Every step mails the buyer unless the account is deleted. A cancel returns money and stock, it is
// a route of its own

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
// an order keeps its product, so these products stay; the test database goes after the run
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const newProduct = async () => {
  const product = await createProduct({ price: 10, stock: 5 });
  products.push(product);
  return product;
};

const { address: _address, ...person } = deliveryBody;
const pickupBody = { ...person, method: 'pickup' };

const setStatus = (
  actor: TestUser,
  orderId: number | string,
  status: string,
  extra: Record<string, unknown> = {},
) =>
  app.inject({
    method: 'PATCH',
    url: `/api/orders/${orderId}/status`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: { status, ...extra },
  });

const paidOrder = async (buyer?: TestUser, delivery: Record<string, unknown> = deliveryBody) =>
  placeOrder(app, csrf, buyer ?? (await newUser()), await newProduct(), 'paid', 1, delivery);

// an order that is shipped, by the route, with a send as the admin gives it
const shippedOrder = async (
  shipment: Record<string, unknown> = {},
  buyer?: TestUser,
  delivery: Record<string, unknown> = deliveryBody,
) => {
  const orderId = await paidOrder(buyer, delivery);
  const res = await setStatus(
    admin,
    orderId,
    'shipped',
    delivery.method === 'pickup' ? {} : { shipment },
  );
  expect(res.statusCode).toBe(200);
  return orderId;
};

const shipmentsOf = (orderId: number) =>
  asAdmin((tx) => tx.orderShipment.findMany({ where: { orderId }, orderBy: { id: 'asc' } }));

// each step of the status writes a line to the admin log
const statusLinesOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'order', entityId: orderId, action: 'ORDER_STATUS_CHANGE' },
      orderBy: { id: 'asc' },
      select: { actorId: true, actorRole: true, meta: true },
    }),
  );

// the messages the log gets when a mail of a step cannot be sent; no line at all means no mail was tried
const MAIL_FAILED = {
  shipped: 'order shipped mail was not sent',
  delivered: 'order delivered mail was not sent',
  pickupReady: 'order pickup ready mail was not sent',
  detailsChanged: 'order details changed mail was not sent',
  deliveryCorrected: 'order delivery corrected mail was not sent',
} as const;

const expectNoMailTried = (mails: SentMail[]) => {
  expect(mails).toEqual([]);
  for (const message of Object.values(MAIL_FAILED)) expect(takeLogs({ msg: message })).toEqual([]);
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
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

describe('PATCH /api/orders/:orderId/status: the steps on', () => {
  it('ships a paid order and answers with where it goes and the send', async () => {
    const orderId = await paidOrder();

    const res = await setStatus(admin, orderId, 'shipped', {
      shipment: {
        carrier: 'DHL Express',
        trackingNumber: 'JD0146000123',
        trackingUrl: 'https://track.example.com/JD0146000123',
        cost: 7.5,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: orderId,
      status: 'shipped',
      delivery: {
        ...deliveryAnswer,
        shipment: {
          carrier: 'DHL Express',
          trackingNumber: 'JD0146000123',
          trackingUrl: 'https://track.example.com/JD0146000123',
        },
      },
      shipments: [
        {
          carrier: 'DHL Express',
          trackingNumber: 'JD0146000123',
          cost: 7.5,
          expense: true,
          rolledBackAt: null,
        },
      ],
    });
    expect(res.json()).not.toHaveProperty('paymentId');
    expect(res.json()).not.toHaveProperty('paymentProvider');
    expect((await orderRowOf(orderId)).status).toBe('shipped');
    expect(await shipmentsOf(orderId)).toEqual([
      expect.objectContaining({
        carrier: 'DHL Express',
        trackingNumber: 'JD0146000123',
        expense: true,
      }),
    ]);
  });

  it('ships a manual order with nothing said about the send, and records an empty one for the cost', async () => {
    const orderId = await paidOrder();

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(200);
    expect(res.json().delivery.shipment).toEqual({
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
    });
    expect(res.json().shipments).toEqual([
      expect.objectContaining({ carrier: null, trackingNumber: null, cost: null, expense: true }),
    ]);
  });

  it('takes a send with the cost of zero, and with only a carrier', async () => {
    const free = await paidOrder();
    const named = await paidOrder();

    const zero = await setStatus(admin, free, 'shipped', { shipment: { cost: 0 } });
    const carrier = await setStatus(admin, named, 'shipped', {
      shipment: { carrier: 'Local post' },
    });

    expect(zero.json().shipments[0]).toMatchObject({ cost: 0, carrier: null });
    expect(carrier.json().shipments[0]).toMatchObject({ cost: null, carrier: 'Local post' });
  });

  it('marks a shipped order delivered', async () => {
    const orderId = await shippedOrder();

    const res = await setStatus(admin, orderId, 'delivered');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'delivered' });
  });

  it('lets root move an order as well', async () => {
    const orderId = await paidOrder();

    const res = await setStatus(root, orderId, 'shipped');

    expect(res.statusCode).toBe(200);
  });

  it('refuses a cancel here and keeps the order paid', async () => {
    const orderId = await paidOrder();

    const res = await setStatus(admin, orderId, 'cancelled');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect((await orderRowOf(orderId)).status).toBe('paid');
  });

  it.each(['pending', 'waiting', 'unconfirmed'])(
    'refuses the status %s, an admin does not set it',
    async (status) => {
      const orderId = await paidOrder();

      const res = await setStatus(admin, orderId, status);

      expect(res.statusCode).toBe(400);
      expect((await orderRowOf(orderId)).status).toBe('paid');
    },
  );

  // the order is there, its state does not allow the step: the answer must not say "not found"
  it.each([
    ['an order waiting for its payment', 'waiting'],
    ['an unconfirmed order', 'unconfirmed'],
    ['the cart', 'cart'],
  ] as const)('refuses to ship %s as a conflict', async (_case, stage) => {
    const user = await newUser();
    const orderId =
      stage === 'unconfirmed'
        ? await placeUnconfirmedOrder(app, csrf, user, await newProduct())
        : await placeOrder(app, csrf, user, await newProduct(), stage);
    const before = (await orderRowOf(orderId)).status;

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
      details: { status: before, requested: 'shipped' },
    });
    expect((await orderRowOf(orderId)).status).toBe(before);
    expect(await shipmentsOf(orderId)).toEqual([]);
  });

  // the steps go one by one: a paid order is delivered after it is shipped
  it('refuses to deliver a paid order that was not shipped', async () => {
    const orderId = await paidOrder();

    const res = await setStatus(admin, orderId, 'delivered');

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
      details: { status: 'paid', requested: 'delivered' },
    });
    expect((await orderRowOf(orderId)).status).toBe('paid');
  });

  it.each([
    ['ship an order shipped already', 'shipped', 'shipped'],
    ['mark a paid order paid', 'paid', 'paid'],
    ['move a delivered order to paid', 'delivered', 'paid'],
    ['deliver an order delivered already', 'delivered', 'delivered'],
  ] as const)('refuses to %s', async (_case, stage, requested) => {
    const orderId = await shippedOrder();
    if (stage === 'delivered') await setStatus(admin, orderId, 'delivered');
    if (stage === 'paid') await setStatus(admin, orderId, 'paid', { keepShippingCost: false });

    const res = await setStatus(
      admin,
      orderId,
      requested,
      requested === 'paid' ? { keepShippingCost: false } : {},
    );

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_STATUS_TRANSITION_INVALID',
      details: { status: stage, requested },
    });
  });

  it('answers 404 for an order that does not exist', async () => {
    const res = await setStatus(admin, 2_000_000_000, 'shipped');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_FOUND' });
  });

  it('refuses a user, also the owner of the order', async () => {
    const owner = await newUser();
    const orderId = await paidOrder(owner);

    const res = await setStatus(owner, orderId, 'shipped');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect((await orderRowOf(orderId)).status).toBe('paid');
  });

  it('shows the buyer the send on its way without the cost, and an admin the cost', async () => {
    const owner = await newUser();
    const orderId = await shippedOrder({ carrier: 'DHL', trackingNumber: 'A1', cost: 7.5 }, owner);

    const asBuyer = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(owner) },
    });
    const asAdminRes = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(admin) },
    });

    expect(asBuyer.json().delivery.shipment).toEqual({
      carrier: 'DHL',
      trackingNumber: 'A1',
      trackingUrl: null,
    });
    expect(asBuyer.json()).not.toHaveProperty('shipments');
    // what the send cost the shop is for the admin only
    expect(JSON.stringify(asBuyer.json())).not.toContain('"cost"');
    expect(asAdminRes.json().shipments[0]).toMatchObject({ carrier: 'DHL', cost: 7.5 });
  });
});

describe('PATCH /api/orders/:orderId/status: the send of the shipped step', () => {
  it.each([
    ['a number without a carrier', { trackingNumber: 'A1' }, 'SHIPMENT_CARRIER_REQUIRED'],
    [
      'a link without a carrier',
      { trackingUrl: 'https://track.example.com/1' },
      'SHIPMENT_CARRIER_REQUIRED',
    ],
    ['a carrier of only spaces', { carrier: '   ' }, 'SHIPMENT_CARRIER_INVALID'],
  ])('refuses %s and ships nothing', async (_case, shipment, errorCode) => {
    const orderId = await paidOrder();

    const res = await setStatus(admin, orderId, 'shipped', { shipment });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect((await orderRowOf(orderId)).status).toBe('paid');
    expect(await shipmentsOf(orderId)).toEqual([]);
  });

  it.each([
    [
      'a link that is not https',
      { carrier: 'DHL', trackingNumber: '1', trackingUrl: 'http://track.example.com/1' },
    ],
    [
      'a link with a space',
      { carrier: 'DHL', trackingNumber: '1', trackingUrl: 'https://track.example.com/a b' },
    ],
    ['a carrier of 101 characters', { carrier: 'x'.repeat(101) }],
    ['a number of 101 characters', { carrier: 'DHL', trackingNumber: 'x'.repeat(101) }],
    [
      'a link of 501 characters',
      {
        carrier: 'DHL',
        trackingNumber: '1',
        trackingUrl: `https://a.example.com/${'x'.repeat(480)}`,
      },
    ],
    ['a cost below zero', { cost: -1 }],
    ['a cost of a fraction of a cent', { cost: 1.005 }],
    ['a cost over the most the database holds', { cost: 100_000_000 }],
  ])('refuses %s by the request schema', async (_case, shipment) => {
    const orderId = await paidOrder();

    const res = await setStatus(admin, orderId, 'shipped', { shipment });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('cuts the spaces around the carrier, the number and the link', async () => {
    const orderId = await paidOrder();

    const res = await setStatus(admin, orderId, 'shipped', {
      shipment: {
        carrier: ' DHL ',
        trackingNumber: ' A1 ',
        trackingUrl: 'https://track.example.com/1',
      },
    });

    expect(res.json().shipments[0]).toMatchObject({ carrier: 'DHL', trackingNumber: 'A1' });
  });

  it('refuses a send with any step but shipped', async () => {
    const orderId = await shippedOrder();

    const res = await setStatus(admin, orderId, 'delivered', { shipment: { carrier: 'DHL' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SHIPMENT_NOT_ALLOWED' });
    expect((await orderRowOf(orderId)).status).toBe('shipped');
  });

  it('refuses a send for a pickup, which has no carrier', async () => {
    const orderId = await paidOrder(undefined, pickupBody);

    const res = await setStatus(admin, orderId, 'shipped', { shipment: { carrier: 'DHL' } });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SHIPMENT_NOT_ALLOWED' });
    expect((await orderRowOf(orderId)).status).toBe('paid');
  });

  it('ships a pickup as ready to be collected, with no send recorded', async () => {
    const orderId = await paidOrder(undefined, pickupBody);

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'shipped',
      delivery: { method: 'pickup', shipment: null },
    });
    expect(res.json().shipments).toEqual([]);
    expect(await shipmentsOf(orderId)).toEqual([]);
  });

  it('writes the step with its send to the admin log in the name of the admin', async () => {
    const orderId = await paidOrder();

    await setStatus(admin, orderId, 'shipped', {
      shipment: { carrier: 'DHL', trackingNumber: 'A1', cost: 5 },
    });
    await setStatus(admin, orderId, 'delivered');

    const lines = await statusLinesOf(orderId);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ actorId: admin.id, actorRole: 'ADMIN' });
    expect(lines[0]!.meta).toEqual([
      { field: 'status', old: 'paid', new: 'shipped' },
      {
        field: 'shipment',
        old: null,
        new: expect.objectContaining({ carrier: 'DHL', trackingNumber: 'A1', cost: 5 }),
      },
    ]);
    expect(lines[1]!.meta).toEqual([{ field: 'status', old: 'shipped', new: 'delivered' }]);
  });
});

describe('PATCH /api/orders/:orderId/status: a step back', () => {
  it('moves a shipped manual order back to paid, keeping the cost of the send as owed', async () => {
    const orderId = await shippedOrder({ carrier: 'DHL', trackingNumber: 'A1', cost: 7 });

    const res = await setStatus(admin, orderId, 'paid', { keepShippingCost: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'paid', delivery: { shipment: null } });
    const [send] = await shipmentsOf(orderId);
    expect(send).toMatchObject({ carrier: 'DHL', trackingNumber: 'A1', expense: true });
    expect(send!.rolledBackAt).not.toBeNull();
    expect(Number(send!.cost)).toBe(7);
  });

  // the row of the send stays, it cost the shop nothing: 0, and the cost it had is in the log
  it('moves it back making the send cost nothing, when the shipping was a mistake', async () => {
    const orderId = await shippedOrder({ carrier: 'DHL', cost: 7 });

    const res = await setStatus(admin, orderId, 'paid', { keepShippingCost: false });

    expect(res.statusCode).toBe(200);
    const [send] = await shipmentsOf(orderId);
    expect(send).toMatchObject({ expense: false });
    expect(Number(send!.cost)).toBe(0);
    expect(send!.rolledBackAt).not.toBeNull();
    const [line] = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'order.ship_back' },
      }),
    );
    expect(line!.meta).toEqual(expect.arrayContaining([{ field: 'shippingCost', old: 7, new: 0 }]));
  });

  it('asks which of them it is for a manual order', async () => {
    const orderId = await shippedOrder();

    const res = await setStatus(admin, orderId, 'paid');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'KEEP_SHIPPING_COST_REQUIRED' });
    expect((await orderRowOf(orderId)).status).toBe('shipped');
  });

  it('asks nothing for a pickup, and takes no choice for it', async () => {
    const orderId = await shippedOrder({}, undefined, pickupBody);

    const refused = await setStatus(admin, orderId, 'paid', { keepShippingCost: true });
    const res = await setStatus(admin, orderId, 'paid');

    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ errorCode: 'KEEP_SHIPPING_COST_NOT_ALLOWED' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'paid' });
  });

  it('takes the choice with the step back only', async () => {
    const orderId = await paidOrder();

    const res = await setStatus(admin, orderId, 'shipped', { keepShippingCost: true });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'KEEP_SHIPPING_COST_NOT_ALLOWED' });
  });

  it('records a new send when an order is shipped again, and keeps the first as history', async () => {
    const orderId = await shippedOrder({ carrier: 'DHL', cost: 7 });
    await setStatus(admin, orderId, 'paid', { keepShippingCost: true });

    const res = await setStatus(admin, orderId, 'shipped', {
      shipment: { carrier: 'UPS', cost: 9 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().shipments.map((s: { carrier: string }) => s.carrier)).toEqual(['UPS', 'DHL']);
    expect(res.json().delivery.shipment).toMatchObject({ carrier: 'UPS' });
    expect((await shipmentsOf(orderId)).map((s) => s.rolledBackAt === null)).toEqual([false, true]);
  });

  it('moves a delivered order back to shipped, the send stays as it was', async () => {
    const orderId = await shippedOrder({ carrier: 'DHL', trackingNumber: 'A1', cost: 7 });
    await setStatus(admin, orderId, 'delivered');

    const res = await setStatus(admin, orderId, 'shipped');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'shipped',
      delivery: { shipment: { carrier: 'DHL' } },
    });
    const sends = await shipmentsOf(orderId);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.rolledBackAt).toBeNull();
  });

  it('writes a step back to the admin log with the send it took back', async () => {
    const orderId = await shippedOrder({ carrier: 'DHL', trackingNumber: 'A1', cost: 7 });

    await setStatus(admin, orderId, 'paid', { keepShippingCost: false });

    const lines = await statusLinesOf(orderId);
    expect(lines[lines.length - 1]!.meta).toEqual([
      { field: 'status', old: 'shipped', new: 'paid' },
      {
        field: 'shipment',
        old: expect.objectContaining({ carrier: 'DHL', trackingNumber: 'A1', cost: 7 }),
        new: null,
      },
      { field: 'shippingCostKept', old: null, new: false },
      { field: 'shippingCost', old: 7, new: 0 },
    ]);
  });

  it('writes a delivered order moved back to the admin log', async () => {
    const orderId = await shippedOrder();
    await setStatus(admin, orderId, 'delivered');

    await setStatus(admin, orderId, 'shipped');

    const lines = await statusLinesOf(orderId);
    expect(lines[lines.length - 1]!.meta).toEqual([
      { field: 'status', old: 'delivered', new: 'shipped' },
    ]);
  });
});

describe('PATCH /api/orders/:orderId/status: the mails of the steps', () => {
  it('mails the buyer that the order is shipped, where, to whom and how to follow it', async () => {
    const buyer = await newUser({ name: 'Anna' });
    const orderId = await paidOrder(buyer);
    const mails = watchMail();

    await setStatus(admin, orderId, 'shipped', {
      shipment: {
        carrier: 'DHL',
        trackingNumber: 'JD0146',
        trackingUrl: 'https://track.example.com/JD0146',
      },
    });

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: [buyer.email], accepted: true });
    expect(mails[0]!.subject).toBe(`Cartlify — Order #${orderId} is shipped`);
    expect(mails[0]!.text).toContain('Shipping to: Test street 1, 01001 Kyiv, UA');
    expect(mails[0]!.text).toContain('Recipient: Anna Koval, +380501234567');
    expect(mails[0]!.text).toContain('Carrier: DHL');
    expect(mails[0]!.text).toContain('Tracking number: JD0146');
    expect(mails[0]!.text).toContain('https://track.example.com/JD0146');
    expect(mails[0]!.text).toContain(`https://shop.example.com/orders/${orderId}`);
    expect(mails[0]!.html).toContain('Hi Anna,');
  });

  // some carriers give only a link: the buyer gets the carrier and the link, and no empty number
  it('ships with a carrier and a link but no number, and mails the link', async () => {
    const orderId = await paidOrder();
    const mails = watchMail();

    const res = await setStatus(admin, orderId, 'shipped', {
      shipment: { carrier: 'DHL', trackingUrl: 'https://track.example.com/JD0146' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().delivery.shipment).toEqual({
      carrier: 'DHL',
      trackingNumber: null,
      trackingUrl: 'https://track.example.com/JD0146',
    });
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain('Carrier: DHL');
    expect(mails[0]!.text).toContain('Follow your parcel: https://track.example.com/JD0146');
    expect(mails[0]!.text).not.toContain('Tracking number');
    expect(mails[0]!.html).toContain('href="https://track.example.com/JD0146"');
    expect(mails[0]!.html).not.toContain('Tracking number');
  });

  it('says only that the order is shipped when nothing is said about the send', async () => {
    const orderId = await paidOrder();
    const mails = watchMail();

    await setStatus(admin, orderId, 'shipped');

    expect(mails[0]!.text).not.toContain('Carrier');
    expect(mails[0]!.text).not.toContain('Tracking number');
  });

  it('mails the buyer of a pickup that the order is ready, and where to collect it', async () => {
    const buyer = await newUser({ name: 'Anna' });
    const orderId = await paidOrder(buyer, pickupBody);
    const mails = watchMail();

    await setStatus(admin, orderId, 'shipped');

    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe(`Cartlify — Order #${orderId} is ready for pickup`);
    expect(mails[0]!.text).toContain('Test shop, Main street 1, Kyiv, Mon-Fri 10:00-18:00');
    expect(mails[0]!.text).toContain(`https://shop.example.com/orders/${orderId}`);
  });

  it('mails the buyer that the order is delivered, where and to whom', async () => {
    const buyer = await newUser({ name: 'Anna' });
    const orderId = await shippedOrder({}, buyer);
    const mails = watchMail();

    await setStatus(admin, orderId, 'delivered');

    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: [buyer.email], accepted: true });
    expect(mails[0]!.subject).toBe(`Cartlify — Order #${orderId} is delivered`);
    expect(mails[0]!.text).toContain('Delivered to: Test street 1, 01001 Kyiv, UA');
    expect(mails[0]!.text).toContain('Recipient: Anna Koval, +380501234567');
    expect(mails[0]!.html).toContain('Hi Anna,');
  });

  it('mails the buyer of a pickup that the order is collected', async () => {
    const orderId = await shippedOrder({}, undefined, pickupBody);
    const mails = watchMail();

    await setStatus(admin, orderId, 'delivered');

    expect(mails[0]!.subject).toBe(`Cartlify — Order #${orderId} is collected`);
    expect(mails[0]!.text).toContain(
      'Collected at: Test shop, Main street 1, Kyiv, Mon-Fri 10:00-18:00',
    );
  });

  it('mails the buyer that the details of the order were changed when it goes back to paid, with no reason', async () => {
    const orderId = await shippedOrder({ carrier: 'DHL', trackingNumber: 'A1' });
    const mails = watchMail();

    await setStatus(admin, orderId, 'paid', { keepShippingCost: true });

    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe(`Cartlify — The details of order #${orderId} changed`);
    expect(mails[0]!.text).toContain('Ask us in the chat on our site');
    // the admin explains in the chat: nothing of the send is in the mail
    expect(mails[0]!.text).not.toContain('DHL');
    expect(mails[0]!.text).not.toContain('A1');
  });

  it('mails the buyer to ignore the last mail when a delivered order goes back to shipped', async () => {
    const orderId = await shippedOrder();
    await setStatus(admin, orderId, 'delivered');
    const mails = watchMail();

    await setStatus(admin, orderId, 'shipped');

    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toBe(`Cartlify — Order #${orderId}: please ignore our last mail`);
    expect(mails[0]!.text).toContain('ignore our previous mail');
    expect(mails[0]!.text).toContain('as planned');
  });

  it('says a pickup moved back from collected waits to be collected', async () => {
    const orderId = await shippedOrder({}, undefined, pickupBody);
    await setStatus(admin, orderId, 'delivered');
    const mails = watchMail();

    await setStatus(admin, orderId, 'shipped');

    expect(mails[0]!.text).toContain('waiting to be collected');
    expect(mails[0]!.text).toContain('Test shop, Main street 1, Kyiv');
  });

  // each step mails its own mail and never another one
  it.each([
    ['paid', 'shipped', 'shipped'],
    ['shipped', 'delivered', 'delivered'],
    ['shipped', 'paid', 'detailsChanged'],
    ['delivered', 'shipped', 'deliveryCorrected'],
  ] as const)(
    'keeps a %s order moved to %s when its mail cannot be sent',
    async (stage, status, key) => {
      const buyer = await newUser();
      const orderId = await shippedOrder({}, buyer);
      if (stage === 'paid') await setStatus(admin, orderId, 'paid', { keepShippingCost: true });
      if (stage === 'delivered') await setStatus(admin, orderId, 'delivered');
      refuseMail();

      const res = await setStatus(
        admin,
        orderId,
        status,
        status === 'paid' ? { keepShippingCost: true } : {},
      );

      expect(res.statusCode).toBe(200);
      expect((await orderRowOf(orderId)).status).toBe(status);
      // the failed mail goes to the log with the id of the order, never with the address
      const logged = takeLogs({ msg: MAIL_FAILED[key] });
      expect(logged).toEqual([expect.objectContaining({ orderId })]);
      expect(JSON.stringify(logged)).not.toContain(buyer.email);
      for (const other of Object.keys(MAIL_FAILED).filter((name) => name !== key)) {
        expect(takeLogs({ msg: MAIL_FAILED[other as keyof typeof MAIL_FAILED] })).toEqual([]);
      }
    },
  );

  // a second request for the same step must not mail the buyer twice
  it.each(['shipped', 'delivered'] as const)(
    'mails nobody when the order is %s already',
    async (status) => {
      const orderId = await shippedOrder();
      if (status === 'delivered') await setStatus(admin, orderId, 'delivered');
      const mails = watchMail();

      const res = await setStatus(admin, orderId, status);

      expect(res.statusCode).toBe(409);
      expectNoMailTried(mails);
    },
  );

  it.each(['shipped', 'delivered'] as const)(
    'mails nobody when the step to %s is refused',
    async (status) => {
      const orderId = await placeOrder(app, csrf, await newUser(), await newProduct(), 'waiting');
      const mails = watchMail();

      const res = await setStatus(admin, orderId, status);

      expect(res.statusCode).toBe(409);
      expectNoMailTried(mails);
    },
  );

  // the address of a deleted account is not the person's any more
  it.each([
    ['paid', 'shipped'],
    ['shipped', 'delivered'],
  ] as const)(
    'moves a %s order of a deleted account to %s and mails nobody',
    async (stage, status) => {
      const buyer = await newUser();
      const orderId = stage === 'paid' ? await paidOrder(buyer) : await shippedOrder({}, buyer);
      const deleted = await app.inject({
        method: 'DELETE',
        url: `/api/users/${buyer.id}`,
        headers: withCsrf(csrf, accessCookie(root)),
      });
      expect(deleted.statusCode).toBe(200);
      const mails = watchMail();

      const res = await setStatus(admin, orderId, status);

      expect(res.statusCode).toBe(200);
      expect((await orderRowOf(orderId)).status).toBe(status);
      expectNoMailTried(mails);
    },
  );
});

describe('PATCH /api/orders/:orderId/status: two requests at once', () => {
  it('ships an order once, with one send and one mail', async () => {
    const orderId = await paidOrder();
    const mails = watchMail();

    const [first, second] = await Promise.all([
      setStatus(admin, orderId, 'shipped', { shipment: { carrier: 'DHL' } }),
      setStatus(root, orderId, 'shipped', { shipment: { carrier: 'UPS' } }),
    ]);

    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect(await shipmentsOf(orderId)).toHaveLength(1);
    expect(mails).toHaveLength(1);
  });
});

// a send made by an admin of an order it was shipped by hand: the helper of the tests writes it
describe('an order shipped without the route', () => {
  it('shows its send to the buyer', async () => {
    const owner = await newUser();
    const orderId = await placeOrder(app, csrf, owner, await newProduct(), 'shipped');
    await addShipment(orderId, { carrier: 'DPD', trackingNumber: 'Z9' });

    const res = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}`,
      headers: { cookie: accessCookie(owner) },
    });

    expect(res.json().delivery.shipment).toMatchObject({ carrier: 'DPD', trackingNumber: 'Z9' });
  });
});
