import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { DELIVERY_WEBHOOK_PATH, deliveryProvider } from '@providers/delivery/index.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cancelPaidOrder } from '../../../helpers/cancel.js';
import {
  CARRIER_SHOP,
  SIZED,
  carrierOrder,
  type CARRIERS,
} from '../../../helpers/carrierOrders.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { holdForReview } from '../../../helpers/orders.js';
import { moveClock } from '../../../helpers/payments.js';
import { deliveryHarness } from '../../../helpers/providers.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';

import type { DeliveryEventKind } from '@providers/delivery/index.js';

// the alerts of the parcels of the delivery provider (decisions 13 to 22 of the delivery, step 12):
// a parcel made and not taken for some days, one waiting for its void, one coming back or lost with
// units no statement holds, parcels ahead of their order (scenarios 25 and 29); the orders sent by a
// carrier and not delivered are among the orders sent and not delivered. Each kind names the list of
// orders with the filter parcels, whose total is its count; other files make orders at the same
// time, so a test looks for its own order: in the list narrowed by its number, and among the cases
// the admin can put aside (the server lets only a case the alert counts now)

const harness = deliveryHarness[deliveryProvider.name];
const DAY = 86_400_000;

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
let clock: { restore: () => void } | null = null;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterEach(() => {
  clock?.restore();
  clock = null;
  resetShopSettings();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Parcel = { id: number; parcelId: string; reference: string; trackingNumber: string | null };
type Alert = {
  kind: string;
  count: number;
  list: { path: string; query: Record<string, string> } | null;
};

const get = (url: string, actor: TestUser = admin) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

const send = (method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(admin)),
    ...(payload ? { payload } : {}),
  });

const alertOf = async (kind: string): Promise<Alert> => {
  const res = await get(`/api/admin/alerts?kinds=${kind}`);
  expect(res.statusCode).toBe(200);
  return (res.json().alerts as Alert[]).find((alert) => alert.kind === kind)!;
};

// the order in the list the alert names, narrowed by its number: [] when it is not there
async function listed(kind: string, orderId: number): Promise<number[]> {
  const { list } = await alertOf(kind);
  const query = new URLSearchParams({ ...list!.query, q: String(orderId) });
  const res = await get(`${list!.path}?${query}`);
  expect(res.statusCode).toBe(200);
  return (res.json().items as { id: number }[]).map((row) => row.id).filter((id) => id === orderId);
}

// the alert counts the order now: the server lets the admin put it aside
async function counted(kind: string, orderId: number): Promise<boolean> {
  const res = await send('PUT', `/api/admin/alerts/dismissals/${kind}/${orderId}`);
  if (res.statusCode === 404) {
    expect(res.json()).toMatchObject({ errorCode: 'ALERT_ITEM_NOT_FOUND' });
    return false;
  }
  expect(res.statusCode).toBe(200);
  expect((await send('DELETE', `/api/admin/alerts/dismissals/${kind}/${orderId}`)).statusCode).toBe(
    200,
  );
  return true;
}

// the case of the order in the alert and in its list together
async function expectCase(kind: string, orderId: number, is: boolean) {
  expect(await counted(kind, orderId)).toBe(is);
  expect(await listed(kind, orderId)).toEqual(is ? [orderId] : []);
}

// a paid order of a mug by the carrier with its parcel made
async function orderWithParcel(carrier: keyof typeof CARRIERS = 'MockExpress') {
  setShopSettings(CARRIER_SHOP);
  const mug = await createProduct({ price: 10, stock: 5, ...SIZED });
  const { buyer, orderId } = await carrierOrder(
    app,
    csrf,
    [{ variantId: mug.variantId, quantity: 1 }],
    {
      carrier,
    },
  );
  userIds.push(buyer.id);
  expect((await send('POST', `/api/orders/${orderId}/parcels`, {})).statusCode).toBe(200);
  const [row] = await asAdmin((tx) =>
    tx.orderShipment.findMany({
      where: { orderId },
      select: { id: true, providerParcelId: true, trackingNumber: true },
    }),
  );
  const parcel: Parcel = {
    id: row!.id,
    parcelId: row!.providerParcelId!,
    reference: 'x',
    trackingNumber: row!.trackingNumber,
  };
  const [item] = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, select: { id: true } }),
  );
  return { buyer, orderId, parcel, itemId: item!.id };
}

async function event(kind: DeliveryEventKind, parcel: Parcel, at?: Date) {
  const res = await app.inject({
    method: 'POST',
    url: DELIVERY_WEBHOOK_PATH,
    headers: harness.webhookHeaders(),
    payload: JSON.stringify(harness.eventBody(kind, parcel, at)),
  });
  expect(res.statusCode).toBe(200);
}

const paidAtOf = async (orderId: number) =>
  (
    await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    )
  ).paidAt!;

describe('parcels_not_collected', () => {
  it('counts a parcel the carrier has not taken once the days of the threshold are over', async () => {
    const { orderId, parcel } = await orderWithParcel();

    await expectCase('parcels_not_collected', orderId, false);

    clock = moveClock(3 * DAY + 3_600_000);
    expect((await alertOf('parcels_not_collected')).list!.query).toMatchObject({
      parcels: 'not_collected',
      parcelsMadeTo: expect.any(String),
    });
    await expectCase('parcels_not_collected', orderId, true);

    // taken: no longer a case
    await event('collected', parcel);
    await expectCase('parcels_not_collected', orderId, false);
  });
});

describe('parcels_void_pending', () => {
  it('counts a parcel of a cancelled order a carrier cannot be asked to void, until the admin confirms', async () => {
    const { orderId, parcel } = await orderWithParcel('Generic');
    await cancelPaidOrder(admin.id, orderId);

    await expectCase('parcels_void_pending', orderId, true);

    const confirmed = await send(
      'POST',
      `/api/orders/${orderId}/shipments/${parcel.id}/void-confirmation`,
    );
    expect(confirmed.statusCode).toBe(200);
    await expectCase('parcels_void_pending', orderId, false);
  });
});

describe('parcels_coming_back', () => {
  it('counts a parcel going back with units no statement holds, until the admin tells the refusal', async () => {
    const { orderId, parcel, itemId } = await orderWithParcel();
    const paidAt = await paidAtOf(orderId);
    await event('collected', parcel, paidAt);

    await expectCase('parcels_coming_back', orderId, false);
    await event('returning', parcel);
    await expectCase('parcels_coming_back', orderId, true);
    // back at the shop: still a case
    await event('returned', parcel);
    await expectCase('parcels_coming_back', orderId, true);

    const refusal = await send('POST', '/api/returns', {
      orderId,
      items: [{ orderItemId: itemId, quantity: 1 }],
      basis: 'withdrawal',
      reason: 'refused',
      statedAt: paidAt.toISOString(),
    });
    expect(refusal.statusCode).toBe(201);
    await expectCase('parcels_coming_back', orderId, false);
  });
});

describe('parcels_lost', () => {
  it('counts a parcel the carrier lost with units no statement holds, until a statement holds them', async () => {
    const { orderId, parcel, itemId } = await orderWithParcel();
    await event('collected', parcel);

    await event('lost', parcel);
    await expectCase('parcels_lost', orderId, true);

    const statement = await send('POST', '/api/returns', {
      orderId,
      items: [{ orderItemId: itemId, quantity: 1 }],
      basis: 'other',
      reason: 'other',
    });
    expect(statement.statusCode).toBe(201);
    await expectCase('parcels_lost', orderId, false);
  });
});

describe('parcels_ahead_of_order', () => {
  it('counts a held order the carrier took a parcel of (scenario 25)', async () => {
    const { orderId, parcel } = await orderWithParcel();
    await holdForReview(orderId);

    await expectCase('parcels_ahead_of_order', orderId, false);
    await event('collected', parcel);
    await expectCase('parcels_ahead_of_order', orderId, true);
  });

  it('counts a sent order whose parcel was delivered under an open refusal: the refusal may be none', async () => {
    const { orderId, parcel, itemId } = await orderWithParcel();
    const paidAt = await paidAtOf(orderId);
    await event('collected', parcel, paidAt);
    const refusal = await send('POST', '/api/returns', {
      orderId,
      items: [{ orderItemId: itemId, quantity: 1 }],
      basis: 'withdrawal',
      reason: 'refused',
      statedAt: paidAt.toISOString(),
    });
    expect(refusal.statusCode).toBe(201);

    await expectCase('parcels_ahead_of_order', orderId, false);
    await event('delivered', parcel);
    await expectCase('parcels_ahead_of_order', orderId, true);
  });

  it('counts a cancelled order whose parcel the carrier took anyway (scenario 29)', async () => {
    const { orderId, parcel } = await orderWithParcel('Generic');
    await cancelPaidOrder(admin.id, orderId);

    await expectCase('parcels_ahead_of_order', orderId, false);
    await event('collected', parcel);
    await expectCase('parcels_ahead_of_order', orderId, true);
  });

  it('leaves an order on its way: one parcel taken, another one not yet', async () => {
    setShopSettings(CARRIER_SHOP);
    const mug = await createProduct({ price: 10, stock: 5, ...SIZED });
    const lamp = await createProduct({ price: 30, stock: 5, ...SIZED });
    const { buyer, orderId } = await carrierOrder(app, csrf, [
      { variantId: mug.variantId, quantity: 1 },
      { variantId: lamp.variantId, quantity: 1 },
    ]);
    userIds.push(buyer.id);
    const items = await asAdmin((tx) =>
      tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
    );
    const box = (orderItemId: number) => ({
      ...{ weightGrams: 400, lengthMm: 300, widthMm: 200, heightMm: 50 },
      items: [{ orderItemId, quantity: 1 }],
    });
    await send('POST', `/api/orders/${orderId}/parcels`, {
      parcels: [{ boxes: [box(items[0]!.id)] }, { boxes: [box(items[1]!.id)] }],
    });
    const [first] = await asAdmin((tx) =>
      tx.orderShipment.findMany({
        where: { orderId },
        orderBy: { id: 'asc' },
        select: { id: true, providerParcelId: true, trackingNumber: true },
      }),
    );

    await event('collected', {
      id: first!.id,
      parcelId: first!.providerParcelId!,
      reference: 'x',
      trackingNumber: first!.trackingNumber,
    });

    await expectCase('parcels_ahead_of_order', orderId, false);
  });
});

describe('shipped_orders_waiting', () => {
  it('counts an order sent by a carrier and not delivered once the days of the threshold are over', async () => {
    const { orderId, parcel } = await orderWithParcel();
    await event('collected', parcel);

    clock = moveClock(14 * DAY + 3_600_000);
    await expectCase('shipped_orders_waiting', orderId, true);
  });
});

describe('the filter parcels of the desk of the orders', () => {
  it('lists the paid orders of a carrier that have no parcel yet', async () => {
    setShopSettings(CARRIER_SHOP);
    const mug = await createProduct({ price: 10, stock: 5, ...SIZED });
    const { buyer, orderId } = await carrierOrder(app, csrf, [
      { variantId: mug.variantId, quantity: 1 },
    ]);
    userIds.push(buyer.id);
    const none = async () =>
      // the orders of its buyer: the digits of a number are looked for in the postal codes too
      (
        (await get(`/api/orders?parcels=none&userId=${buyer.id}`)).json().items as { id: number }[]
      ).map((row) => row.id);

    expect(await none()).toEqual([orderId]);
    await send('POST', `/api/orders/${orderId}/parcels`, {});
    expect(await none()).toEqual([]);
  });

  it('is not a filter of a buyer', async () => {
    const buyer = await createUser();
    userIds.push(buyer.id);

    const res = await get('/api/orders?parcels=lost', buyer);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      errorCode: 'FILTER_FORBIDDEN',
      details: { filter: 'parcels' },
    });
  });
});
