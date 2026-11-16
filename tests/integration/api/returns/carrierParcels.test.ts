import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { DELIVERY_WEBHOOK_PATH, deliveryProvider } from '@providers/delivery/index.js';

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
import { deliveryHarness } from '../../../helpers/providers.js';
import { refundReturn } from '../../../helpers/returns.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';

// a statement of the buyer for an order of a carrier whose parcels are made (decisions 16 and 22 of
// the delivery, scenarios 30 and 30a): the parcels the carrier has not taken that hold an item of the
// statement wait for their void, the others stay; the units still on the shelf come back at once.
// Once the carrier took a parcel the order is a sent one for the statements: the units on their way
// are expected back, and the order is cancelled when every unit and its money are back

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

// a paid order of a mug and a lamp by the carrier, its parcels made: the mug and the lamp apart, or
// both in one parcel of the draft
async function orderWithParcels(apart: boolean) {
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

  const made = await asStaff('POST', `/api/orders/${orderId}/parcels`, {
    ...(apart ? { parcels: [{ boxes: [box(mugItem!)] }, { boxes: [box(lampItem!)] }] } : {}),
  });
  expect(made.statusCode).toBe(200);
  const parcels = await parcelsOf(orderId);
  return { buyer, orderId, mug, lamp, mugItem: mugItem!, lampItem: lampItem!, parcels };
}

const asStaff = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  app.inject({
    method,
    url,
    headers:
      method === 'GET' ? { cookie: accessCookie(admin) } : withCsrf(csrf, accessCookie(admin)),
    ...(method === 'GET' ? {} : { payload: payload ?? {} }),
  });

const parcelsOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.orderShipment.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: { id: true, state: true, providerParcelId: true, trackingNumber: true },
    }),
  );

// the carrier took the parcel: the event of the provider
async function collected(parcel: {
  providerParcelId: string | null;
  trackingNumber: string | null;
}) {
  const res = await app.inject({
    method: 'POST',
    url: DELIVERY_WEBHOOK_PATH,
    headers: harness.webhookHeaders(),
    payload: JSON.stringify(
      harness.eventBody('collected', {
        parcelId: parcel.providerParcelId!,
        reference: 'x',
        trackingNumber: parcel.trackingNumber,
      }),
    ),
  });
  expect(res.statusCode).toBe(200);
}

const withdraw = (
  buyer: TestUser,
  orderId: number,
  items?: { orderItemId: number; quantity: number }[],
) =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/withdrawal`,
    headers: withCsrf(csrf, accessCookie(buyer)),
    payload: items ? { items } : {},
  });

// the rows of the statement: the item, its units, what became of the goods
const rowsOf = (returnId: number) =>
  asAdmin((tx) =>
    tx.orderReturnItem.findMany({
      where: { returnId },
      orderBy: [{ orderItemId: 'asc' }, { id: 'asc' }],
      select: { id: true, orderItemId: true, quantity: true, goods: true },
    }),
  );

const stockOf = async (variantId: number) =>
  (
    await asAdmin((tx) =>
      tx.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { stock: true } }),
    )
  ).stock;

const statusOf = async (orderId: number) =>
  (
    await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } }),
    )
  ).status;

describe('a statement of the buyer before the carrier took any parcel', () => {
  it('voids the parcel that holds its item, takes the item back at once; the draft holds the rest', async () => {
    const { buyer, orderId, lamp, lampItem, mugItem } = await orderWithParcels(false);
    const shelf = await stockOf(lamp.variantId);

    const res = await withdraw(buyer, orderId, [{ orderItemId: lampItem, quantity: 1 }]);

    expect(res.statusCode).toBe(201);
    expect((await parcelsOf(orderId)).map((one) => one.state)).toEqual(['void_pending']);
    expect(await stockOf(lamp.variantId)).toBe(shelf + 1);
    expect(await statusOf(orderId)).toBe('paid');

    const draft = await asStaff('GET', `/api/orders/${orderId}/parcels/draft`);
    expect(draft.json().parcels).toEqual([
      expect.objectContaining({
        boxes: [expect.objectContaining({ items: [{ orderItemId: mugItem, quantity: 1 }] })],
      }),
    ]);
    const again = await asStaff('POST', `/api/orders/${orderId}/parcels`);
    expect(again.statusCode).toBe(200);
    expect((await parcelsOf(orderId)).map((one) => one.state)).toEqual(['void_pending', 'created']);
  });

  it('leaves the parcels that hold none of its items', async () => {
    const { buyer, orderId, lampItem } = await orderWithParcels(true);

    await withdraw(buyer, orderId, [{ orderItemId: lampItem, quantity: 1 }]);

    expect((await parcelsOf(orderId)).map((one) => one.state)).toEqual(['created', 'void_pending']);
  });
});

describe('a statement of the buyer once the carrier took a parcel', () => {
  it('takes back at once what is on the shelf, voids its parcel, and waits for what is on its way', async () => {
    const { buyer, orderId, mug, lamp, mugItem, lampItem, parcels } = await orderWithParcels(true);
    await collected(parcels[0]!);
    const mugStock = await stockOf(mug.variantId);
    const lampStock = await stockOf(lamp.variantId);

    const res = await withdraw(buyer, orderId);

    expect(res.statusCode).toBe(201);
    const returnId = res.json().withdrawals[0].id as number;
    expect((await parcelsOf(orderId)).map((one) => one.state)).toEqual(['sent', 'void_pending']);
    expect((await rowsOf(returnId)).map((row) => [row.orderItemId, row.goods])).toEqual([
      [mugItem, 'expected'],
      [lampItem, 'to_stock'],
    ]);
    expect(await stockOf(lamp.variantId)).toBe(lampStock + 1);
    expect(await stockOf(mug.variantId)).toBe(mugStock);
    expect(await statusOf(orderId)).toBe('paid');
  });

  it('only waits for an item on its way, and leaves the parcel not taken', async () => {
    const { buyer, orderId, mugItem, parcels } = await orderWithParcels(true);
    await collected(parcels[0]!);

    const res = await withdraw(buyer, orderId, [{ orderItemId: mugItem, quantity: 1 }]);

    expect((await rowsOf(res.json().withdrawals[0].id)).map((row) => row.goods)).toEqual([
      'expected',
    ]);
    expect((await parcelsOf(orderId)).map((one) => one.state)).toEqual(['sent', 'created']);
  });

  it('cancels the order once every unit and its money are back', async () => {
    const { buyer, orderId, mugItem, parcels } = await orderWithParcels(true);
    await collected(parcels[0]!);
    const returnId = (await withdraw(buyer, orderId)).json().withdrawals[0].id as number;
    const mugRow = (await rowsOf(returnId)).find((row) => row.orderItemId === mugItem)!;

    const received = await asStaff('POST', `/api/returns/${returnId}/receive`, {
      parcel: { buyerPaid: 0 },
      results: [{ itemId: mugRow.id, quantity: 1, goods: 'to_stock' }],
    });
    expect(received.statusCode).toBe(200);
    expect(await statusOf(orderId)).toBe('paid');

    await refundReturn(admin.id, returnId);

    expect(await statusOf(orderId)).toBe('cancelled');
  });
});
