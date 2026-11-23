import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

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
import { CARRIERS } from '../../../helpers/carrierOrders.js';
import { takeLogs } from '../../../helpers/logs.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';
import { customsCountry, setShopCountries } from '../../../helpers/shopCountries.js';
import {
  breakShippyPro,
  steadyCarrierWords,
  useCarriers,
  watchShippyPro,
  whileShippyPro,
} from '../../../helpers/shippyPro.js';

import env from '@config/env.js';

import type { ShopSettingsValues } from '@config/shopSettings.js';

// POST /api/orders/current/delivery-options and the confirmation of a carrier: the ways the cart of
// the buyer goes to an address and their prices (the manual delivery at the price of the zone, the
// pickup, the carriers of the delivery provider from the cheapest, every one free from the sum of
// the zone), why no carrier is there, the customs of a country outside the free ones, a variant the
// shop has nothing to send with; the confirmation of a carrier takes its price again from the
// provider (five minutes kept) and fixes it. The provider is the mock of the tests: Generic at 4
// up to 5 kg and 10 up to 500, MockExpress at 6.5 up to 2 kg and 12 up to 30

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const SENDER = {
  name: 'Cartlify Shop',
  street: 'Calle de la Paz',
  house: '1',
  apartment: null,
  city: 'Valencia',
  postalCode: '46003',
  country: 'ES',
  phone: '+34960000000',
  email: 'shop@example.com',
};

// the shop of these tests: Spain at 5 by hand, free from 60; Germany by carriers only; France by
// hand at 30, across customs (its record, beforeAll); Spain and Germany without customs
const SHOP: Partial<ShopSettingsValues> = {
  deliveryMethods: ['manual', 'pickup', 'carrier'],
  deliveryZones: [
    { name: 'Spain', countries: ['ES'], manualPrice: 5, freeFrom: 60 },
    { name: 'Germany', countries: ['DE'], manualPrice: null, freeFrom: null },
    { name: 'Rest', countries: ['FR'], manualPrice: 30, freeFrom: null },
  ],
  deliverySender: SENDER,
};

const MADRID = {
  country: 'ES',
  postalCode: '28013',
  city: 'Madrid',
  street: 'Calle Mayor',
  house: '1',
};
const BERLIN = {
  country: 'DE',
  postalCode: '10115',
  city: 'Berlin',
  street: 'Lichtstrasse',
  house: '4',
};
const PARIS = {
  country: 'FR',
  postalCode: '75001',
  city: 'Paris',
  street: 'Rue de Rivoli',
  house: '1',
};

const SHIPPING = { weightGrams: 500, sizesMm: { length: 300, width: 200, height: 100 } };

// the tax of a way of a shop that takes none: the items as they are, no tax, the total
const untaxed = (total: number) => ({
  items: [expect.objectContaining({ rate: null, tax: 0 })],
  totals: [{ rate: null, net: total, tax: 0, gross: total }],
  total,
  payOnReceipt: false,
  refusal: null,
});

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  setShopCountries([customsCountry('FR')]);
});

afterEach(resetShopSettings);

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

async function buyerWith(items: { variantId: number; quantity: number }[]) {
  const buyer = await createUser();
  userIds.push(buyer.id);
  let cartId = 0;
  for (const item of items) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: item,
    });
    expect(res.statusCode).toBe(200);
    cartId = res.json().id;
  }
  return { buyer, cartId };
}

const options = (buyer: TestUser, address: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/delivery-options',
    headers: withCsrf(csrf, accessCookie(buyer)),
    payload: { address },
  });

const confirm = (
  buyer: TestUser,
  orderId: number,
  delivery: Record<string, unknown>,
  expectedDeliveryPrice: number,
) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(buyer)),
    payload: {
      orderId,
      expectedDeliveryPrice,
      delivery: {
        recipientFirstName: 'Ana',
        recipientLastName: 'Garcia',
        recipientPhone: '+34910000000',
        ...delivery,
      },
    },
  });

const byCarrier = (address: Record<string, unknown>, name = 'Generic') => ({
  method: 'carrier',
  address,
  carrier: name === 'Generic' ? CARRIERS.Generic : CARRIERS.MockExpress,
});

describe('POST /api/orders/current/delivery-options', () => {
  it('lists the manual delivery of the zone, the pickup and the carriers from the cheapest', async () => {
    setShopSettings(SHOP);
    const mug = await createProduct({ price: 10, ...SHIPPING });
    const { buyer } = await buyerWith([{ variantId: mug.variantId, quantity: 2 }]);

    const res = await options(buyer, MADRID);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      currency: 'eur',
      zone: { name: 'Spain', freeFrom: 60 },
      remainingToFree: 40,
      options: [
        { method: 'manual', price: 5, carrier: null, label: null, days: null, tax: untaxed(25) },
        { method: 'pickup', price: 0, carrier: null, label: null, days: null, tax: untaxed(20) },
        {
          method: 'carrier',
          price: 4,
          carrier: CARRIERS.Generic,
          ...steadyCarrierWords(),
          tax: untaxed(24),
        },
        {
          method: 'carrier',
          price: 6.5,
          carrier: { name: 'MockExpress', service: 'Express', connection: '7001' },
          label: 'Mock express',
          days: '1-2',
          tax: untaxed(26.5),
        },
      ],
      carriersUnavailable: null,
    });
  });

  it('makes the manual delivery and the cheapest carrier free from the sum of the zone; another carrier costs what it costs above the cheapest', async () => {
    setShopSettings(SHOP);
    const lamp = await createProduct({ price: 30, ...SHIPPING });
    const { buyer, cartId } = await buyerWith([{ variantId: lamp.variantId, quantity: 2 }]);

    const body = (await options(buyer, MADRID)).json();

    expect(body.remainingToFree).toBe(0);
    // by hand, the pickup, Generic at 4 and MockExpress at 6.5
    expect(body.options.map((option: { price: number }) => option.price)).toEqual([0, 0, 0, 2.5]);

    // and the confirmation fixes that price
    const res = await confirm(buyer, cartId, byCarrier(MADRID, 'MockExpress'), 2.5);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 62.5, delivery: { method: 'carrier', price: 2.5 } });
  });

  it('leaves the manual delivery out of a zone without its price, and asks the price of another zone', async () => {
    setShopSettings(SHOP);
    // France has customs: the mug has its data
    const mug = await createProduct({
      price: 10,
      ...SHIPPING,
      hsCode: '691200',
      originCountry: 'PT',
    });
    const { buyer } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);

    const berlin = (await options(buyer, BERLIN)).json();
    const paris = (await options(buyer, PARIS)).json();

    expect(berlin.options.map((option: { method: string }) => option.method)).toEqual([
      'pickup',
      'carrier',
      'carrier',
    ]);
    expect(paris.zone).toEqual({ name: 'Rest', freeFrom: null });
    expect(paris.options[0]).toMatchObject({ method: 'manual', price: 30 });
  });

  it('refuses an address in a country of no zone', async () => {
    setShopSettings({ ...SHOP, deliveryZones: [SHOP.deliveryZones![0]!] });
    const mug = await createProduct({ price: 10, ...SHIPPING });
    const { buyer } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);

    const res = await options(buyer, PARIS);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'DELIVERY_COUNTRY_NOT_ALLOWED',
      details: { country: 'FR' },
    });
  });

  it('says the carriers are off while the shop sends by none', async () => {
    setShopSettings({ ...SHOP, deliveryMethods: ['manual', 'pickup'] });
    const mug = await createProduct({ price: 10, ...SHIPPING });
    const { buyer } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);
    const calls = watchShippyPro();

    const body = (await options(buyer, MADRID)).json();

    expect(body.carriersUnavailable).toBe('not_enabled');
    expect(body.options.map((option: { method: string }) => option.method)).toEqual([
      'manual',
      'pickup',
    ]);
    expect(calls).toEqual([]);
  });

  it('lists no carrier for a cart with a variant without its weight or sizes', async () => {
    setShopSettings(SHOP);
    const mug = await createProduct({ price: 10, ...SHIPPING });
    const loose = await createProduct({ price: 10 });
    const { buyer } = await buyerWith([
      { variantId: mug.variantId, quantity: 1 },
      { variantId: loose.variantId, quantity: 1 },
    ]);

    const body = (await options(buyer, MADRID)).json();

    expect(body.carriersUnavailable).toBe('shipping_data_missing');
    expect(body.options.map((option: { method: string }) => option.method)).toEqual([
      'manual',
      'pickup',
    ]);
  });

  it('keeps the manual delivery and the pickup while the provider does not answer', async () => {
    setShopSettings(SHOP);
    const mug = await createProduct({ price: 10, ...SHIPPING });
    const { buyer } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);
    breakShippyPro('429');

    const body = (await options(buyer, MADRID)).json();

    expect(body.carriersUnavailable).toBe('provider_down');
    expect(body.options.map((option: { method: string }) => option.method)).toEqual([
      'manual',
      'pickup',
    ]);
    expect(takeLogs({ msg: 'delivery provider did not answer the prices' })).toHaveLength(1);
  });

  it('says the provider prices no carrier for the parcel, keeps the other methods and tells the log', async () => {
    setShopSettings(SHOP);
    // a price of its own: the answer is kept five minutes for an address, a box and a value
    const mug = await createProduct({ price: 13.7, ...SHIPPING });
    const { buyer } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);
    useCarriers([]);

    const body = (await options(buyer, MADRID)).json();

    expect(body.carriersUnavailable).toBe('no_carrier_for_parcel');
    expect(body.options.map((option: { method: string }) => option.method)).toEqual([
      'manual',
      'pickup',
    ]);
    expect(takeLogs({ msg: 'the delivery provider prices no carrier for a parcel' })).toHaveLength(
      1,
    );
  });

  it('is unavailable while the provider does not answer and the carriers are all the shop has', async () => {
    setShopSettings({ ...SHOP, deliveryMethods: ['carrier'] });
    const mug = await createProduct({ price: 10, ...SHIPPING });
    const { buyer } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);
    breakShippyPro('unreachable');

    const res = await options(buyer, MADRID);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_PROVIDER_UNAVAILABLE' });
    expect(takeLogs({ errorCode: 'DELIVERY_PROVIDER_UNAVAILABLE' })).toHaveLength(1);
  });

  it('asks the provider once in five minutes for the same cart and address', async () => {
    setShopSettings(SHOP);
    const mug = await createProduct({ price: 10, ...SHIPPING });
    const { buyer } = await buyerWith([{ variantId: mug.variantId, quantity: 3 }]);
    const calls = watchShippyPro();

    await options(buyer, MADRID);
    await options(buyer, MADRID);

    expect(calls.filter((call) => call.method === 'GetRates')).toHaveLength(1);
  });

  it('refuses a country with customs while a product has no customs data, naming it', async () => {
    setShopSettings(SHOP);
    const shirt = await createProduct({
      price: 10,
      ...SHIPPING,
      hsCode: '610510',
      originCountry: 'PT',
    });
    const mug = await createProduct({ price: 10, name: 'Plain mug', ...SHIPPING });
    const { buyer } = await buyerWith([
      { variantId: shirt.variantId, quantity: 1 },
      { variantId: mug.variantId, quantity: 1 },
    ]);

    const res = await options(buyer, PARIS);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'DELIVERY_CUSTOMS_DATA_MISSING',
      details: { products: [{ productId: mug.id, name: 'Plain mug' }] },
    });
    // Spain is free of customs
    expect((await options(buyer, MADRID)).statusCode).toBe(200);
  });

  it('stops a buyer that asks the prices too often in a minute (429 RATE_LIMITED): the provider takes few requests for the whole shop', async () => {
    setShopSettings(SHOP);
    const mug = await createProduct({ price: 10, ...SHIPPING });
    const { buyer } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);
    // the tests raise every limit a thousand times: here it counts as the server has it
    const before = { limit: env.LIMIT_DELIVERY_PRICES_PER_USER, scale: env.REQUEST_LIMITS_SCALE };
    env.LIMIT_DELIVERY_PRICES_PER_USER = 2;
    env.REQUEST_LIMITS_SCALE = 1;

    try {
      for (let i = 0; i < 2; i += 1) expect((await options(buyer, MADRID)).statusCode).toBe(200);

      const refused = await options(buyer, MADRID);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({
        errorCode: 'RATE_LIMITED',
        details: { limit: 'deliveryPrices' },
      });
    } finally {
      env.LIMIT_DELIVERY_PRICES_PER_USER = before.limit;
      env.REQUEST_LIMITS_SCALE = before.scale;
    }
  });

  it('refuses a buyer without a cart', async () => {
    setShopSettings(SHOP);
    const buyer = await createUser();
    userIds.push(buyer.id);

    const res = await options(buyer, MADRID);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'ORDER_ITEMS_REQUIRED' });
  });
});

describe('POST /api/orders/current/confirm by a carrier', () => {
  it('fixes the price of the carrier the buyer picked, with the carrier on the delivery', async () => {
    setShopSettings(SHOP);
    const mug = await createProduct({ price: 10, ...SHIPPING });
    const { buyer, cartId } = await buyerWith([{ variantId: mug.variantId, quantity: 2 }]);
    const shown = (await options(buyer, MADRID)).json().options[3];

    const res = await confirm(buyer, cartId, byCarrier(MADRID, 'MockExpress'), shown.price);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'waiting',
      total: 26.5,
      delivery: { method: 'carrier', price: 6.5, address: { country: 'ES', city: 'Madrid' } },
    });
    const row = await asAdmin((tx) =>
      tx.orderDelivery.findUniqueOrThrow({
        where: { orderId: cartId },
        select: { carrierName: true, carrierService: true, carrierConnection: true },
      }),
    );
    expect(row).toEqual({
      carrierName: 'MockExpress',
      carrierService: 'Express',
      carrierConnection: '7001',
    });
  });

  it('takes the price of the cart as it is at the confirmation', async () => {
    setShopSettings(SHOP);
    const mug = await createProduct({ price: 10, weightGrams: 1500, sizesMm: SHIPPING.sizesMm });
    const { buyer, cartId } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);
    const shown = (await options(buyer, MADRID)).json().options[3].price;
    // one more mug: 3 kg, the second range of MockExpress
    await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: { variantId: mug.variantId, quantity: 1 },
    });

    const res = await confirm(buyer, cartId, byCarrier(MADRID, 'MockExpress'), shown);

    expect(shown).toBe(6.5);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'DELIVERY_PRICE_CHANGED',
      details: { price: 12 },
    });
  });

  it('confirms nothing when the cart changed while the carrier was asked for its price (409 RESOURCE_BUSY)', async () => {
    setShopSettings(SHOP);
    const mug = await createProduct({ price: 10, weightGrams: 1500, sizesMm: SHIPPING.sizesMm });
    const { buyer, cartId } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);
    // an address no price was asked for: the confirmation asks the provider
    const address = { ...MADRID, house: String(cartId) };
    // one more mug lands meanwhile: 3 kg, the second range of MockExpress, not the 6.5 asked for
    whileShippyPro('GetRates', async () => {
      const added = await app.inject({
        method: 'POST',
        url: '/api/orders/current/items',
        headers: withCsrf(csrf, accessCookie(buyer)),
        payload: { variantId: mug.variantId, quantity: 1 },
      });
      expect(added.statusCode).toBe(200);
    });

    const res = await confirm(buyer, cartId, byCarrier(address, 'MockExpress'), 6.5);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'RESOURCE_BUSY' });
    const order = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: cartId }, select: { confirmed: true } }),
    );
    expect(order.confirmed).toBe(false);

    // again: the checks see the cart as it is
    const again = await confirm(buyer, cartId, byCarrier(address, 'MockExpress'), 6.5);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      errorCode: 'DELIVERY_PRICE_CHANGED',
      details: { price: 12 },
    });
  });

  it('refuses a carrier the provider no longer prices for the cart', async () => {
    setShopSettings(SHOP);
    // 35 kg: MockExpress takes up to 30
    const crate = await createProduct({ price: 10, weightGrams: 35000, sizesMm: SHIPPING.sizesMm });
    const { buyer, cartId } = await buyerWith([{ variantId: crate.variantId, quantity: 1 }]);

    const res = await confirm(buyer, cartId, byCarrier(MADRID, 'MockExpress'), 12);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_SERVICE_UNAVAILABLE' });
  });

  it('is unavailable while the provider does not answer, and confirms nothing', async () => {
    setShopSettings(SHOP);
    const mug = await createProduct({ price: 10, weightGrams: 700, sizesMm: SHIPPING.sizesMm });
    const { buyer, cartId } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);
    breakShippyPro('hangs');

    const res = await confirm(buyer, cartId, byCarrier(MADRID), 4);

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_PROVIDER_UNAVAILABLE' });
    expect(takeLogs({ errorCode: 'DELIVERY_PROVIDER_UNAVAILABLE' })).toHaveLength(1);
    const order = await asAdmin((tx) =>
      tx.order.findUniqueOrThrow({ where: { id: cartId }, select: { confirmed: true } }),
    );
    expect(order.confirmed).toBe(false);
  });

  it.each([
    [
      'a carrier without the one picked',
      { method: 'carrier', address: MADRID },
      'DELIVERY_CARRIER_REQUIRED',
    ],
    [
      'a carrier named with the manual delivery',
      { ...byCarrier(MADRID), method: 'manual' },
      'DELIVERY_CARRIER_NOT_ALLOWED',
    ],
    [
      'the manual delivery to a zone that has no price for it',
      {
        method: 'manual',
        address: { ...MADRID, country: 'DE', postalCode: '10115', city: 'Berlin' },
      },
      'DELIVERY_COUNTRY_NOT_ALLOWED',
    ],
  ])('refuses %s', async (_case, delivery, errorCode) => {
    setShopSettings(SHOP);
    const mug = await createProduct({ price: 10, ...SHIPPING });
    const { buyer, cartId } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);

    const res = await confirm(buyer, cartId, delivery, 0);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
  });

  it('refuses a country with customs for a product without customs data, by hand too', async () => {
    setShopSettings(SHOP);
    const mug = await createProduct({ price: 10, ...SHIPPING });
    const { buyer, cartId } = await buyerWith([{ variantId: mug.variantId, quantity: 1 }]);

    const res = await confirm(buyer, cartId, { method: 'manual', address: PARIS }, 30);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'DELIVERY_CUSTOMS_DATA_MISSING' });
  });
});

describe('a variant the shop has nothing to send with', () => {
  // the shop sends by carriers only: a variant without its weight or sizes cannot go
  const CARRIERS_ONLY = { ...SHOP, deliveryMethods: ['carrier' as const] };

  it('shows no free units on the card and does not go into a cart', async () => {
    const loose = await createProduct({ price: 10, stock: 5 });
    const buyer = await createUser();
    userIds.push(buyer.id);
    setShopSettings(CARRIERS_ONLY);

    const card = await app.inject({ method: 'GET', url: `/api/products/${loose.id}` });
    const added = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers: withCsrf(csrf, accessCookie(buyer)),
      payload: { variantId: loose.variantId, quantity: 1 },
    });

    expect(card.json().variant.stock).toBe(0);
    expect(added.statusCode).toBe(409);
    expect(added.json()).toMatchObject({
      errorCode: 'PRODUCT_NOT_DELIVERABLE',
      details: { variantId: loose.variantId },
    });
  });

  it('refuses a cart that holds one from before, naming the item', async () => {
    const loose = await createProduct({ price: 10, stock: 5 });
    const { buyer, cartId } = await buyerWith([{ variantId: loose.variantId, quantity: 1 }]);
    setShopSettings(CARRIERS_ONLY);

    const res = await confirm(buyer, cartId, byCarrier(MADRID), 4);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_ITEMS_NOT_DELIVERABLE',
      details: { items: [{ variantId: loose.variantId }] },
    });
  });
});
