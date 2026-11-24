import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  customsCountry,
  resetShopCountries,
  setShopCountries,
  testCountry,
} from '../../../helpers/shopCountries.js';
import {
  resetShopSettings,
  setShopSettings,
  testZonePrice,
} from '../../../helpers/shopSettings.js';

// The tax of a cart for the buyer (docs/taxes.md): POST /api/orders/current/delivery-options gives
// each way with the items at the prices the rule of the country leaves, the tax by rate, the total,
// whether the buyer may pay on receipt and why the order cannot go; the confirmation keeps the same
// numbers (the order answers with them) and refuses what the prices refused. The arithmetic is the
// unit tests' (unit/providers/tax), what the database keeps is db/orderTax.test.ts

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const rate = (value: number) => ({ group: null, rate: value, from: null });

// the shop in Ukraine takes the tax at 20 %; the parcels of the tests go to Ukraine, Germany and
// Britain at 5 by hand
const UA = testCountry('UA', { rule: 'seller', deliveryVat: 'main', rates: [rate(20)] });
// Britain: customs, the tax of the recipient up to 135 a parcel without the delivery and the tax,
// above it the buyer pays on receipt at the price without the tax of the seller
const GB = customsCountry('GB', {
  rule: 'recipient',
  registered: true,
  taxNumber: 'GB123456789',
  taxNumberLabel: 'UK VAT',
  taxNumberKind: 'other',
  rates: [rate(20)],
  parcelLimit: { amount: 135, withDelivery: false, withVat: false },
  deliveryVat: 'main',
  exportPrice: 'without_seller_vat',
  exemptionText: 'Export outside the customs union',
});

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(() => {
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

function shop(extra: Parameters<typeof setShopSettings>[0] = {}) {
  setShopSettings({
    ...testZonePrice(5),
    vatPayer: true,
    sellerCountry: 'UA',
    sellerTaxId: 'UA1234567890',
    sellerTaxIdLabel: 'IPN',
    pickupCountry: 'UA',
    ...extra,
  });
  setShopCountries([UA, GB]);
}

// a buyer with a cart of the product, and the id of the cart
async function cartOf(price: number, quantity: number) {
  const product = await createProduct({ price, stock: 10, hsCode: '940520', originCountry: 'UA' });
  const buyer = await createUser();
  userIds.push(buyer.id);
  const res = await app.inject({
    method: 'POST',
    url: '/api/orders/current/items',
    headers: withCsrf(csrf, accessCookie(buyer)),
    payload: { variantId: product.variantId, quantity },
  });
  expect(res.statusCode).toBe(200);
  return { buyer, orderId: res.json().id as number };
}

const ADDRESS: Record<string, Record<string, string>> = {
  UA: { country: 'UA', postalCode: '01001', city: 'Kyiv', street: 'Khreshchatyk', house: '1' },
  GB: { country: 'GB', postalCode: 'SW1A 1AA', city: 'London', street: 'Whitehall', house: '1' },
  DE: { country: 'DE', postalCode: '10115', city: 'Berlin', street: 'Lichtstrasse', house: '4' },
};

const options = (buyer: TestUser, country: string) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/delivery-options',
    headers: withCsrf(csrf, accessCookie(buyer)),
    payload: { address: ADDRESS[country] },
  });

const confirm = (
  buyer: TestUser,
  orderId: number,
  country: string | null,
  expectedDeliveryPrice: number,
  extra: Record<string, unknown> = {},
) =>
  app.inject({
    method: 'POST',
    url: '/api/orders/current/confirm',
    headers: withCsrf(csrf, accessCookie(buyer)),
    payload: {
      orderId,
      expectedDeliveryPrice,
      delivery: {
        method: country ? 'manual' : 'pickup',
        recipientFirstName: 'Anna',
        recipientLastName: 'Koval',
        recipientPhone: '+380501234567',
        ...(country ? { address: ADDRESS[country] } : {}),
      },
      ...extra,
    },
  });

const manualOf = (body: { options: { method: string }[] }) =>
  body.options.find((option) => option.method === 'manual') as Record<string, any>;

describe('the tax of the seller', () => {
  it('gives each way with the tax of its lines and of the delivery, and the confirmation keeps it', async () => {
    shop();
    const { buyer, orderId } = await cartOf(10, 2);

    const listed = (await options(buyer, 'UA')).json();
    const res = await confirm(buyer, orderId, 'UA', 5, { invoice: true });

    expect(manualOf(listed)).toMatchObject({
      price: 5,
      tax: {
        items: [{ unitPrice: 10, totalPrice: 20, rate: 20, tax: 3.33 }],
        totals: [{ rate: 20, net: 20.84, tax: 4.16, gross: 25 }],
        total: 25,
        payOnReceipt: false,
        refusal: null,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      total: 25,
      items: [{ unitPrice: 10, totalPrice: 20, tax: { rate: 20, amount: 3.33 } }],
      tax: {
        rule: 'seller',
        country: 'UA',
        totals: [{ rate: 20, net: 20.84, tax: 4.16, gross: 25 }],
        payOnReceipt: false,
        invoiceRequested: true,
      },
    });
  });

  it('taxes a pickup by the record of the country of the place', async () => {
    shop({ pickupCountry: 'DE' });
    setShopCountries([
      UA,
      testCountry('DE', {
        rule: 'none',
        exportPrice: 'same',
        exemptionText: 'No tax',
        deliveryVat: 'main',
      }),
    ]);
    const { buyer, orderId } = await cartOf(10, 2);

    const pickup = (await options(buyer, 'UA'))
      .json()
      .options.find((option: { method: string }) => option.method === 'pickup');
    const res = await confirm(buyer, orderId, null, 0);

    expect(pickup.tax).toMatchObject({ items: [{ rate: null, tax: 0 }], total: 20 });
    expect(res.json().tax).toMatchObject({ rule: 'none', country: 'DE' });
  });
});

describe('a country with customs', () => {
  it('leaves the tax to the buyer on receipt above the limit of a parcel, at the price without the tax of the seller', async () => {
    shop();
    // 200 holds 33.33 of the 20 % of the seller; the delivery 5 holds 0.83
    const { buyer, orderId } = await cartOf(200, 1);

    const listed = manualOf((await options(buyer, 'GB')).json());
    const res = await confirm(buyer, orderId, 'GB', 4.17);

    expect(listed).toMatchObject({
      price: 4.17,
      tax: {
        items: [{ unitPrice: 166.67, rate: null, tax: 0 }],
        total: 170.84,
        payOnReceipt: true,
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      total: 170.84,
      items: [{ unitPrice: 166.67, tax: { rate: null, amount: 0 } }],
      tax: { rule: 'buyer_at_receipt', country: 'GB', payOnReceipt: true },
    });
  });

  it('refuses a parcel within the limit of a country where the shop is not registered, with the limit', async () => {
    shop();
    setShopCountries([
      UA,
      { ...GB, registered: false, taxNumber: null, taxNumberLabel: null, taxNumberKind: null },
    ]);
    const { buyer, orderId } = await cartOf(100, 1);

    const listed = manualOf((await options(buyer, 'GB')).json());
    const res = await confirm(buyer, orderId, 'GB', 5);

    expect(listed.tax.refusal).toEqual({
      code: 'TAX_PARCEL_LIMIT',
      limit: 135,
      withDelivery: false,
      withVat: false,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'TAX_PARCEL_LIMIT',
      details: { limit: 135, withDelivery: false, withVat: false },
    });
  });
});

describe('the refusals of the confirmation', () => {
  it('stops the sale to a country whose tax holds from the first sale where the shop is not registered', async () => {
    shop();
    setShopCountries([
      UA,
      testCountry('DE', { rule: 'recipient', deliveryVat: 'main', rates: [rate(19)] }),
    ]);
    const { buyer, orderId } = await cartOf(10, 1);

    const listed = manualOf((await options(buyer, 'DE')).json());
    const res = await confirm(buyer, orderId, 'DE', 5);

    expect(listed.tax.refusal).toEqual({ code: 'TAX_SALES_STOPPED' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'TAX_SALES_STOPPED' });
  });

  it('refuses a total above the largest one of the shop, with the sum', async () => {
    shop({ maxOrderTotal: 20 });
    const { buyer, orderId } = await cartOf(10, 2);

    const listed = manualOf((await options(buyer, 'UA')).json());
    const res = await confirm(buyer, orderId, 'UA', 5);

    expect(listed.tax.refusal).toEqual({ code: 'ORDER_TOTAL_ABOVE_MAXIMUM', maximum: 20 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'ORDER_TOTAL_ABOVE_MAXIMUM',
      details: { maximum: 20 },
    });
  });
});
