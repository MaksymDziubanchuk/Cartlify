import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { DELIVERY_WEBHOOK_PATH, deliveryProvider } from '@providers/delivery/index.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { CARRIER_SHOP, SIZED, carrierOrder } from '../../../helpers/carrierOrders.js';
import { cancelPaidOrder } from '../../../helpers/cancel.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { watchMail } from '../../../helpers/mail.js';
import { holdForReview, releaseReview } from '../../../helpers/orders.js';
import { deliveryHarness } from '../../../helpers/providers.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';

import type { DeliveryEventKind } from '@providers/delivery/index.js';

// The events of the parcels the delivery provider posts (decisions 9, 19, 22, 36 of the delivery):
// the secret of the webhook; a parcel moves on, never back, never after its void; the order follows
// its live parcels, shipped when the carrier took them all, delivered when all are delivered, the
// buyer mailed; an order something holds is not moved; a parcel of a cancelled order the carrier
// took anyway is sent

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

// a paid order of a carrier with its parcels made: two parcels when asked
async function orderWithParcels(two = false) {
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
    weightGrams: 400,
    lengthMm: 300,
    widthMm: 200,
    heightMm: 50,
    items: [{ orderItemId, quantity: 1 }],
  });
  const made = await app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/parcels`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload: two
      ? { parcels: [{ boxes: [box(items[0]!.id)] }, { boxes: [box(items[1]!.id)] }] }
      : {},
  });
  expect(made.statusCode).toBe(200);
  const parcels = await asAdmin((tx) =>
    tx.orderShipment.findMany({
      where: { orderId },
      orderBy: { id: 'asc' },
      select: { id: true, providerParcelId: true, trackingNumber: true },
    }),
  );
  return {
    buyer,
    orderId,
    parcels: parcels.map((one) => ({
      id: one.id,
      parcelId: one.providerParcelId!,
      reference: `${orderId}-x`,
      trackingNumber: one.trackingNumber,
    })),
  };
}

type Parcel = Awaited<ReturnType<typeof orderWithParcels>>['parcels'][number];

const asStaff = (method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method, url, headers: withCsrf(csrf, accessCookie(admin)), payload });

const post = (body: unknown, secret: 'own' | 'other' | 'none' = 'own') =>
  app.inject({
    method: 'POST',
    url: DELIVERY_WEBHOOK_PATH,
    headers: harness.webhookHeaders(secret),
    payload: JSON.stringify(body),
  });

const event = (kind: DeliveryEventKind | 'dropped', parcel: Parcel, at?: Date) =>
  post(harness.eventBody(kind, parcel, at));

const stateOf = async (parcelId: number) =>
  await asAdmin((tx) =>
    tx.orderShipment.findUniqueOrThrow({
      where: { id: parcelId },
      select: { state: true, shippedAt: true },
    }),
  );

const orderOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, deliveredAt: true },
    }),
  );

describe('POST the webhook of the delivery provider', () => {
  it('ships the order once the carrier took its parcel, and delivers it, mailing the buyer', async () => {
    const { buyer, orderId, parcels } = await orderWithParcels();
    const mails = watchMail();
    // the provider dates its events in whole seconds: the first whole second after the payment
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );
    const taken = new Date(Math.ceil(paidAt!.getTime() / 1000) * 1000);
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, taken.getTime() - Date.now())));
    const handed = taken;

    const res = await event('collected', parcels[0]!, taken);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(deliveryProvider.webhook.answer);
    expect(await stateOf(parcels[0]!.id)).toEqual({ state: 'sent', shippedAt: taken });
    expect((await orderOf(orderId)).status).toBe('shipped');

    await event('delivered', parcels[0]!, handed);

    expect(await orderOf(orderId)).toEqual({ status: 'delivered', deliveredAt: handed });
    const subjects = mails
      .filter((mail) => mail.to.includes(buyer.email))
      .map((mail) => mail.subject);
    expect(subjects).toEqual([
      expect.stringContaining('is shipped'),
      expect.stringContaining('is delivered'),
    ]);
  });

  it('waits for every parcel: shipped when both are taken, delivered when both are', async () => {
    const { orderId, parcels } = await orderWithParcels(true);

    await event('collected', parcels[0]!);
    expect((await orderOf(orderId)).status).toBe('paid');
    await event('collected', parcels[1]!);
    expect((await orderOf(orderId)).status).toBe('shipped');

    await event('delivered', parcels[1]!);
    expect((await orderOf(orderId)).status).toBe('shipped');
    await event('delivered', parcels[0]!);
    expect((await orderOf(orderId)).status).toBe('delivered');
  });

  it('takes a delivery that came without the pickup: both steps at once', async () => {
    const { orderId, parcels } = await orderWithParcels();

    await event('delivered', parcels[0]!);

    expect((await stateOf(parcels[0]!.id)).state).toBe('delivered');
    expect((await orderOf(orderId)).status).toBe('delivered');
  });

  it('takes a delivery whose moment is ahead of the clock of the database, at the moment of the database', async () => {
    const { orderId, parcels } = await orderWithParcels();

    // the clock of the carrier an hour ahead: both steps take the moment of now, never of the future
    const res = await event('delivered', parcels[0]!, new Date(Date.now() + 3_600_000));

    expect(res.statusCode).toBe(200);
    expect((await stateOf(parcels[0]!.id)).state).toBe('delivered');
    const order = await orderOf(orderId);
    expect(order.status).toBe('delivered');
    expect(order.deliveredAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('changes nothing for an event back, a repeat, an event it drops, or a parcel it does not know', async () => {
    const { orderId, parcels } = await orderWithParcels();
    await event('delivered', parcels[0]!);

    for (const res of [
      await event('collected', parcels[0]!),
      await event('delivered', parcels[0]!),
      await event('dropped', parcels[0]!),
      await event('created', parcels[0]!),
      await event('failed', parcels[0]!),
      await event('collected', { ...parcels[0]!, parcelId: '999999999999' }),
      await event('created', { ...parcels[0]!, parcelId: '999999999998' }),
    ]) {
      expect(res.statusCode).toBe(200);
    }
    expect((await stateOf(parcels[0]!.id)).state).toBe('delivered');
    expect((await orderOf(orderId)).status).toBe('delivered');
  });

  it('leaves a voided parcel alone, whatever comes for it', async () => {
    const { orderId, parcels } = await orderWithParcels();
    const voided = await asStaff('POST', `/api/orders/${orderId}/parcels/void`);
    expect(voided.json().shipments[0]).toMatchObject({ state: 'voided' });

    await event('collected', parcels[0]!);
    await event('delivered', parcels[0]!);

    expect(await stateOf(parcels[0]!.id)).toEqual({ state: 'voided', shippedAt: null });
    expect((await orderOf(orderId)).status).toBe('paid');
  });

  it('takes nothing late once the admin moved the order by hand, and mails nobody again', async () => {
    const { orderId, parcels } = await orderWithParcels();
    await asStaff('PATCH', `/api/orders/${orderId}/status`, { status: 'shipped' });
    const shipped = await stateOf(parcels[0]!.id);
    await asStaff('PATCH', `/api/orders/${orderId}/status`, { status: 'delivered' });
    const delivered = await orderOf(orderId);
    const mails = watchMail();

    await event('collected', parcels[0]!, new Date(Date.now() - 3 * 3600_000));
    await event('delivered', parcels[0]!, new Date(Date.now() - 2 * 3600_000));

    expect(await stateOf(parcels[0]!.id)).toEqual({ ...shipped, state: 'delivered' });
    expect(await orderOf(orderId)).toEqual(delivered);
    expect(mails).toHaveLength(0);
  });

  // the carrier delivered it before the admin sent it by hand: the order is delivered at the send,
  // never before it
  it('delivers at the send an order the admin sent by hand after the carrier had delivered it', async () => {
    const { orderId, parcels } = await orderWithParcels();
    await asStaff('PATCH', `/api/orders/${orderId}/status`, { status: 'shipped' });
    const { shippedAt } = await stateOf(parcels[0]!.id);

    const res = await event('delivered', parcels[0]!, new Date(Date.now() - 3 * 3600_000));

    expect(res.statusCode).toBe(200);
    expect(await orderOf(orderId)).toEqual({ status: 'delivered', deliveredAt: shippedAt });
  });

  it('makes the parcel of an order stepped back only made again, and moves both when the carrier delivers it', async () => {
    const { orderId, parcels } = await orderWithParcels();
    await asStaff('PATCH', `/api/orders/${orderId}/status`, { status: 'shipped' });

    // the label lives at the carrier: no choice about its cost, the parcel is not taken back
    const choice = await asStaff('PATCH', `/api/orders/${orderId}/status`, {
      status: 'paid',
      keepShippingCost: true,
    });
    expect(choice.statusCode).toBe(400);
    expect(choice.json()).toMatchObject({ errorCode: 'KEEP_SHIPPING_COST_NOT_ALLOWED' });
    const back = await asStaff('PATCH', `/api/orders/${orderId}/status`, { status: 'paid' });
    expect(back.statusCode).toBe(200);
    expect(await stateOf(parcels[0]!.id)).toEqual({ state: 'created', shippedAt: null });

    const res = await event('delivered', parcels[0]!);

    expect(res.statusCode).toBe(200);
    expect((await stateOf(parcels[0]!.id)).state).toBe('delivered');
    expect((await orderOf(orderId)).status).toBe('delivered');
  });

  it('does not step back an order the carrier delivered a parcel of (409 PARCEL_STATE_INVALID)', async () => {
    const { orderId, parcels } = await orderWithParcels(true);
    await event('collected', parcels[0]!);
    await event('collected', parcels[1]!);
    await event('delivered', parcels[0]!);

    const back = await asStaff('PATCH', `/api/orders/${orderId}/status`, { status: 'paid' });

    expect(back.statusCode).toBe(409);
    expect(back.json()).toMatchObject({
      errorCode: 'PARCEL_STATE_INVALID',
      details: { shipmentId: parcels[0]!.id, state: 'delivered' },
    });
  });

  it('takes a moment before the payment as the payment: a date of the provider that is none', async () => {
    const { orderId, parcels } = await orderWithParcels();
    const { paidAt } = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paidAt: true } }),
    );

    const res = await event('collected', parcels[0]!, new Date(0));

    expect(res.statusCode).toBe(200);
    expect(await stateOf(parcels[0]!.id)).toEqual({ state: 'sent', shippedAt: paidAt });
  });

  it('lets the admin send by hand an order the carrier took one parcel of: that parcel keeps its moment', async () => {
    const { orderId, parcels } = await orderWithParcels(true);
    await event('collected', parcels[0]!);
    const taken = await stateOf(parcels[0]!.id);
    expect((await orderOf(orderId)).status).toBe('paid');

    const res = await asStaff('PATCH', `/api/orders/${orderId}/status`, { status: 'shipped' });

    expect(res.statusCode).toBe(200);
    expect(await stateOf(parcels[0]!.id)).toEqual(taken);
    expect((await stateOf(parcels[1]!.id)).state).toBe('sent');
  });

  it('lets the admin move by hand an order whose parcels the carrier took and delivered while something held it', async () => {
    const { orderId, parcels } = await orderWithParcels();
    const reviewId = await holdForReview(orderId);
    await event('delivered', parcels[0]!);
    expect((await orderOf(orderId)).status).toBe('paid');
    await releaseReview(orderId, reviewId);

    const shipped = await asStaff('PATCH', `/api/orders/${orderId}/status`, { status: 'shipped' });
    expect(shipped.statusCode).toBe(200);
    const delivered = await asStaff('PATCH', `/api/orders/${orderId}/status`, {
      status: 'delivered',
    });
    expect(delivered.statusCode).toBe(200);
    expect((await stateOf(parcels[0]!.id)).state).toBe('delivered');
  });

  it('takes a moment of the future the carrier gives as now', async () => {
    const { parcels } = await orderWithParcels();

    await event('collected', parcels[0]!, new Date(Date.now() + 24 * 3600_000));

    const { shippedAt } = await stateOf(parcels[0]!.id);
    expect(shippedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('moves the parcel of an order something holds, never the order', async () => {
    const { orderId, parcels } = await orderWithParcels();
    await holdForReview(orderId);

    await event('collected', parcels[0]!);

    expect((await stateOf(parcels[0]!.id)).state).toBe('sent');
    expect((await orderOf(orderId)).status).toBe('paid');
  });

  it('sends a parcel of a cancelled order the carrier took anyway, the order stays cancelled', async () => {
    const { orderId, parcels } = await orderWithParcels();
    await cancelPaidOrder(admin.id, orderId);
    expect((await stateOf(parcels[0]!.id)).state).toBe('void_pending');

    await event('collected', parcels[0]!);

    expect((await stateOf(parcels[0]!.id)).state).toBe('sent');
    expect((await orderOf(orderId)).status).toBe('cancelled');
  });

  it.each([
    ['without a secret', 'none' as const, 401, 'DELIVERY_WEBHOOK_SECRET_MISSING'],
    ['with another secret', 'other' as const, 403, 'DELIVERY_WEBHOOK_SECRET_INVALID'],
  ])('refuses a request %s and takes nothing', async (_case, secret, status, errorCode) => {
    const { orderId, parcels } = await orderWithParcels();

    const res = await post(harness.eventBody('collected', parcels[0]!), secret);

    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ errorCode });
    expect((await orderOf(orderId)).status).toBe('paid');
    if (secret === 'other') {
      expect(takeLogs({ msg: 'delivery webhook with another secret' })).toHaveLength(1);
    }
  });

  it('is unavailable while the server has no secret to check with', async () => {
    const { parcels } = await orderWithParcels();

    const res = await harness.withoutWebhookSecret(() =>
      post(harness.eventBody('collected', parcels[0]!)),
    );

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_WEBHOOK_UNAVAILABLE' });
    expect(takeLogs({ msg: 'delivery webhook cannot be checked' })).toHaveLength(1);
    expect(takeLogs({ errorCode: 'DELIVERY_WEBHOOK_UNAVAILABLE' })).toHaveLength(1);
  });

  it('leaves a body that is no event alone, answered as taken, and takes the fields it does not know', async () => {
    const { orderId, parcels } = await orderWithParcels();

    // any other answer and the provider posts the body again, every half an hour
    const none = await post({ hello: 'world' });
    expect(none.statusCode).toBe(200);
    expect((await orderOf(orderId)).status).toBe('paid');

    const extra = await post({
      ...(harness.eventBody('collected', parcels[0]!) as Record<string, unknown>),
      SomethingNew: { nested: true },
    });
    expect(extra.statusCode).toBe(200);
    expect((await orderOf(orderId)).status).toBe('shipped');
  });
});
