import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';
import {
  applyTestShopSettingsBaseline,
  INTEGRATION_SHOP_BASELINE,
} from '../../../helpers/shopSettings.js';

// The tax documents of an order for the buyer and for an admin (docs/taxes.md): the list
// (GET /api/orders/:orderId/documents) and the PDF of an invoice drawn from its row. The shop makes
// an invoice of every order here: a setting of the whole shop (*.shopwide.test.ts), put back at the
// end. What a document holds is db/taxDocuments.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let admin: TestUser;
let buyer: TestUser;
let stranger: TestUser;

const SETTINGS: [string, unknown][] = [
  ['invoicePrefix', 'APIDOC'],
  ['creditNotePrefix', 'APIDOCR'],
  ['invoiceYearly', false],
  ['invoiceMode', 'every_order'],
];

const putSetting = (key: string, value: unknown) =>
  app.inject({
    method: 'PUT',
    url: `/api/root/shop-settings/${key}`,
    headers: withCsrf(csrf, accessCookie(root)),
    payload: { value },
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT' });
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
  stranger = await createUser();
  for (const [key, value] of SETTINGS) {
    const res = await putSetting(key, value);
    expect(res.statusCode).toBe(200);
  }
  // a write reads the settings of the database into the memory: the shop of the tests on them again
  // (the database reads the invoices of the rows)
  applyTestShopSettingsBaseline(INTEGRATION_SHOP_BASELINE);
});

afterAll(async () => {
  try {
    for (const [key] of [...SETTINGS].reverse()) await putSetting(key, null);
    await closeSessions([root.id, admin.id, buyer.id, stranger.id]);
  } finally {
    await stopApp();
  }
});

const get = (actor: TestUser, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

describe('the documents of an order', () => {
  it('gives the buyer and an admin the invoice of a paid order and its PDF, nobody else', async () => {
    const product = await createProduct({ price: 12, stock: 5 });
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 2);

    const listed = await get(buyer, `/api/orders/${orderId}/documents`);
    const [invoice] = listed.json().items;
    const pdf = await get(buyer, `/api/orders/${orderId}/documents/${invoice.id}/pdf`);
    const byAdmin = await get(admin, `/api/orders/${orderId}/documents/${invoice.id}/pdf`);
    const foreign = await get(stranger, `/api/orders/${orderId}/documents`);
    const missing = await get(buyer, `/api/orders/${orderId}/documents/${invoice.id + 100000}/pdf`);

    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    expect(invoice).toMatchObject({ kind: 'invoice', gross: 24, tax: 0, receipt: null });
    expect(invoice.number).toMatch(/^APIDOC-\d+$/);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect(byAdmin.statusCode).toBe(200);
    expect(foreign.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ errorCode: 'TAX_DOCUMENT_NOT_FOUND' });
  });

  it('gives the invoice of an order in the export of its buyer, with the copy of the buyer only, and none to another person', async () => {
    const product = await createProduct({ price: 9, stock: 5 });
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 1);

    const mine = (await get(buyer, '/api/users/me/export')).json();
    const theirs = (await get(stranger, '/api/users/me/export')).json();

    const [invoice] = mine.taxDocuments.filter((d: { orderId: number }) => d.orderId === orderId);
    expect(invoice).toEqual({
      orderId,
      kind: 'invoice',
      number: expect.stringMatching(/^APIDOC-\d+$/),
      createdAt: expect.any(String),
      gross: '9',
      currency: 'EUR',
      buyer: expect.objectContaining({ country: expect.any(String), city: expect.any(String) }),
    });
    expect(theirs.taxDocuments.map((d: { orderId: number }) => d.orderId)).not.toContain(orderId);
  });
});

describe('the series of the documents', () => {
  // the invoices go on in a new series; the credit notes may not take the one the invoices were
  // numbered in
  it('refuses root a prefix of the credit notes the invoices are numbered in (INVOICE_SERIES_TAKEN), and lets a new prefix start a new series', async () => {
    const product = await createProduct({ price: 7, stock: 5 });
    await placeOrder(app, csrf, buyer, product, 'paid', 1);

    const renamed = await putSetting('invoicePrefix', 'APIDOCN');
    const taken = await putSetting('creditNotePrefix', 'APIDOC');
    const back = await putSetting('invoicePrefix', 'APIDOC');
    applyTestShopSettingsBaseline(INTEGRATION_SHOP_BASELINE);

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ invoicePrefix: 'APIDOCN', creditNotePrefix: 'APIDOCR' });
    expect(taken.statusCode).toBe(400);
    expect(taken.json()).toMatchObject({ errorCode: 'INVOICE_SERIES_TAKEN' });
    expect(back.statusCode).toBe(200);
  });
});
