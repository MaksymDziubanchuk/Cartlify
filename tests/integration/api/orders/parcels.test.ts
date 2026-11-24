import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { deliveryProvider } from '@providers/delivery/index.js';

import { deliveryHarness } from '../../../helpers/providers.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cancelPaidOrder } from '../../../helpers/cancel.js';
import {
  CARRIER_SHOP,
  CARRIERS,
  MADRID,
  SENDER,
  SIZED,
  carrierOrder,
} from '../../../helpers/carrierOrders.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { holdForReview, placeOrder, shippingCostOf } from '../../../helpers/orders.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';
import { resetShopCountries, withCustoms } from '../../../helpers/shopCountries.js';
import {
  MOCK_CARRIERS,
  breakShippyPro,
  mockParcel,
  refuseNextParcel,
  useCarriers,
  watchShippyPro,
} from '../../../helpers/shippyPro.js';

// The parcels of an order of a carrier of the delivery provider (decisions 4, 22, 37, 38, 10 of the
// delivery): the draft of one parcel and one box, the parcels an admin makes when the goods are packed
// (the label, the number of the carrier, the price of the provider as the cost of the send), what
// refuses them, a repeat that finds a parcel made before an answer got lost, another carrier when the
// one picked is gone, the parcels of many orders, the void to make them again, and the order of a
// carrier sent and delivered by hand

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

afterEach(() => {
  jest.restoreAllMocks();
  resetShopSettings();
  resetShopCountries();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const asStaff = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(admin)),
    // a post with nothing to say sends an empty body
    ...(payload !== undefined
      ? { payload: payload as Record<string, unknown> }
      : method === 'POST'
        ? { payload: {} }
        : {}),
  });

// a paid order of a carrier: two mugs and a lamp, 1.2 kg in one box
async function paidOrder(
  carrier: keyof typeof CARRIERS = 'MockExpress',
  address: typeof MADRID = MADRID,
) {
  setShopSettings(CARRIER_SHOP);
  const mug = await createProduct({ price: 10, stock: 5, ...SIZED });
  const lamp = await createProduct({ price: 30, stock: 5, ...SIZED });
  const { buyer, orderId } = await carrierOrder(
    app,
    csrf,
    [
      { variantId: mug.variantId, quantity: 2 },
      { variantId: lamp.variantId, quantity: 1 },
    ],
    { carrier, address },
  );
  userIds.push(buyer.id);
  const items = await asAdmin((tx) =>
    tx.orderItem.findMany({ where: { orderId }, orderBy: { id: 'asc' }, select: { id: true } }),
  );
  return { buyer, orderId, mugItem: items[0]!.id, lampItem: items[1]!.id };
}

const parcelsOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.orderShipment.findMany({
      where: { orderId, returnId: null },
      orderBy: { id: 'asc' },
      select: { id: true, state: true, providerParcelId: true, expense: true },
    }),
  );

const statusOf = async (orderId: number) =>
  (
    await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } }),
    )
  ).status;

const box = (items: { orderItemId: number; quantity: number }[]) => ({
  weightGrams: 700,
  lengthMm: 300,
  widthMm: 200,
  heightMm: 100,
  items,
});

describe('GET /api/orders/:orderId/parcels/draft', () => {
  it('gives one parcel of one box of every unit with its weight and sizes, and the carrier', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();

    const res = await asStaff('GET', `/api/orders/${orderId}/parcels/draft`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      carrier: CARRIERS.MockExpress,
      parcels: [
        {
          boxes: [
            {
              weightGrams: 1200,
              lengthMm: 300,
              widthMm: 200,
              heightMm: 150,
              items: [
                { orderItemId: mugItem, quantity: 2 },
                { orderItemId: lampItem, quantity: 1 },
              ],
            },
          ],
        },
      ],
    });
  });
});

describe('GET /api/orders/:orderId/carriers', () => {
  it('lists the carriers of the provider for the order now, the cheapest first, with their cost', async () => {
    const { orderId } = await paidOrder('MockExpress', { ...MADRID, house: '31' });

    const res = await asStaff('GET', `/api/orders/${orderId}/carriers`);

    expect(res.statusCode).toBe(200);
    expect(res.json().carriers).toEqual([
      { carrier: CARRIERS.Generic, label: expect.any(String), days: expect.any(String), price: 4 },
      {
        carrier: CARRIERS.MockExpress,
        label: expect.any(String),
        days: expect.any(String),
        price: 6.5,
      },
    ]);
  });

  it('is of the staff, of an order there is, and of an order of a carrier', async () => {
    const { buyer, orderId } = await paidOrder();
    const manual = await placeOrder(app, csrf, buyer, await createProduct({ price: 10 }), 'paid');

    const byBuyer = await app.inject({
      method: 'GET',
      url: `/api/orders/${orderId}/carriers`,
      headers: withCsrf(csrf, accessCookie(buyer)),
    });
    expect(byBuyer.statusCode).toBe(403);
    expect((await asStaff('GET', '/api/orders/2000000000/carriers')).statusCode).toBe(404);
    const notCarrier = await asStaff('GET', `/api/orders/${manual}/carriers`);
    expect(notCarrier.statusCode).toBe(409);
    expect(notCarrier.json()).toMatchObject({ errorCode: 'ORDER_NOT_BY_CARRIER' });
  });

  it('is unavailable while the provider does not answer', async () => {
    const { orderId } = await paidOrder();
    breakShippyPro('unreachable');

    const res = await asStaff('GET', `/api/orders/${orderId}/carriers`);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_PROVIDER_UNAVAILABLE' });
    takeLogs({ errorCode: 'DELIVERY_PROVIDER_UNAVAILABLE' });
  });
});

describe('POST /api/orders/:orderId/parcels', () => {
  it('refuses an order of another method (409 ORDER_NOT_BY_CARRIER), whose carrier is not changed either (400 DELIVERY_CARRIER_NOT_ALLOWED)', async () => {
    const buyer = await createUser();
    userIds.push(buyer.id);
    const manual = await placeOrder(app, csrf, buyer, await createProduct({ price: 10 }), 'paid');
    setShopSettings(CARRIER_SHOP);
    const calls = watchShippyPro();

    const res = await asStaff('POST', `/api/orders/${manual}/parcels`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_NOT_BY_CARRIER' });
    const carrier = await asStaff('PATCH', `/api/orders/${manual}/delivery`, {
      carrier: CARRIERS.MockExpress,
    });
    expect(carrier.statusCode).toBe(400);
    expect(carrier.json()).toMatchObject({ errorCode: 'DELIVERY_CARRIER_NOT_ALLOWED' });
    expect(calls).toEqual([]);
  });

  it('refuses while the server has no key of the provider (409 DELIVERY_PROVIDER_NOT_CONFIGURED)', async () => {
    const { orderId } = await paidOrder();
    const harness = deliveryHarness[deliveryProvider.name];

    const res = await harness.withoutKey(() => asStaff('POST', `/api/orders/${orderId}/parcels`));

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_PROVIDER_NOT_CONFIGURED' });
    expect(await parcelsOf(orderId)).toEqual([]);
  });

  it('keeps an order of a carrier from being sent by hand before its parcels are made (409 PARCELS_REQUIRED)', async () => {
    const { orderId } = await paidOrder();

    const res = await asStaff('PATCH', `/api/orders/${orderId}/status`, { status: 'shipped' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PARCELS_REQUIRED' });
    expect(await statusOf(orderId)).toBe('paid');
  });

  it('makes the parcel of the draft: its label, its numbers, its cost; the order stays paid', async () => {
    const { orderId } = await paidOrder();
    const calls = watchShippyPro();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ made: [expect.any(Number)], failed: null });
    const [parcel] = res.json().order.shipments;
    expect(parcel).toMatchObject({
      state: 'created',
      carrier: 'MockExpress',
      trackingNumber: expect.stringMatching(/^MX\d+$/),
      trackingUrl: expect.stringMatching(/^https:\/\//),
      labelUrl: expect.stringMatching(/^https:\/\//),
      shippedAt: null,
    });
    expect(parcel.boxes).toHaveLength(1);
    expect(parcel.boxes[0].trackingNumber).toMatch(/^MX\d+-1$/);
    // what the provider priced it at: MockExpress, 1.2 kg
    expect(await shippingCostOf(parcel.id)).toBe(6.5);
    expect(await statusOf(orderId)).toBe('paid');

    // the provider was asked with the address of the shop and the buyer, by our number
    const ship = calls.find((call) => call.method === 'Ship')!;
    expect(ship.params).toMatchObject({
      TransactionID: `${orderId}-1`,
      CarrierName: 'MockExpress',
      CarrierID: 7001,
      from_address: { city: SENDER.city, phone: '34960000000' },
      to_address: { city: MADRID.city, name: 'Ana Garcia', phone: '34910000000' },
    });

    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.findMany({
        where: { entityType: 'order', entityId: orderId, event: 'order.parcel_create' },
        select: { actorId: true },
      }),
    );
    expect(lines).toEqual([{ actorId: admin.id }]);
  });

  it('makes two parcels the admin laid out, each with its boxes', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`, {
      parcels: [
        { boxes: [box([{ orderItemId: mugItem, quantity: 2 }])] },
        { boxes: [box([{ orderItemId: lampItem, quantity: 1 }])] },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().made).toHaveLength(2);
    expect((await parcelsOf(orderId)).map((one) => one.state)).toEqual(['created', 'created']);
  });

  it('refuses boxes that do not hold every unit, and makes nothing', async () => {
    const { orderId, mugItem } = await paidOrder();
    const calls = watchShippyPro();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`, {
      parcels: [{ boxes: [box([{ orderItemId: mugItem, quantity: 2 }])] }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PARCEL_ITEMS_MISMATCH' });
    expect(calls).toEqual([]);
  });

  it('refuses a box without its weight and sizes: a carrier needs them', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`, {
      parcels: [
        {
          boxes: [
            {
              items: [
                { orderItemId: mugItem, quantity: 2 },
                { orderItemId: lampItem, quantity: 1 },
              ],
            },
          ],
        },
      ],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PARCEL_BOX_SIZES_REQUIRED' });
  });

  it('tells the reason of a carrier that refuses, makes nothing, and makes it after the fix', async () => {
    const { orderId } = await paidOrder();
    refuseNextParcel('No street found');

    const refused = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      errorCode: 'DELIVERY_PARCEL_REFUSED',
      details: { message: 'No street found' },
    });
    expect(await parcelsOf(orderId)).toEqual([]);
    expect(await statusOf(orderId)).toBe('paid');

    // the admin corrects the address and makes it again
    const fixed = await asStaff('PATCH', `/api/orders/${orderId}/delivery`, {
      address: { ...MADRID, street: 'Calle de Alcala' },
    });
    expect(fixed.statusCode).toBe(200);
    const again = await asStaff('POST', `/api/orders/${orderId}/parcels`);
    expect(again.statusCode).toBe(200);
  });

  it('takes a parcel the provider made before its answer got lost, and makes no second one', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();
    // the provider made the parcel of the first try; its answer never came back
    await deliveryProvider.createParcel(
      {
        reference: `${orderId}-1`,
        option: {
          carrierName: 'MockExpress',
          carrierService: 'Express',
          connection: '7001',
        },
        from: { ...SENDER, email: SENDER.email },
        to: { ...MADRID, name: 'Ana Garcia', apartment: null, phone: '+34910000000', email: null },
        boxes: [{ weightGrams: 1200, lengthMm: 300, widthMm: 200, heightMm: 150 }],
        contents: 'Goods',
        declaredValue: 50,
        customs: null,
        taxNumber: null,
      },
      { warn: () => undefined },
    );
    const calls = watchShippyPro();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`, {
      parcels: [
        {
          boxes: [
            {
              ...box([
                { orderItemId: mugItem, quantity: 2 },
                { orderItemId: lampItem, quantity: 1 },
              ]),
              weightGrams: 1200,
            },
          ],
        },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(calls.filter((call) => call.method === 'Ship')).toEqual([]);
    expect((await parcelsOf(orderId)).length).toBe(1);
  });

  it('gives up a parcel the provider made before for another layout, and makes the one asked for', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();
    // the parcel of a first try, 1.2 kg in one box; its answer never came back
    const old = await deliveryProvider.createParcel(
      {
        reference: `${orderId}-1`,
        option: {
          carrierName: 'MockExpress',
          carrierService: 'Express',
          connection: '7001',
        },
        from: { ...SENDER, email: SENDER.email },
        to: { ...MADRID, name: 'Ana Garcia', apartment: null, phone: '+34910000000', email: null },
        boxes: [{ weightGrams: 1200, lengthMm: 300, widthMm: 200, heightMm: 150 }],
        contents: 'Goods',
        declaredValue: 50,
        customs: null,
        taxNumber: null,
      },
      { warn: () => undefined },
    );
    const calls = watchShippyPro();

    // the admin lays the order out again: two parcels, the label of the old one is of neither
    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`, {
      parcels: [
        { boxes: [box([{ orderItemId: mugItem, quantity: 2 }])] },
        { boxes: [box([{ orderItemId: lampItem, quantity: 1 }])] },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect(calls.filter((call) => call.method === 'Ship')).toHaveLength(2);
    expect(mockParcel(old.parcelId)?.voided).toBe(true);
    const kept = await parcelsOf(orderId);
    expect(kept).toHaveLength(2);
    expect(kept.map((one) => one.providerParcelId)).not.toContain(old.parcelId);
    expect(takeLogs({ msg: 'a parcel not kept was voided at the provider' })).toHaveLength(1);
  });

  it('is unavailable while the provider does not answer, and makes nothing', async () => {
    const { orderId } = await paidOrder();
    breakShippyPro('unreachable');

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_PROVIDER_UNAVAILABLE' });
    expect(takeLogs({ errorCode: 'DELIVERY_PROVIDER_UNAVAILABLE' })).toHaveLength(1);
    expect(await parcelsOf(orderId)).toEqual([]);
  });

  it('keeps the first of two parcels when the second is refused, and makes the rest after', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();
    refuseNextParcel(null, 'Weight over the limit');
    const parcels = {
      parcels: [
        { boxes: [box([{ orderItemId: mugItem, quantity: 2 }])] },
        { boxes: [box([{ orderItemId: lampItem, quantity: 1 }])] },
      ],
    };

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`, parcels);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      made: [expect.any(Number)],
      failed: { parcel: 2, errorCode: 'DELIVERY_PARCEL_REFUSED', message: 'Weight over the limit' },
    });
    expect(takeLogs({ msg: 'a parcel of the order was not made' })).toHaveLength(1);

    // the rest: the lamp, which no live parcel holds
    const draft = await asStaff('GET', `/api/orders/${orderId}/parcels/draft`);
    expect(draft.json().parcels[0].boxes[0].items).toEqual([
      { orderItemId: lampItem, quantity: 1 },
    ]);
    const rest = await asStaff('POST', `/api/orders/${orderId}/parcels`);
    expect(rest.json()).toMatchObject({ made: [expect.any(Number)], failed: null });
    expect((await parcelsOf(orderId)).map((one) => one.providerParcelId)).toHaveLength(2);
  });

  // the buyer withdrew while the provider made the parcel: the order is cancelled, the parcel is not
  // kept and its label is voided at the provider
  it('voids at the provider a parcel made for an order cancelled meanwhile, and keeps nothing', async () => {
    const { orderId } = await paidOrder('MockExpress');
    const make = deliveryProvider.createParcel;
    let madeId = '';
    jest.spyOn(deliveryProvider, 'createParcel').mockImplementationOnce(async (request, log) => {
      const made = await make(request, log);
      madeId = made.parcelId;
      await cancelPaidOrder(admin.id, orderId);
      return made;
    });

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_STATUS_NOT_ALLOWED',
      details: { status: 'cancelled' },
    });
    expect(await parcelsOf(orderId)).toEqual([]);
    expect(mockParcel(madeId)?.voided).toBe(true);
    expect(takeLogs({ msg: 'a parcel not kept was voided at the provider' })).toHaveLength(1);
  });

  // the buyer withdrew from a mug while the provider made the parcel: its unit is back, and the
  // parcel that still holds it is not kept
  it('keeps no parcel that holds a unit a statement took back meanwhile, and voids it at the provider', async () => {
    const { buyer, orderId, mugItem } = await paidOrder('MockExpress');
    const make = deliveryProvider.createParcel;
    let madeId = '';
    jest.spyOn(deliveryProvider, 'createParcel').mockImplementationOnce(async (request, log) => {
      const made = await make(request, log);
      madeId = made.parcelId;
      const withdrawn = await app.inject({
        method: 'POST',
        url: `/api/orders/${orderId}/withdrawal`,
        headers: withCsrf(csrf, accessCookie(buyer)),
        payload: { items: [{ orderItemId: mugItem, quantity: 1 }] },
      });
      expect(withdrawn.statusCode).toBe(201);
      return made;
    });

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'PARCEL_ITEMS_MISMATCH',
      details: { items: [{ orderItemId: mugItem, units: 1, packed: 2 }] },
    });
    expect(await parcelsOf(orderId)).toEqual([]);
    expect(mockParcel(madeId)?.voided).toBe(true);
    expect(takeLogs({ msg: 'a parcel not kept was voided at the provider' })).toHaveLength(1);

    // again: the parcel of what is left
    const again = await asStaff('POST', `/api/orders/${orderId}/parcels`);
    expect(again.statusCode).toBe(200);
    expect(again.json().made).toHaveLength(1);
  });

  it('asks for a parcel to a country with customs with a line of the declaration for each item', async () => {
    setShopSettings(CARRIER_SHOP);
    const shirt = await createProduct({
      name: 'Cotton shirt',
      price: 25,
      stock: 5,
      ...SIZED,
      hsCode: '610510',
      originCountry: 'PT',
    });
    const { buyer, orderId } = await carrierOrder(
      app,
      csrf,
      [{ variantId: shirt.variantId, quantity: 2 }],
      { carrier: 'MockExpress' },
    );
    userIds.push(buyer.id);
    // the records of the countries changed after the order was paid: Spain has customs now
    setShopSettings(CARRIER_SHOP);
    withCustoms('ES', 'PL', 'DE', 'GB');
    const calls = watchShippyPro();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(200);
    const ship = calls.find((call) => call.method === 'Ship');
    // the weight of one unit, the price the buyer paid for it
    expect(ship?.params.CN22Info).toMatchObject([
      {
        Description: expect.stringContaining('Cotton shirt'),
        Weight: 0.4,
        Quantity: 2,
        UnitValue: 25,
        OriginCountry: 'PT',
        HSCode: '610510',
      },
    ]);
  });

  it('refuses a parcel to a country with customs while a product has no customs data, naming it', async () => {
    const { orderId } = await paidOrder('MockExpress');
    // the records of the countries changed after the order was paid
    setShopSettings(CARRIER_SHOP);
    withCustoms('ES', 'PL', 'DE', 'GB');

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_CUSTOMS_DATA_MISSING' });
    expect(res.json().details.products).toHaveLength(2);
    expect(await parcelsOf(orderId)).toEqual([]);
  });

  it('makes the parcel of the units left once the carrier took another parcel of the order', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();
    const first = await asStaff('POST', `/api/orders/${orderId}/parcels`, {
      parcels: [
        { boxes: [box([{ orderItemId: mugItem, quantity: 2 }])] },
        { boxes: [box([{ orderItemId: lampItem, quantity: 1 }])] },
      ],
    });
    expect(first.statusCode).toBe(200);
    // the second is voided to be made again, and the carrier takes the first meanwhile
    const [taken, wrong] = await parcelsOf(orderId);
    await asAdmin(
      (tx) =>
        tx.$executeRaw`update cartlify.order_shipments set state = 'void_pending' where id = ${wrong!.id}`,
    );
    await asAdmin(
      (tx) =>
        tx.$executeRaw`update cartlify.order_shipments set state = 'sent', "shippedAt" = (now() at time zone 'UTC') where id = ${taken!.id}`,
    );

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(200);
    expect(res.json().made).toHaveLength(1);
    expect(await statusOf(orderId)).toBe('paid');
    // the lamp only: the mugs are with the carrier
    const [, , rest] = await parcelsOf(orderId);
    const boxes = await asAdmin((tx) =>
      tx.shipmentBox.findMany({ where: { shipmentId: rest!.id }, select: { items: true } }),
    );
    expect(boxes).toEqual([{ items: [{ orderItemId: lampItem, quantity: 1 }] }]);
  });

  it('voids the one parcel named and leaves the other made', async () => {
    const { orderId, mugItem, lampItem } = await paidOrder();
    await asStaff('POST', `/api/orders/${orderId}/parcels`, {
      parcels: [
        { boxes: [box([{ orderItemId: mugItem, quantity: 2 }])] },
        { boxes: [box([{ orderItemId: lampItem, quantity: 1 }])] },
      ],
    });
    const [kept, wrong] = await parcelsOf(orderId);

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels/void`, {
      shipmentId: wrong!.id,
    });

    expect(res.statusCode).toBe(200);
    expect((await parcelsOf(orderId)).map((one) => [one.id, one.state])).toEqual([
      [kept!.id, 'created'],
      [wrong!.id, 'voided'],
    ]);
    const other = await asStaff('POST', `/api/orders/${orderId}/parcels/void`, {
      shipmentId: wrong!.id,
    });
    expect(other.statusCode).toBe(409);
    expect(other.json()).toMatchObject({ errorCode: 'PARCELS_NOT_VOIDABLE' });
  });

  it('refuses a carrier no longer connected; the admin picks another and makes it', async () => {
    // an address of its own: the prices without MockExpress are kept for it five minutes
    const { orderId } = await paidOrder('MockExpress', { ...MADRID, house: '17' });
    useCarriers(MOCK_CARRIERS.filter((one) => one.name !== 'MockExpress'));

    const refused = await asStaff('POST', `/api/orders/${orderId}/parcels`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ errorCode: 'DELIVERY_PARCEL_REFUSED' });

    const gone = await asStaff('PATCH', `/api/orders/${orderId}/delivery`, {
      carrier: CARRIERS.MockExpress,
    });
    expect(gone.statusCode).toBe(409);
    expect(gone.json()).toMatchObject({ errorCode: 'DELIVERY_SERVICE_UNAVAILABLE' });

    const picked = await asStaff('PATCH', `/api/orders/${orderId}/delivery`, {
      carrier: CARRIERS.Generic,
    });
    expect(picked.statusCode).toBe(200);
    // the price of the buyer stays what was paid
    expect(picked.json().delivery).toMatchObject({ method: 'carrier', price: 6.5 });

    const made = await asStaff('POST', `/api/orders/${orderId}/parcels`);
    expect(made.statusCode).toBe(200);
    expect(made.json().order.shipments[0]).toMatchObject({ carrier: 'Generic' });
  });

  it.each([
    ['an order something holds', 'held', 'ORDER_ON_HOLD'],
    ['an order not paid', 'waiting', 'ORDER_STATUS_NOT_ALLOWED'],
    ['an order sent by hand', 'manual', 'ORDER_NOT_BY_CARRIER'],
    ['an order whose parcels are made', 'made', 'PARCELS_ALREADY_MADE'],
  ])('refuses %s', async (_case, kind, errorCode) => {
    let orderId: number;
    if (kind === 'manual') {
      const buyer = await createUser();
      userIds.push(buyer.id);
      orderId = await placeOrder(app, csrf, buyer, await createProduct({ price: 10 }), 'paid');
    } else if (kind === 'waiting') {
      setShopSettings(CARRIER_SHOP);
      const mug = await createProduct({ price: 10, stock: 5, ...SIZED });
      orderId = (
        await carrierOrder(app, csrf, [{ variantId: mug.variantId, quantity: 1 }], {
          stage: 'waiting',
        })
      ).orderId;
    } else {
      orderId = (await paidOrder()).orderId;
      if (kind === 'held') await holdForReview(orderId);
      if (kind === 'made') await asStaff('POST', `/api/orders/${orderId}/parcels`);
    }

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode });
  });
});

describe('POST /api/orders/parcels', () => {
  it('takes 20 orders at most in one request (400 VALIDATION_ERROR)', async () => {
    const calls = watchShippyPro();

    const res = await asStaff('POST', '/api/orders/parcels', {
      orderIds: Array.from({ length: 21 }, (_, i) => i + 1),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(calls).toEqual([]);
  });

  it('makes the parcels of each order by its draft, and answers each on its own', async () => {
    const first = await paidOrder();
    const second = await paidOrder();
    const buyer = await createUser();
    userIds.push(buyer.id);
    const manual = await placeOrder(app, csrf, buyer, await createProduct({ price: 10 }), 'paid');
    setShopSettings(CARRIER_SHOP);

    const res = await asStaff('POST', '/api/orders/parcels', {
      orderIds: [first.orderId, manual, second.orderId],
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().results).toEqual([
      { orderId: first.orderId, ok: true, made: [expect.any(Number)] },
      { orderId: manual, ok: false, made: [], errorCode: 'ORDER_NOT_BY_CARRIER', message: null },
      { orderId: second.orderId, ok: true, made: [expect.any(Number)] },
    ]);
    const lines = await asAdmin((tx) =>
      tx.adminAuditLog.count({
        where: {
          entityId: { in: [first.orderId, second.orderId] },
          event: 'order.parcel_create_bulk',
        },
      }),
    );
    expect(lines).toBe(2);
  });
});

describe('the void of the parcels to make them again', () => {
  it('voids at once the parcel of a carrier that voids, its cost taken back', async () => {
    const { orderId } = await paidOrder('MockExpress');
    const made = (await asStaff('POST', `/api/orders/${orderId}/parcels`)).json();
    const [parcel] = made.order.shipments;

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels/void`);

    expect(res.statusCode).toBe(200);
    expect(res.json().shipments[0]).toMatchObject({
      id: parcel.id,
      state: 'voided',
      expense: true,
    });
    expect(await shippingCostOf(parcel.id)).toBe(0);
    // voided at the provider too
    expect(mockParcel((await parcelsOf(orderId))[0]!.providerParcelId!)?.voided).toBe(true);

    // made again, with a number of its own
    const again = await asStaff('POST', `/api/orders/${orderId}/parcels`);
    expect(again.statusCode).toBe(200);
    expect((await parcelsOf(orderId)).map((one) => one.state)).toEqual(['voided', 'created']);
  });

  it('leaves the parcel of a carrier that does not void waiting, until the admin confirms', async () => {
    const { orderId } = await paidOrder('Generic');
    await asStaff('POST', `/api/orders/${orderId}/parcels`);
    const [parcel] = await parcelsOf(orderId);

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels/void`);

    expect(res.json().shipments[0]).toMatchObject({ state: 'void_pending' });

    const confirmed = await asStaff(
      'POST',
      `/api/orders/${orderId}/shipments/${parcel!.id}/void-confirmation`,
    );
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().shipments[0]).toMatchObject({ state: 'voided', expense: true });
    // the shop owes the carrier nothing for it: its cost is not written again
    const cost = await asStaff('PATCH', `/api/orders/${orderId}/shipments/${parcel!.id}`, {
      cost: 3,
    });
    expect(cost.statusCode).toBe(409);
    expect(cost.json()).toMatchObject({ errorCode: 'SHIPMENT_COST_NOT_OWED' });

    const twice = await asStaff(
      'POST',
      `/api/orders/${orderId}/shipments/${parcel!.id}/void-confirmation`,
    );
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({
      errorCode: 'PARCEL_STATE_INVALID',
      details: { state: 'voided' },
    });
  });

  it('confirms a void once when two admins confirm it at the same time', async () => {
    const { orderId } = await paidOrder('Generic');
    await asStaff('POST', `/api/orders/${orderId}/parcels`);
    const [parcel] = await parcelsOf(orderId);
    await asStaff('POST', `/api/orders/${orderId}/parcels/void`);
    const url = `/api/orders/${orderId}/shipments/${parcel!.id}/void-confirmation`;

    const answers = await Promise.all([asStaff('POST', url), asStaff('POST', url)]);

    expect(answers.map((one) => one.statusCode).sort()).toEqual([200, 409]);
    expect(answers.find((one) => one.statusCode === 409)!.json()).toMatchObject({
      errorCode: 'PARCEL_STATE_INVALID',
    });
    expect(await shippingCostOf(parcel!.id)).toBe(0);
  });

  it('refuses an order with no parcel only made', async () => {
    const { orderId } = await paidOrder();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels/void`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PARCELS_NOT_VOIDABLE' });
  });
});

describe('an order of a carrier sent by hand', () => {
  it('is not sent without its parcels; with them, they count as taken and then delivered', async () => {
    const { orderId } = await paidOrder();

    const without = await asStaff('PATCH', `/api/orders/${orderId}/status`, { status: 'shipped' });
    expect(without.statusCode).toBe(409);
    expect(without.json()).toMatchObject({ errorCode: 'PARCELS_REQUIRED' });

    await asStaff('POST', `/api/orders/${orderId}/parcels`);
    const shipped = await asStaff('PATCH', `/api/orders/${orderId}/status`, { status: 'shipped' });
    expect(shipped.statusCode).toBe(200);
    expect(shipped.json().shipments[0]).toMatchObject({
      state: 'sent',
      shippedAt: expect.any(String),
    });

    const delivered = await asStaff('PATCH', `/api/orders/${orderId}/status`, {
      status: 'delivered',
    });
    expect(delivered.statusCode).toBe(200);
    expect(delivered.json().shipments[0]).toMatchObject({ state: 'delivered' });
  });

  it('refuses parcels of its own: they are made by the provider', async () => {
    const { orderId } = await paidOrder();

    const res = await asStaff('PATCH', `/api/orders/${orderId}/status`, {
      status: 'shipped',
      shipments: [{ carrier: 'DHL' }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SHIPMENT_NOT_ALLOWED' });
  });

  it('goes by hand outside the provider once the method is manual, at the price paid', async () => {
    const { orderId } = await paidOrder();

    const manual = await asStaff('PATCH', `/api/orders/${orderId}/delivery`, { method: 'manual' });
    expect(manual.statusCode).toBe(200);
    expect(manual.json().delivery).toMatchObject({ method: 'manual', price: 6.5 });

    const shipped = await asStaff('PATCH', `/api/orders/${orderId}/status`, {
      status: 'shipped',
      shipments: [{ carrier: 'DHL', trackingNumber: 'D1' }],
    });
    expect(shipped.statusCode).toBe(200);
  });

  it('changes only the note once its parcels are made: the label carries the person, the address and the carrier', async () => {
    const { orderId } = await paidOrder();
    await asStaff('POST', `/api/orders/${orderId}/parcels`);

    for (const change of [
      { method: 'manual' },
      { address: { ...MADRID, house: '99' } },
      { recipientFirstName: 'Eva' },
    ]) {
      const res = await asStaff('PATCH', `/api/orders/${orderId}/delivery`, change);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'PARCELS_EXIST' });
    }

    const note = await asStaff('PATCH', `/api/orders/${orderId}/delivery`, {
      note: 'Ring twice',
    });
    expect(note.statusCode).toBe(200);
  });

  it('refuses an address in a country with customs while a product has no customs data', async () => {
    const { orderId } = await paidOrder();
    // the countries without customs: Spain only
    setShopSettings(CARRIER_SHOP);
    withCustoms('UA', 'PL', 'DE', 'GB');

    const res = await asStaff('PATCH', `/api/orders/${orderId}/delivery`, {
      address: {
        country: 'PL',
        postalCode: '00-001',
        city: 'Warszawa',
        street: 'Marszalkowska',
        house: '1',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_CUSTOMS_DATA_MISSING' });
  });
});
