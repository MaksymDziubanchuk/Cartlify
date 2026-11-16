import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { DELIVERY_WEBHOOK_PATH, deliveryProvider } from '@providers/delivery/index.js';
import { applyDeliveryEvents } from '@routes/api/delivery/services/deliveryEvents.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { CARRIER_SHOP, SIZED, carrierOrder } from '../../../helpers/carrierOrders.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { watchMail } from '../../../helpers/mail.js';
import { deliveryHarness } from '../../../helpers/providers.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';

import type { DeliveryEventKind } from '@providers/delivery/index.js';

// the parcels that do not reach the buyer (decisions 16, 17 and 21 of the delivery, scenarios 31 to
// 35): one going back without a reason, back at the shop or lost waits for the admin, who tells the
// refusal (the units of the parcels coming back only, the moment the admin gives) or opens a
// statement of the lost units on the usual routes; a refusal the carrier tells opens its statement
// itself, with the moment of the event, unless a statement of the buyer holds the units already

const harness = deliveryHarness[deliveryProvider.name];

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

afterEach(resetShopSettings);

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const box = (orderItemId: number) => ({
  weightGrams: 400,
  lengthMm: 300,
  widthMm: 200,
  heightMm: 50,
  items: [{ orderItemId, quantity: 1 }],
});

type Parcel = { id: number; parcelId: string; reference: string; trackingNumber: string | null };

// an order of a mug and a lamp sent by the carrier: one parcel of both, or two, taken by the carrier
async function sentOrder(two = false) {
  setShopSettings(CARRIER_SHOP);
  const mug = await createProduct({ price: 10, stock: 5, ...SIZED });
  const lamp = await createProduct({ price: 30, stock: 5, ...SIZED });
  const { buyer, orderId } = await carrierOrder(app, csrf, [
    { variantId: mug.variantId, quantity: 1 },
    { variantId: lamp.variantId, quantity: 1 },
  ]);
  userIds.push(buyer.id);
  const [mugItem, lampItem] = (
    await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
    )
  ).map((one) => one.id);
  const made = await asStaff(`/api/orders/${orderId}/parcels`, {
    ...(two ? { parcels: [{ boxes: [box(mugItem!)] }, { boxes: [box(lampItem!)] }] } : {}),
  });
  expect(made.statusCode).toBe(200);

  const parcels: Parcel[] = (
    await asAdmin((tx) =>
      tx.orderShipment.findMany({
        where: { orderId },
        orderBy: { id: 'asc' },
        select: { id: true, providerParcelId: true, trackingNumber: true },
      }),
    )
  ).map((one) => ({
    id: one.id,
    parcelId: one.providerParcelId!,
    reference: 'x',
    trackingNumber: one.trackingNumber,
  }));
  // a refusal comes neither before the payment nor before the send: the carrier took the parcels
  // at the payment (the provider tells whole seconds), the moments of the refusals are the payment
  const { paidAt } = await asAdmin((tx) =>
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
  );
  for (const parcel of parcels) await event('collected', parcel, paidAt!);
  expect(await statusOf(orderId)).toBe('shipped');
  return { buyer, orderId, mugItem: mugItem!, lampItem: lampItem!, parcels, paidAt: paidAt! };
}

const asStaff = (url: string, payload: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

async function event(kind: DeliveryEventKind, parcel: Parcel, at?: Date) {
  const res = await app.inject({
    method: 'POST',
    url: DELIVERY_WEBHOOK_PATH,
    headers: harness.webhookHeaders(),
    payload: JSON.stringify(harness.eventBody(kind, parcel, at)),
  });
  expect(res.statusCode).toBe(200);
}

// what another provider tells: the parcel goes back because the buyer refused it
const refusedBy = (parcel: Parcel, at: Date) =>
  applyDeliveryEvents(
    [
      {
        parcelId: parcel.parcelId,
        reference: parcel.reference,
        kind: 'returning',
        at,
        trackingNumber: parcel.trackingNumber,
        refused: true,
      },
    ],
    { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
  );

const stateOf = async (shipmentId: number) =>
  (
    await asAdmin((tx) =>
      tx.orderShipment.findUniqueOrThrow({ where: { id: shipmentId }, select: { state: true } }),
    )
  ).state;

const statusOf = async (orderId: number) =>
  (
    await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } }),
    )
  ).status;

// the statements of the order with their rows: the item and its units
const statementsOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.orderReturn.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: {
        source: true,
        basis: true,
        reason: true,
        statedAt: true,
        items: { orderBy: { orderItemId: 'asc' }, select: { orderItemId: true, quantity: true } },
      },
    }),
  );

// the admin tells the refusal of the parcel, at the moment the carrier gives
const tellRefusal = (orderId: number, orderItemId: number, statedAt: Date) =>
  asStaff('/api/returns', {
    orderId,
    items: [{ orderItemId, quantity: 1 }],
    basis: 'withdrawal',
    reason: 'refused',
    statedAt: statedAt.toISOString(),
  });

describe('a parcel that goes back to the shop', () => {
  it('waits for the admin without a reason; the refusal the admin tells takes the parcel', async () => {
    const { orderId, mugItem, lampItem, parcels, paidAt } = await sentOrder();

    await event('returning', parcels[0]!);

    expect(await stateOf(parcels[0]!.id)).toBe('returning');
    expect(await statementsOf(orderId)).toEqual([]);
    expect(await statusOf(orderId)).toBe('shipped');

    // the admin names one item: a refused parcel is refused whole
    const res = await tellRefusal(orderId, mugItem, paidAt);
    expect(res.statusCode).toBe(201);
    expect(await statementsOf(orderId)).toEqual([
      expect.objectContaining({
        reason: 'refused',
        statedAt: paidAt,
        items: [
          { orderItemId: mugItem, quantity: 1 },
          { orderItemId: lampItem, quantity: 1 },
        ],
      }),
    ]);
  });

  it('takes only the units of the parcel coming back when another one of the order was delivered', async () => {
    const { orderId, mugItem, lampItem, parcels, paidAt } = await sentOrder(true);
    await event('delivered', parcels[1]!);
    await event('returning', parcels[0]!);

    const res = await tellRefusal(orderId, lampItem, paidAt);

    expect(res.statusCode).toBe(201);
    expect((await statementsOf(orderId))[0]!.items).toEqual([
      { orderItemId: mugItem, quantity: 1 },
    ]);
  });

  it('lets the admin tell a refusal no event announced: it takes the parcels on their way, not the delivered one', async () => {
    const { orderId, mugItem, lampItem, parcels, paidAt } = await sentOrder(true);
    await event('delivered', parcels[1]!);
    // the provider told nothing of the parcel of the mug: it may skip the state, or never send it
    expect(await stateOf(parcels[0]!.id)).toBe('sent');

    const res = await tellRefusal(orderId, lampItem, paidAt);

    expect(res.statusCode).toBe(201);
    expect((await statementsOf(orderId))[0]!.items).toEqual([
      { orderItemId: mugItem, quantity: 1 },
    ]);
  });

  it('keeps the order shipped when the carrier still delivers a parcel the admin told refused', async () => {
    const { buyer, orderId, mugItem, parcels, paidAt } = await sentOrder();
    expect((await tellRefusal(orderId, mugItem, paidAt)).statusCode).toBe(201);
    const mails = watchMail();

    // answered 200 (event): an error would make the provider post it again for ever
    await event('delivered', parcels[0]!);

    expect(await stateOf(parcels[0]!.id)).toBe('delivered');
    expect(await statusOf(orderId)).toBe('shipped');
    expect(mails.filter((mail) => mail.to.includes(buyer.email))).toEqual([]);
  });

  it('keeps a refusal the carrier tells to the parcels coming back, not the ones still on their way', async () => {
    const { orderId, mugItem, parcels, paidAt } = await sentOrder(true);

    await refusedBy(parcels[0]!, paidAt);

    expect(await statementsOf(orderId)).toEqual([
      expect.objectContaining({
        source: 'system',
        reason: 'refused',
        items: [{ orderItemId: mugItem, quantity: 1 }],
      }),
    ]);
  });

  it('voids no parcel only made for a refusal: its units are the ones of the parcel the carrier took', async () => {
    setShopSettings(CARRIER_SHOP);
    const mug = await createProduct({ price: 10, stock: 5, ...SIZED });
    const { buyer, orderId } = await carrierOrder(app, csrf, [
      { variantId: mug.variantId, quantity: 2 },
    ]);
    userIds.push(buyer.id);
    const { id: item } = await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } }),
    );
    // a mug in each of two parcels: the carrier took the first only
    const made = await asStaff(`/api/orders/${orderId}/parcels`, {
      parcels: [{ boxes: [box(item)] }, { boxes: [box(item)] }],
    });
    expect(made.statusCode).toBe(200);
    const [first, second] = await asAdmin((tx) =>
      tx.orderShipment.findMany({
        where: { orderId },
        orderBy: { id: 'asc' },
        select: { id: true, providerParcelId: true, trackingNumber: true },
      }),
    );
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );
    await event(
      'collected',
      {
        id: first!.id,
        parcelId: first!.providerParcelId!,
        reference: 'x',
        trackingNumber: first!.trackingNumber,
      },
      paidAt!,
    );

    const res = await tellRefusal(orderId, item, paidAt!);

    expect(res.statusCode).toBe(201);
    expect((await statementsOf(orderId))[0]!.items).toEqual([{ orderItemId: item, quantity: 1 }]);
    expect(await stateOf(second!.id)).toBe('created');
  });

  it('opens the statement of a refusal the carrier tells itself, at its moment, and mails the buyer', async () => {
    const { buyer, orderId, mugItem, lampItem, parcels, paidAt } = await sentOrder();
    const mails = watchMail();

    await refusedBy(parcels[0]!, paidAt);

    expect(await stateOf(parcels[0]!.id)).toBe('returning');
    expect(await statementsOf(orderId)).toEqual([
      {
        source: 'system',
        basis: 'withdrawal',
        reason: 'refused',
        statedAt: paidAt,
        items: [
          { orderItemId: mugItem, quantity: 1 },
          { orderItemId: lampItem, quantity: 1 },
        ],
      },
    ]);
    expect(mails.filter((mail) => mail.to.includes(buyer.email))).toHaveLength(1);

    // the same event again: nothing more
    await refusedBy(parcels[0]!, paidAt);
    expect(await statementsOf(orderId)).toHaveLength(1);
  });

  it('leaves the statement of a buyer who withdrew while it was on its way: the parcel only goes back', async () => {
    const { buyer, orderId, parcels, paidAt } = await sentOrder();
    const withdrawn = await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/withdrawal`,
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: {},
    });
    expect(withdrawn.statusCode).toBe(201);

    await refusedBy(parcels[0]!, paidAt);

    expect(await stateOf(parcels[0]!.id)).toBe('returning');
    expect((await statementsOf(orderId)).map((one) => one.source)).toEqual(['account']);
  });

  it('is back at the shop: the admin tells the refusal with the moment it came back', async () => {
    const { orderId, mugItem, parcels, paidAt } = await sentOrder();
    await event('returning', parcels[0]!);

    await event('returned', parcels[0]!);

    expect(await stateOf(parcels[0]!.id)).toBe('returned');
    const res = await tellRefusal(orderId, mugItem, paidAt);
    expect(res.statusCode).toBe(201);
    expect((await statementsOf(orderId))[0]!.items).toHaveLength(2);
  });
});

describe('an order whose parcels end differently', () => {
  it('delivers a parcel that went back and reached the buyer after all', async () => {
    const { orderId, parcels } = await sentOrder();
    await event('returning', parcels[0]!);

    await event('delivered', parcels[0]!);

    expect(await stateOf(parcels[0]!.id)).toBe('delivered');
    expect(await statusOf(orderId)).toBe('delivered');
  });

  it('is delivered by the parcel that reached the buyer once a statement holds the units of the lost one', async () => {
    const { orderId, mugItem, parcels } = await sentOrder(true);
    await event('delivered', parcels[1]!);
    await event('lost', parcels[0]!);
    // the lost mug is in no statement yet: the admin has to tell what became of it
    expect(await statusOf(orderId)).toBe('shipped');

    const res = await asStaff('/api/returns', {
      orderId,
      items: [{ orderItemId: mugItem, quantity: 1 }],
      basis: 'other',
      reason: 'other',
    });

    expect(res.statusCode).toBe(201);
    expect(await statusOf(orderId)).toBe('delivered');
  });
});

describe('a parcel the carrier lost', () => {
  it('waits for the admin, who opens a statement of its units', async () => {
    const { orderId, mugItem, parcels } = await sentOrder();

    await event('lost', parcels[0]!);

    expect(await stateOf(parcels[0]!.id)).toBe('lost');
    expect(await statusOf(orderId)).toBe('shipped');
    const res = await asStaff('/api/returns', {
      orderId,
      items: [{ orderItemId: mugItem, quantity: 1 }],
      basis: 'other',
      reason: 'other',
    });
    expect(res.statusCode).toBe(201);
    expect(await statementsOf(orderId)).toEqual([
      expect.objectContaining({ basis: 'other', reason: 'other' }),
    ]);
  });
});
