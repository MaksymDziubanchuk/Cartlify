import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import type { ShopCountry } from '@config/shopCountries.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { CARRIER_SHOP, SIZED, carrierOrder } from '../../../helpers/carrierOrders.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { resetShopSettings, setShopSettings } from '../../../helpers/shopSettings.js';
import {
  customsCountry,
  resetShopCountries,
  setShopCountries,
  testCountry,
} from '../../../helpers/shopCountries.js';
import { breakShippyPro, watchShippyPro, whileShippyPro } from '../../../helpers/shippyPro.js';

// The tax number of the shop on a parcel that crosses customs to a country the shop took the tax of
// (docs/taxes.md): a number of the import scheme (IOSS) goes with the parcel; any other number goes
// on a commercial invoice, sent to the carrier with the parcel when it takes it electronically, else
// printed by the admin (GET .../customs-invoice); a country that has no number now refuses the parcel.
// The records of the countries live in the memory of this file (tests/helpers/shopCountries.ts); the
// shop makes no invoices here, so the commercial invoice names the number of the parcel (the invoice
// of the order is in the flow of the taxes)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

const rate = (value: number) => ({ group: null, rate: value, from: null });

const LONDON = {
  country: 'GB',
  postalCode: 'E1 6AN',
  city: 'London',
  street: 'Test Street',
  house: '1',
};

// the shop in Spain takes the tax of Britain, where it is registered with a number of the kind given
const britain = (fields: Partial<ShopCountry> = {}): ShopCountry =>
  customsCountry('GB', {
    rule: 'recipient',
    registered: true,
    taxNumber: 'GB123456789',
    taxNumberLabel: 'UK VAT',
    taxNumberKind: 'other',
    rates: [rate(20)],
    deliveryVat: 'main',
    exportPrice: 'same',
    exemptionText: 'Export outside the customs union',
    ...fields,
  });

function shop(gb: ShopCountry) {
  setShopSettings({
    ...CARRIER_SHOP,
    vatPayer: true,
    sellerCountry: 'ES',
    sellerTaxId: 'ESB12345678',
    sellerTaxIdLabel: 'NIF',
  });
  setShopCountries([
    testCountry('ES', { rule: 'seller', deliveryVat: 'main', rates: [rate(21)] }),
    gb,
  ]);
}

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

const asStaff = (method: 'GET' | 'POST', url: string, actor: TestUser = admin) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    ...(method === 'POST' ? { payload: {} } : {}),
  });

// a paid order of two shirts at 25 to London by the carrier: the shop took the tax of Britain (20 %:
// 8.33 of the 50)
async function paidOrderToLondon(
  gb: ShopCountry,
  carrier: 'MockExpress' | 'Generic' = 'MockExpress',
) {
  shop(gb);
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
    { carrier, address: LONDON },
  );
  userIds.push(buyer.id);
  return { buyer, orderId };
}

describe('the tax number of the shop on a parcel', () => {
  it('gives a number of the import scheme with the parcel, and makes no commercial invoice', async () => {
    const { orderId } = await paidOrderToLondon(
      britain({ taxNumber: 'IM2500000001', taxNumberLabel: 'IOSS', taxNumberKind: 'ioss' }),
    );
    const calls = watchShippyPro();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(200);
    const ship = calls.find((call) => call.method === 'Ship');
    expect(ship?.params.Attributes).toEqual({ sp_ioss: 'IM2500000001' });
    // the customs value is without the tax of Britain the shop took: 50 less 8.33
    expect(ship?.params.TotalValue).toBe('41.67 EUR');
    expect(ship?.params.CN22Info).toMatchObject([{ Quantity: 2, UnitValue: 20.84 }]);
    expect(calls.map((call) => call.method)).not.toContain('CreateCrossBorderInvoice');
    expect(res.json().order.shipments).toMatchObject([{ customsInvoice: null }]);
  });

  it('sends the commercial invoice with another number to a carrier that takes it electronically', async () => {
    const { orderId } = await paidOrderToLondon(britain());
    const calls = watchShippyPro();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(200);
    const ship = calls.find((call) => call.method === 'Ship')!;
    expect(ship.params.Attributes).toBeUndefined();
    const [parcel] = res.json().order.shipments;
    expect(parcel.customsInvoice).toBe('electronic');
    const invoice = calls.find((call) => call.method === 'CreateCrossBorderInvoice');
    // the values without the tax, the tax the buyer paid apart; the shop makes no invoices here:
    // the number of the parcel
    expect(invoice?.params).toMatchObject({
      UploadETD: 'true',
      InvoiceNumber: `${orderId}-1`,
      OrderReference: `${orderId}-1`,
      CountryOfExportDestination: 'GB',
      ShipperExporter: { Country: 'ES', VatNumber: 'GB123456789' },
      Consignee: { City: 'London', Country: 'GB' },
      TotalAmount: 41.67,
      TotalGst: 8.33,
      Goods: [
        {
          Description: expect.stringContaining('Cotton shirt'),
          HsCode: '610510',
          CountryOfOrigin: 'PT',
          Quantity: 2,
          Weight: 0.8,
          GstPaid: 8.33,
          SubTotalValue: 41.67,
        },
      ],
    });
  });

  it('leaves the invoice to print with a carrier that does not take it, and draws it for the admin', async () => {
    const { orderId, buyer } = await paidOrderToLondon(britain(), 'Generic');
    const calls = watchShippyPro();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(200);
    expect(calls.map((call) => call.method)).not.toContain('CreateCrossBorderInvoice');
    const [parcel] = res.json().order.shipments;
    expect(parcel.customsInvoice).toBe('print');

    const url = `/api/orders/${orderId}/shipments/${parcel.id}/customs-invoice`;
    const pdf = await asStaff('GET', url);
    const byBuyer = await asStaff('GET', url, buyer);

    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toBe(
      `attachment; filename="customs-invoice-${orderId}-1.pdf"`,
    );
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // drawn again, not sent to the carrier again
    const drawn = calls.filter((call) => call.method === 'CreateCrossBorderInvoice');
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.params.UploadETD).toBeUndefined();
    expect(drawn[0]!.params).toMatchObject({ ShipperExporter: { VatNumber: 'GB123456789' } });
    expect(byBuyer.statusCode).toBe(403);
  });

  it('leaves the invoice to print when the provider does not take it, and keeps the parcel', async () => {
    const { orderId } = await paidOrderToLondon(britain());
    whileShippyPro('CreateCrossBorderInvoice', async () => breakShippyPro('error'));

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(200);
    expect(res.json().made).toHaveLength(1);
    expect(res.json().order.shipments).toMatchObject([{ customsInvoice: 'print' }]);
    expect(
      takeLogs({
        msg: 'the commercial invoice of a parcel was not sent with it: the admin prints it',
      }),
    ).toHaveLength(1);
  });

  it('refuses the parcel while the country has no tax number of the shop now, and makes nothing', async () => {
    const { orderId } = await paidOrderToLondon(britain());
    // root took the registration in Britain back after the order was paid
    setShopCountries([
      britain({
        rule: 'buyer_at_receipt',
        registered: false,
        taxNumber: null,
        taxNumberLabel: null,
        taxNumberKind: null,
      }),
    ]);
    const calls = watchShippyPro();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      errorCode: 'DELIVERY_TAX_NUMBER_MISSING',
      details: { country: 'GB' },
    });
    expect(calls.map((call) => call.method)).not.toContain('Ship');
  });

  it('gives no number with a parcel the shop took no tax of Britain on', async () => {
    // the buyer pays the tax on receipt: the shop is not registered in Britain
    const { orderId } = await paidOrderToLondon(
      britain({
        rule: 'buyer_at_receipt',
        registered: false,
        taxNumber: null,
        taxNumberLabel: null,
        taxNumberKind: null,
      }),
    );
    // registered since, with a number: the order was sold without the tax of Britain
    setShopCountries([britain()]);
    const calls = watchShippyPro();

    const res = await asStaff('POST', `/api/orders/${orderId}/parcels`);

    expect(res.statusCode).toBe(200);
    expect(calls.find((call) => call.method === 'Ship')?.params.Attributes).toBeUndefined();
    expect(calls.map((call) => call.method)).not.toContain('CreateCrossBorderInvoice');
    expect(res.json().order.shipments).toMatchObject([{ customsInvoice: null }]);
  });
});

describe('GET /api/orders/:orderId/shipments/:shipmentId/customs-invoice', () => {
  it('refuses a parcel without a commercial invoice, and a parcel the order does not have', async () => {
    const { orderId } = await paidOrderToLondon(
      britain({ taxNumber: 'IM2500000001', taxNumberLabel: 'IOSS', taxNumberKind: 'ioss' }),
    );
    const made = await asStaff('POST', `/api/orders/${orderId}/parcels`);
    const [parcel] = made.json().order.shipments;

    const none = await asStaff(
      'GET',
      `/api/orders/${orderId}/shipments/${parcel.id}/customs-invoice`,
    );
    const missing = await asStaff(
      'GET',
      `/api/orders/${orderId}/shipments/${parcel.id + 100000}/customs-invoice`,
    );

    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ errorCode: 'CUSTOMS_INVOICE_NONE' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ errorCode: 'ORDER_SHIPMENT_NOT_FOUND' });
  });

  it('refuses a parcel voided to be made again', async () => {
    const { orderId } = await paidOrderToLondon(britain(), 'Generic');
    const made = await asStaff('POST', `/api/orders/${orderId}/parcels`);
    const [parcel] = made.json().order.shipments;
    const voided = await asStaff('POST', `/api/orders/${orderId}/parcels/void`);
    expect(voided.statusCode).toBe(200);

    const res = await asStaff(
      'GET',
      `/api/orders/${orderId}/shipments/${parcel.id}/customs-invoice`,
    );

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PARCEL_STATE_INVALID' });
  });
});
