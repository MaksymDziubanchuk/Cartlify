import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { loadShopCountries } from '@config/shopCountries.js';
import { setUserContext } from '@db/dbContext.service.js';
import { issuePendingReceipts } from '@routes/api/orders/services/receipts.service.js';

import { accessCookie } from '../../helpers/actors.js';
import { alertsOf } from '../../helpers/alerts.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { CARRIERS, SENDER, SIZED } from '../../helpers/carrierOrders.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin, testTx } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { fiskalyWait, realFiskaly } from '../../helpers/fiskaly.js';
import { watchMail, type SentMail } from '../../helpers/mail.js';
import { openPaymentPage, payPage } from '../../helpers/payments.js';
import { receiptHarness, type ReceiptHarness } from '../../helpers/providers.js';
import { mailTo, statementCodeIn, withdrawalLinkIn } from '../../helpers/returnJourney.js';
import { watchShippyPro } from '../../helpers/shippyPro.js';
import {
  closeDispute,
  closeOpenSessions,
  deliver,
  disputeEvent,
  openDispute,
  realStripe,
  refundAtStripe,
  refundBecomes,
  stripeEvent,
} from '../../helpers/stripe.js';

// The taxes of a shop in Spain that sells to several countries (docs/taxes.md), as its people go
// it: root writes the data of the seller, the series of the documents, a tax group and the countries
// with the rule of each (Spain by the tax of the seller; Austria by its own past a threshold, the
// shop registered there, a rate that starts in three days; France the same but not registered;
// Britain across customs by its own tax, the number of the shop on a commercial invoice; Switzerland
// across customs, the buyer pays on receipt). The buyers buy: in Spain and in Austria below the
// threshold at the tax of Spain, in Austria past it at the tax of Austria, in France they meet the
// stop of the sales, to Britain by a carrier, to Switzerland without the tax. Each payment makes an
// invoice and a receipt the worker registers at fiskaly (its mock, or TEST with service:fiskaly) and
// mails; the admin makes the parcel to Britain and its commercial invoice names the invoice of the
// order; a compensation makes a credit note and a receipt of the return. The money that goes back
// another way gives the documents of its tax: a transfer of a statement a credit note, and an invoice
// that reverses it when the bank of the card sends the money back; money sent outside the app a credit
// note; money given back by hand and what a bank took for a dispute none until root (or the system,
// for an order not sent) says what it was for, a decision made again an invoice that reverses the one
// before; a statement that money pays later none; money the buyer gives back an invoice that reverses
// its share. The buyer finds the documents in the export of their data. The worker registers the
// receipts of those documents; a receipt the tax authority refuses root finds by its alert and
// registers by hand. Root opens a pickup in Vienna (the tax of the place, not of the address), sells
// to Belgium without a tax, to Britain above the limit of a parcel (the buyer pays on receipt), moves
// the year of the threshold of Austria and puts Portugal in its group (its first sale by its own
// tax); a parcel to Britain by a carrier that takes no commercial invoice electronically leaves it to
// print, one to Norway goes with the number of its import scheme once root writes it again; a series
// starts every year. Root reads the report of
// the tax of the period and the alerts of the countries. Each step takes what its actor saw; the
// settings, the countries and the group are of the whole shop (*.shopwide.test.ts), taken away at the
// end. The moment of the receipts is written in the database: the server of the tests makes no
// receipts (RECEIPT_PROVIDER none), the worker is run with fiskaly

const harness = receiptHarness.fiskaly as ReceiptHarness;

let app: FastifyInstance;
let csrf: Csrf;
// the payment of each order, as the dashboard of Stripe shows it to the admins
const paymentOf: Record<number, string> = {};
// what waits for root is found in the list an alert of root names, narrowed to the order
const alerts = alertsOf({ app: () => app, csrf: () => csrf });
// the bank of a card sends a transfer back, and a bank opens a dispute: the mock only (the sandbox
// does it for the cards of its own only)
const mockOnly = realStripe ? it.skip : it;
let root: TestUser;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

// the series of the run: a number is taken once at fiskaly, in every run
const series = `F${randomBytes(3).toString('hex').toUpperCase()}`;

// what root writes before the countries: the mails, the seller, the series, the carriers (each
// after what it needs); the tax of the shop itself (vatPayer) needs the countries, it comes after
const SETTINGS: [string, unknown][] = [
  ['emailFromName', 'Cartlify'],
  ['emailReplyTo', 'support@shop.example.com'],
  ['sellerLegalName', harness.shop.sellerLegalName],
  ['sellerAddress', 'Calle de la Paz 1, 46003 Valencia'],
  ['sellerCountry', 'ES'],
  ['sellerTaxId', harness.shop.sellerTaxId],
  ['sellerTaxIdLabel', 'NIF'],
  ['invoicePrefix', series],
  ['creditNotePrefix', `${series}R`],
  ['invoiceYearly', false],
  ['invoiceMode', 'every_order'],
  ['deliverySender', SENDER],
  ['deliveryMethods', ['manual', 'carrier']],
];
const AFTER_COUNTRIES: [string, unknown][] = [['vatPayer', true]];

// root writes settings, each answered 200
async function writeSettings(values: [string, unknown][]) {
  for (const [key, value] of values) {
    const res = await send(root, 'PUT', `/api/root/shop-settings/${key}`, { value });
    expect({
      key,
      status: res.statusCode,
      body: res.statusCode === 200 ? null : res.json(),
    }).toEqual({
      key,
      status: 200,
      body: null,
    });
  }
}

// the sales of the period of a threshold are every sale to the country: Austria, where no other
// file sells; Ireland is written by its own step, later
const COUNTRIES = ['ES', 'AT', 'FR', 'GB', 'CH'];

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

const send = (
  actor: TestUser,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload: object = {},
) => app.inject({ method, url, headers: withCsrf(csrf, accessCookie(actor)), payload });

const get = (actor: TestUser, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

// what the database says of the time: the period of the report
const dbNow = () =>
  testTx(async (tx) => {
    const [row] = await tx.$queryRaw<{ now: Date }[]>`select now() as now`;
    return row!.now;
  });

const writeInDatabase = (key: string, value: unknown) =>
  testTx(async (tx) => {
    await setUserContext(tx, { userId: root.id, role: 'ROOT' });
    await tx.$executeRaw`insert into cartlify.shop_settings (key, value, "setById")
      values (${key}, ${JSON.stringify(value)}::jsonb, ${root.id})`;
  });

let from: Date;
let books: number;
let lamp: TestProduct;
let book: TestProduct;
let shirt: TestProduct;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT' });
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(root.id, admin.id);
  // a lamp and a shirt cross customs with their codes; the shirt goes by a carrier
  lamp = await createProduct({
    name: 'Desk lamp',
    price: 24.2,
    stock: 50,
    hsCode: '940520',
    originCountry: 'ES',
  });
  book = await createProduct({
    name: 'Cook book',
    price: 10.4,
    stock: 50,
    hsCode: '490199',
    originCountry: 'ES',
  });
  shirt = await createProduct({
    name: 'Cotton shirt',
    price: 30,
    stock: 50,
    ...SIZED,
    hsCode: '610510',
    originCountry: 'PT',
  });
  products.push(lamp, book, shirt);
  // the countries the server knows are the records of the database, as on a real server (the tests
  // start with records of their zone in the memory only)
  await loadShopCountries();
  from = await dbNow();
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    for (const country of [...COUNTRIES, 'IE', 'BE', 'PT', 'NO']) {
      await send(root, 'DELETE', `/api/root/countries/${country}`);
    }
    await asAdmin((tx) =>
      tx.product.updateMany({ where: { id: book.id }, data: { taxGroupId: null } }),
    );
    if (books) await send(root, 'DELETE', `/api/root/tax-groups/${books}`);
    await writeInDatabase('receiptMoment', null);
    for (const [key] of [...SETTINGS, ...AFTER_COUNTRIES, ['deliveryZones']].reverse()) {
      await send(root, 'PUT', `/api/root/shop-settings/${key}`, { value: null });
    }
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

// a country with every field: a zone of the delivery, no tax unless the fields say
const country = (fields: Record<string, unknown>) => ({
  customsFree: true,
  rule: null,
  registered: false,
  taxNumber: null,
  taxNumberLabel: null,
  taxNumberKind: null,
  parcelLimit: null,
  threshold: null,
  deliveryVat: null,
  exportPrice: null,
  exemptionText: null,
  rates: [],
  ...fields,
});

const ADDRESSES: Record<string, Record<string, string>> = {
  ES: { country: 'ES', postalCode: '28013', city: 'Madrid', street: 'Calle Mayor', house: '1' },
  AT: { country: 'AT', postalCode: '1010', city: 'Wien', street: 'Stephansplatz', house: '1' },
  FR: { country: 'FR', postalCode: '75001', city: 'Paris', street: 'Rue de Rivoli', house: '1' },
  GB: { country: 'GB', postalCode: 'E1 6AN', city: 'London', street: 'Test Street', house: '1' },
  CH: { country: 'CH', postalCode: '8001', city: 'Zurich', street: 'Bahnhofstrasse', house: '1' },
  BE: { country: 'BE', postalCode: '1000', city: 'Bruxelles', street: 'Rue Neuve', house: '1' },
  PT: { country: 'PT', postalCode: '1100-148', city: 'Lisboa', street: 'Rua Augusta', house: '1' },
  NO: { country: 'NO', postalCode: '0150', city: 'Oslo', street: 'Karl Johans gate', house: '1' },
  IE: {
    country: 'IE',
    postalCode: 'D02 X285',
    city: 'Dublin',
    street: 'Grafton Street',
    house: '1',
  },
};

type Option = {
  method: string;
  price: number;
  carrier: { name: string; service: string; connection: string } | null;
  tax: { refusal: { code: string } | null; total: number };
};

// a buyer fills a cart and reads the ways it goes to the address, with the tax of each
async function cartTo(buyer: TestUser, lines: [TestProduct, number][], to: string) {
  const headers = withCsrf(csrf, accessCookie(buyer));
  let orderId = 0;
  for (const [product, quantity] of lines) {
    const added = await app.inject({
      method: 'POST',
      url: '/api/orders/current/items',
      headers,
      payload: { variantId: product.variantId, quantity },
    });
    expect(added.statusCode).toBe(200);
    orderId = added.json().id;
  }
  const options = await app.inject({
    method: 'POST',
    url: '/api/orders/current/delivery-options',
    headers,
    payload: { address: ADDRESSES[to] },
  });
  expect(options.statusCode).toBe(200);
  return { orderId, options: options.json().options as Option[] };
}

// the buyer confirms the cart by the way picked and pays it on the page; null: paid, else the
// refusal of the confirmation
async function confirmAndPay(
  buyer: TestUser,
  firstName: string,
  orderId: number,
  to: string,
  option: Option,
  invoice = false,
): Promise<string | null> {
  const confirm = () =>
    send(buyer, 'POST', '/api/orders/current/confirm', {
      orderId,
      expectedDeliveryPrice: option.price,
      ...(invoice ? { invoice: true } : {}),
      delivery: {
        method: option.method,
        recipientFirstName: firstName,
        recipientLastName: 'Buyer',
        recipientPhone: '+34910000000',
        ...(option.method === 'pickup' ? {} : { address: ADDRESSES[to] }),
        ...(option.carrier ? { carrier: option.carrier } : {}),
      },
    });
  let confirmed = await confirm();
  // the shop has terms in force (published by a file of the whole shop): the buyer accepts the
  // versions the answer names and confirms again, as the page does
  if (confirmed.statusCode === 409 && confirmed.json().errorCode === 'LEGAL_ACCEPTANCE_REQUIRED') {
    const current = (confirmed.json().details?.current ?? []) as { id: number }[];
    const accepted = await send(buyer, 'POST', '/api/legal/acceptances', {
      documentIds: current.map((document) => document.id),
    });
    expect(accepted.statusCode).toBeLessThan(300);
    confirmed = await confirm();
  }
  if (confirmed.statusCode !== 200) return confirmed.json().errorCode as string;
  const { paymentId, event } = await payPage(await openPaymentPage(app, csrf, buyer, orderId));
  paymentOf[orderId] = paymentId;
  expect((await deliver(app, event)).statusCode).toBe(200);
  return null;
}

async function buys(
  name: string,
  lines: [TestProduct, number][],
  to: string,
  method: 'manual' | 'carrier' | 'pickup' = 'manual',
  invoice = false,
  carrier: string = CARRIERS.MockExpress.name,
) {
  const buyer = await createUser({ name });
  userIds.push(buyer.id);
  const firstName = name.split(' ')[0]!;
  const { orderId, options } = await cartTo(buyer, lines, to);
  const option = options.find(
    (one) => one.method === method && (method !== 'carrier' || one.carrier?.name === carrier),
  )!;
  expect(option).toBeDefined();
  const refusal = await confirmAndPay(buyer, firstName, orderId, to, option, invoice);
  return { buyer, orderId, option, refusal };
}

type Document = {
  id: number;
  kind: string;
  number: string | null;
  tax: number;
  gross: number;
  documentId: number | null;
  receipt: { state: string; number: string | null } | null;
};

const documentsOf = async (buyer: TestUser, orderId: number) => {
  const res = await get(buyer, `/api/orders/${orderId}/documents`);
  expect(res.statusCode).toBe(200);
  return res.json().items as Document[];
};

// the documents of the tax of an order as its buyer reads them, the receipts apart: [kind, gross, tax]
const taxDocumentsOf = async (buyer: TestUser, orderId: number) =>
  (await documentsOf(buyer, orderId))
    .filter((one) => one.kind === 'invoice' || one.kind === 'credit_note')
    .map((one) => [one.kind, one.gross, one.tax]);

// Stripe tells the app of an event of a refund or of a dispute
async function told(type: string, id: string) {
  const event = type.startsWith('charge.dispute.')
    ? await disputeEvent(type, id)
    : await stripeEvent(type as Stripe.Event.Type, id);
  expect((await deliver(app, event)).statusCode).toBe(200);
}

async function shipped(orderId: number) {
  const res = await send(admin, 'PATCH', `/api/orders/${orderId}/status`, { status: 'shipped' });
  expect(res.statusCode).toBe(200);
}

// the buyer withdraws from all of a sent order (the admin sends it first unless it went); the admin
// finds the statement by the code the mail of the buyer names
async function withdrawn(sale: { buyer: TestUser; orderId: number }, sent = false) {
  if (!sent) await shipped(sale.orderId);
  const mails = watchMail();
  const res = await send(sale.buyer, 'POST', `/api/orders/${sale.orderId}/withdrawal`);
  expect(res.statusCode).toBe(201);
  const notice = mailTo(mails, sale.buyer.email, `Withdrawal from order #${sale.orderId}`);
  const found = (await get(admin, `/api/returns?q=${statementCodeIn(notice)}`)).json().items;
  return { notice, returnId: found[0].id as number };
}

const statementCardOf = async (returnId: number) => {
  const res = await get(admin, `/api/returns/${returnId}`);
  expect(res.statusCode).toBe(200);
  return res.json();
};

// the admin takes the units of the row of the statement in, to the shelf or as they never came
async function received(returnId: number, quantity: number, goods = 'to_stock') {
  const [row] = (await statementCardOf(returnId)).items as { id: number }[];
  const res = await send(admin, 'POST', `/api/returns/${returnId}/receive`, {
    parcel: { buyerPaid: 0 },
    results: [{ itemId: row!.id, quantity, goods }],
  });
  expect(res.statusCode).toBe(200);
  return row!.id;
}

// the item of an order as root reads it in the card of the order
const itemOf = async (orderId: number) =>
  ((await get(root, `/api/orders/${orderId}`)).json().items as { id: number }[])[0]!.id;

// root says what money given back by hand or taken by a bank was for
async function decided(lineId: number, items: Record<string, unknown>[], note: string) {
  const res = await send(root, 'POST', `/api/payments/money-lines/${lineId}/decision`, {
    items,
    note,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

// root follows a kind of the alerts, with its numbers when it has them
async function follow(kind: string, value?: number, window?: number) {
  if (value !== undefined) {
    const set = await send(
      root,
      'PUT',
      `/api/admin/alerts/subscriptions/${kind}/threshold`,
      window === undefined ? { value } : { value, window },
    );
    expect(set.statusCode).toBe(200);
  }
  expect((await send(root, 'PUT', `/api/admin/alerts/subscriptions/${kind}`)).statusCode).toBe(200);
}

const alertOf = async (kind: string) =>
  (
    (await get(root, `/api/admin/alerts?kinds=${kind}`)).json().alerts as {
      kind: string;
      count: number;
    }[]
  )[0]!;

// root closes a kind that only informs: what it saw goes
async function closed(kind: string) {
  expect((await send(root, 'PUT', `/api/admin/alerts/seen/${kind}`)).statusCode).toBe(200);
}

// the worker sends the receipts of the orders until none waits (the tax authority of the test takes
// seconds to minutes; the mock registers by the next look)
async function receiptsSent(orderIds: number[]) {
  const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
  for (let round = 0; round < 60; round += 1) {
    await issuePendingReceipts(log as never, {
      orderIds,
      provider: harness.provider,
      dueBy: new Date(Date.now() + 10 * 60_000),
    });
    const waiting = await asAdmin((tx) =>
      tx.taxDocument.count({
        where: { orderId: { in: orderIds }, receiptState: 'pending' },
      }),
    );
    if (!waiting) return;
    if (realFiskaly) await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error('the receipts of the flow are still waiting');
}

const toBuyer = (mails: SentMail[], buyer: TestUser, words: string) =>
  mails.filter((mail) => mail.to.includes(buyer.email) && mail.subject.includes(words));

// what the flow made, step by step
const bought: Record<string, { buyer: TestUser; orderId: number }> = {};

describe('the taxes of a shop that sells to several countries', () => {
  it('root writes the seller, the documents, a tax group and the countries with their rules', async () => {
    await writeSettings(SETTINGS);
    // the shop sells to the five countries of the flow only: root takes away the other records (the
    // records of the zone of the tests; the next file writes them again, tests/helpers/app.ts)
    const known = (await get(root, '/api/root/countries')).json().items as { country: string }[];
    for (const { country: code } of known) {
      if (COUNTRIES.includes(code)) continue;
      expect((await send(root, 'DELETE', `/api/root/countries/${code}`)).statusCode).toBe(204);
    }
    const group = await send(root, 'POST', '/api/root/tax-groups', {
      name: 'Books of the flow',
      rates: {},
    });
    expect(group.statusCode).toBe(201);
    books = group.json().id;
    const grouped = await send(root, 'PATCH', '/api/products/tax', {
      scope: { productIds: [book.id] },
      taxGroupId: books,
    });
    expect(grouped.statusCode).toBe(200);

    const records: Record<string, object> = {
      ES: country({
        zone: { name: 'Spain', manualPrice: 5, freeFrom: null },
        rule: 'seller',
        deliveryVat: 'main',
        rates: [
          { group: null, rate: 21, from: null },
          { group: books, rate: 4, from: null },
        ],
      }),
      AT: country({
        zone: { name: 'Europe', manualPrice: 8, freeFrom: null },
        rule: 'recipient',
        registered: true,
        taxNumber: 'ATU12345678',
        taxNumberLabel: 'UID',
        taxNumberKind: 'other',
        threshold: {
          amount: 100,
          withVat: false,
          group: null,
          period: 'year',
          startMonth: null,
          nextCycle: 'recipient',
        },
        deliveryVat: 'main',
        rates: [
          { group: null, rate: 20, from: null },
          { group: null, rate: 21, from: inDays(3) },
          { group: books, rate: 10, from: null },
        ],
      }),
      FR: country({
        zone: { name: 'Europe', manualPrice: 8, freeFrom: null },
        rule: 'recipient',
        threshold: {
          amount: 30,
          withVat: false,
          group: null,
          period: 'year',
          startMonth: null,
          nextCycle: 'recipient',
        },
        deliveryVat: 'main',
        rates: [
          { group: null, rate: 20, from: null },
          { group: books, rate: 5.5, from: null },
        ],
      }),
      GB: country({
        zone: { name: 'World', manualPrice: 15, freeFrom: null },
        customsFree: false,
        rule: 'recipient',
        registered: true,
        taxNumber: 'GB123456789',
        taxNumberLabel: 'UK VAT',
        taxNumberKind: 'other',
        parcelLimit: { amount: 135, withDelivery: false, withVat: false },
        deliveryVat: 'main',
        exportPrice: 'same',
        exemptionText: 'Export outside the customs union',
        rates: [
          { group: null, rate: 20, from: null },
          { group: books, rate: 0, from: null },
        ],
      }),
      CH: country({
        zone: { name: 'World', manualPrice: 15, freeFrom: null },
        customsFree: false,
        rule: 'buyer_at_receipt',
        deliveryVat: 'main',
        exportPrice: 'without_seller_vat',
        exemptionText: 'Export outside the customs union',
      }),
    };
    for (const code of COUNTRIES) {
      const res = await send(root, 'PUT', `/api/root/countries/${code}`, records[code]!);
      expect({
        code,
        status: res.statusCode,
        body: res.statusCode === 200 ? null : res.json(),
      }).toEqual({
        code,
        status: 200,
        body: null,
      });
    }
    // the shop takes the tax of Spain, with every country written
    await writeSettings(AFTER_COUNTRIES);
    // the shop registers the receipt of a sale at the payment (written in the database, above)
    await writeInDatabase('receiptMoment', 'payment');
  });

  it('sells in Spain and in Austria below its threshold by the tax of Spain, past it by the tax of Austria, and stops in France', async () => {
    // Spain: the lamp at 21 %, the book of the group at 4 %, the delivery at the main rate
    const spain = await buys(
      'Ana Garcia',
      [
        [lamp, 1],
        [book, 1],
      ],
      'ES',
    );
    expect(spain.refusal).toBeNull();
    // Austria below the threshold: the tax of Spain
    const below = await buys('Ben Gruber', [[lamp, 1]], 'AT');
    expect(below.refusal).toBeNull();
    // Austria past the threshold with this order: the tax of Austria
    const past = await buys('Clara Gruber', [[lamp, 4]], 'AT');
    expect(past.refusal).toBeNull();
    // France past its threshold, the shop not registered there: the buyer reads the refusal in the
    // ways and does not get past the confirmation
    const dana = await createUser({ name: 'Dana Martin' });
    userIds.push(dana.id);
    const france = await cartTo(dana, [[lamp, 2]], 'FR');
    const manual = france.options.find((one) => one.method === 'manual')!;
    expect(manual.tax.refusal).toEqual({ code: 'TAX_SALES_STOPPED' });
    expect(await confirmAndPay(dana, 'Dana', france.orderId, 'FR', manual)).toBe(
      'TAX_SALES_STOPPED',
    );

    bought.spain = spain;
    bought.below = below;
    bought.past = past;

    const [spainInvoice] = await documentsOf(spain.buyer, spain.orderId);
    const [belowInvoice] = await documentsOf(below.buyer, below.orderId);
    const [pastInvoice] = await documentsOf(past.buyer, past.orderId);
    // 4.20 of the lamp, 0.40 of the book, 0.87 of the delivery of 5
    expect(spainInvoice).toMatchObject({ kind: 'invoice', tax: 5.47, gross: 39.6 });
    // 4.20 of the lamp, 1.39 of the delivery of 8 at 21 %
    expect(belowInvoice).toMatchObject({ kind: 'invoice', tax: 5.59, gross: 32.2 });
    // 16.13 of the four lamps, 1.33 of the delivery at 20 %
    expect(pastInvoice).toMatchObject({ kind: 'invoice', tax: 17.46, gross: 104.8 });
  });

  it('sends a parcel to Britain with the number of the shop on the commercial invoice of the order, and sells to Switzerland without the tax', async () => {
    const britain = await buys('Eve Smith', [[shirt, 2]], 'GB', 'carrier');
    expect(britain.refusal).toBeNull();
    const switzerland = await buys('Finn Keller', [[lamp, 1]], 'CH');
    expect(switzerland.refusal).toBeNull();
    bought.britain = britain;
    bought.switzerland = switzerland;

    // the invoice the buyer in Britain sees
    const [invoice] = await documentsOf(britain.buyer, britain.orderId);
    // 10 of the shirts at 20 %, 1.08 of the delivery of 6.50
    expect(invoice).toMatchObject({ kind: 'invoice', tax: 11.08, gross: 66.5 });

    // the admin finds the paid order and makes its parcel; the carrier takes the commercial invoice
    // electronically, with the number of the shop in Britain and the number of the invoice of the order
    const calls = watchShippyPro();
    const made = await send(admin, 'POST', `/api/orders/${britain.orderId}/parcels`);
    expect(made.statusCode).toBe(200);
    expect(made.json().order.shipments).toMatchObject([{ customsInvoice: 'electronic' }]);
    const sent = calls.find((call) => call.method === 'CreateCrossBorderInvoice');
    expect(sent?.params).toMatchObject({
      InvoiceNumber: invoice!.number,
      ShipperExporter: { VatNumber: 'GB123456789' },
      TotalGst: 10,
    });

    // Switzerland: the price without the tax of Spain, the buyer pays the tax on receipt
    const [swiss] = await documentsOf(switzerland.buyer, switzerland.orderId);
    const order = (await get(switzerland.buyer, `/api/orders/${switzerland.orderId}`)).json();
    expect(swiss).toMatchObject({ kind: 'invoice', tax: 0, gross: Number(order.total) });
  });

  it(
    'registers a receipt of each sale and mails it, and a credit note with its receipt for a compensation',
    async () => {
      const orderIds = Object.values(bought).map((one) => one.orderId);
      const mails = watchMail();
      await receiptsSent(orderIds);

      for (const { buyer, orderId } of Object.values(bought)) {
        const documents = await documentsOf(buyer, orderId);
        const receipt = documents.find((one) => one.kind === 'receipt');
        expect(receipt).toMatchObject({
          documentId: documents.find((one) => one.kind === 'invoice')!.id,
          receipt: { state: 'registered', number: expect.any(String) },
        });
        expect(toBuyer(mails, buyer, `Your receipt for order #${orderId}`)).toHaveLength(1);
      }

      // root gives the buyer in Spain 5 back for a lamp that came scratched
      const { buyer, orderId } = bought.spain!;
      const given = await send(root, 'POST', '/api/payments/compensations', {
        orderId,
        amount: 5,
        note: 'The lamp came scratched.',
      });
      expect(given.statusCode).toBe(200);
      expect(given.json()).toMatchObject({ state: 'sent', amount: 5 });

      await receiptsSent([orderId]);
      const documents = await documentsOf(buyer, orderId);
      const invoice = documents.find((one) => one.kind === 'invoice')!;
      const credit = documents.find((one) => one.kind === 'credit_note');
      expect(credit).toMatchObject({
        gross: -5,
        number: expect.stringMatching(new RegExp(`^${series}R-`)),
      });
      expect(documents.find((one) => one.kind === 'return_receipt')).toMatchObject({
        documentId: credit!.id,
        receipt: { state: 'registered' },
      });
      expect(invoice.gross).toBe(39.6);
      expect(toBuyer(mails, buyer, `Your return receipt for order #${orderId}`)).toHaveLength(1);
    },
    realFiskaly ? fiskalyWait : undefined,
  );

  // all of a sent order comes back: the transfer of the statement gives a credit note of all of the
  // tax of the invoice; the bank of the card sends the money back and an invoice reverses it; root
  // sends the money by a bank transfer and that has a credit note of its own
  mockOnly(
    'gives back the tax of a return by Stripe, reverses it when the bank of the card sends the money back, and gives it back again for the money sent another way',
    async () => {
      const sale = await buys('Gema Lopez', [[lamp, 2]], 'ES');
      expect(sale.refusal).toBeNull();
      bought.returned = sale;
      const { returnId } = await withdrawn(sale);
      await received(returnId, 2);
      const went = await send(admin, 'POST', `/api/returns/${returnId}/refund`);
      expect(went.statusCode).toBe(200);
      // 8.40 of the two lamps and 0.87 of the delivery of 5 the withdrawal gives back with them
      const sold = ['invoice', 53.4, 9.27];
      expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([
        sold,
        ['credit_note', -53.4, -9.27],
      ]);

      // the card of the statement names the transfer with the id Stripe gave; the bank sends it back
      const card = went.json();
      const transfer = [...card.money]
        .reverse()
        .find(
          (move: { part: string; itemIds: number[] }) =>
            move.part === 'goods' && move.itemIds.includes(card.items[0].id),
        );
      await refundBecomes(transfer.refundId, {
        status: 'failed',
        reason: 'expired_or_canceled_card',
      });
      await told('refund.failed', transfer.refundId);
      expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([
        sold,
        ['credit_note', -53.4, -9.27],
        ['invoice', 53.4, 9.27],
      ]);

      // root sends the money by a bank transfer to the account the buyer wrote
      const failed = await statementCardOf(returnId);
      const outside = await send(root, 'POST', `/api/returns/${returnId}/refund/outside`, {
        itemIds: [failed.items[0].id],
        method: 'bank_transfer',
        note: 'To the account the buyer wrote by mail.',
        at: failed.statedAt,
      });
      expect(outside.statusCode).toBe(200);
      expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([
        sold,
        ['credit_note', -53.4, -9.27],
        ['invoice', 53.4, 9.27],
        ['credit_note', -53.4, -9.27],
      ]);
    },
  );

  // an admin gives 10 back by hand in the dashboard of Stripe: no document while nobody knows what for;
  // root takes it for a gesture (a credit note by what each line has left), then sees it was for a
  // lamp (an invoice reverses the first, a credit note of the lamp); the buyer sends both lamps back,
  // the statement takes the 10 first and the transfer of the rest has the credit note of the rest
  // only. The buyer finds the documents in the export of their data
  it('gives no document for money given back by hand until root says what it was for, reverses a decision made again, and the transfer of a later return gives the tax of the rest only', async () => {
    const sale = await buys('Hugo Diaz', [[lamp, 2]], 'ES');
    expect(sale.refusal).toBeNull();
    bought.byHand = sale;
    await shipped(sale.orderId);
    const byHand = await refundAtStripe(paymentOf[sale.orderId]!, { amount: 1000 });
    await told('refund.created', byHand.id);
    const sold = ['invoice', 53.4, 9.27];
    expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([sold]);

    const [line] = (await alerts.listOf(root, 'hand_refunds_to_explain', { orderId: sale.orderId }))
      .items as unknown as { id: number }[];
    expect(await decided(line!.id, [], 'A gesture for the parcel that came late.')).toMatchObject({
      use: 'compensation',
    });
    const gesture = (await taxDocumentsOf(sale.buyer, sale.orderId))[1]!;
    expect(gesture).toEqual(['credit_note', -10, expect.any(Number)]);

    const withdrawal = await withdrawn(sale, true);
    const item = await itemOf(sale.orderId);
    expect(
      await decided(
        line!.id,
        [{ orderItemId: item, quantity: 1, amount: 10 }],
        'It was for the scratched lamp.',
      ),
    ).toMatchObject({ use: 'goods' });
    // 10 of a lamp at 21 %
    expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([
      sold,
      gesture,
      ['invoice', 10, -(gesture[2] as number)],
      ['credit_note', -10, -1.74],
    ]);

    await received(withdrawal.returnId, 2);
    const went = await send(admin, 'POST', `/api/returns/${withdrawal.returnId}/refund`);
    expect(went.json()).toMatchObject({ refundedTotal: 53.4, closedAt: expect.any(String) });
    // the rest of the order: 43.40 with 7.53 of its tax; all of the order went back, its documents
    // hold nothing together
    const documents = await taxDocumentsOf(sale.buyer, sale.orderId);
    expect(documents.slice(4)).toEqual([['credit_note', -43.4, -7.53]]);
    const together = (index: number) =>
      Math.abs(Math.round(documents.reduce((sum, one) => sum + Number(one[index]), 0) * 100) / 100);
    expect([together(1), together(2)]).toEqual([0, 0]);

    // the buyer exports their data: the invoices and the credit notes of the order, by their numbers
    const exported = await get(sale.buyer, '/api/users/me/export');
    expect(exported.statusCode).toBe(200);
    const numbers = (await documentsOf(sale.buyer, sale.orderId))
      .filter((one) => one.kind === 'invoice' || one.kind === 'credit_note')
      .map((one) => one.number);
    expect(
      (exported.json().taxDocuments as { orderId: number; kind: string; number: string | null }[])
        .filter((one) => one.orderId === sale.orderId && one.number !== null)
        .map((one) => one.number)
        .sort(),
    ).toEqual([...numbers].sort());
  });

  // a bank takes the money of an order not sent for a dispute: no document while it is open; the
  // shop loses it and the system decides it was all of the order, a credit note of all of its tax
  mockOnly(
    'gives back all of the tax of an order not sent once the shop lost its dispute',
    async () => {
      const sale = await buys('Ines Ruiz', [[lamp, 1]], 'ES');
      expect(sale.refusal).toBeNull();
      bought.lostUnsent = sale;
      const paymentId = paymentOf[sale.orderId]!;
      const disputeId = openDispute(paymentId);
      await told('charge.dispute.created', disputeId);
      await told('charge.dispute.funds_withdrawn', disputeId);
      // 4.20 of the lamp, 0.87 of the delivery
      const sold = ['invoice', 29.2, 5.07];
      expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([sold]);

      await closeDispute(paymentId, 'lost');
      await told('charge.dispute.updated', disputeId);
      await told('charge.dispute.closed', disputeId);
      expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([
        sold,
        ['credit_note', -29.2, -5.07],
      ]);
    },
  );

  // a bank takes 20 of a sent order for a dispute and the shop loses it; root says 10 were for a lamp
  // the buyer sent back by the post, the rest a loss: a credit note of the lamp only
  mockOnly(
    'gives back the tax of the part of a lost dispute root gives to a lamp, and none of the loss',
    async () => {
      const sale = await buys('Jorge Ruiz', [[lamp, 2]], 'ES');
      expect(sale.refusal).toBeNull();
      bought.lostSent = sale;
      await shipped(sale.orderId);
      const paymentId = paymentOf[sale.orderId]!;
      const disputeId = openDispute(paymentId, { amount: 2000 });
      await told('charge.dispute.created', disputeId);
      await told('charge.dispute.funds_withdrawn', disputeId);
      await closeDispute(paymentId, 'lost');
      await told('charge.dispute.updated', disputeId);
      await told('charge.dispute.closed', disputeId);
      const sold = ['invoice', 53.4, 9.27];
      expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([sold]);

      const [dispute] = (await alerts.listOf(root, 'disputes_lost', { orderId: sale.orderId }))
        .items as unknown as { id: number }[];
      const card = (await get(admin, `/api/payments/disputes/${dispute!.id}`)).json();
      const item = await itemOf(sale.orderId);
      expect(
        await decided(
          card.money[0].id,
          [{ orderItemId: item, quantity: 1, amount: 10 }],
          'One lamp came back by the post; the rest is lost.',
        ),
      ).toMatchObject({ use: 'loss', distributed: '10.00', rest: '10.00' });
      expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([
        sold,
        ['credit_note', -10, -1.74],
      ]);
    },
  );

  // the shop sends the money of a withdrawal ahead of its parcel (a credit note), the parcel never
  // comes and the buyer pays the lamp back by a bank transfer: an invoice reverses the share of the
  // lamp
  it('reverses the tax of the money the buyer gives back of a parcel that never came', async () => {
    const sale = await buys('Karla Ruiz', [[lamp, 1]], 'ES');
    expect(sale.refusal).toBeNull();
    bought.ahead = sale;
    const { notice, returnId } = await withdrawn(sale);
    const link = withdrawalLinkIn(notice);
    const proof = await app.inject({
      method: 'POST',
      url: '/api/withdrawals/proof',
      headers: withCsrf(csrf),
      payload: {
        orderId: link.orderId,
        code: link.code,
        returnId: link.returnId,
        carrier: 'DHL',
        trackingNumber: `JD${link.returnId}`,
      },
    });
    expect(proof.statusCode).toBe(200);
    expect(
      (await send(admin, 'POST', `/api/returns/${returnId}/proof/confirm`, { buyerPaid: 0 }))
        .statusCode,
    ).toBe(200);
    expect((await send(admin, 'POST', `/api/returns/${returnId}/refund`)).statusCode).toBe(200);
    const rowId = await received(returnId, 1, 'not_arrived');

    const back = await send(root, 'POST', `/api/returns/${returnId}/money-received`, {
      items: [{ itemId: rowId, amount: 24.2 }],
      method: 'bank_transfer',
      note: 'The buyer paid back the lamp of the parcel that never came.',
      at: (await dbNow()).toISOString(),
    });
    expect(back.statusCode).toBe(200);
    // the lamp: 24.20 with 4.20 of the tax; the delivery stays given back
    expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([
      ['invoice', 29.2, 5.07],
      ['credit_note', -29.2, -5.07],
      ['invoice', 24.2, 4.2],
    ]);
  });

  // the 10 given back by hand pay one of the two lamps a later return takes; the bank of the card
  // sends the transfer of the rest back: an invoice reverses that transfer only, the lamp the money
  // already with the buyer paid stays given back
  mockOnly(
    'reverses only the transfer of the rest of a statement the money given back by hand paid in part, when the bank sends it back',
    async () => {
      const sale = await buys('Pau Ruiz', [[lamp, 2]], 'ES');
      expect(sale.refusal).toBeNull();
      bought.partFailed = sale;
      await shipped(sale.orderId);
      const byHand = await refundAtStripe(paymentOf[sale.orderId]!, { amount: 1000 });
      await told('refund.created', byHand.id);
      const [line] = (
        await alerts.listOf(root, 'hand_refunds_to_explain', { orderId: sale.orderId })
      ).items as unknown as { id: number }[];
      await decided(
        line!.id,
        [{ orderItemId: await itemOf(sale.orderId), quantity: 1, amount: 10 }],
        'Paid back for the scratched lamp.',
      );

      const { returnId } = await withdrawn(sale, true);
      await received(returnId, 2);
      const went = await send(admin, 'POST', `/api/returns/${returnId}/refund`);
      expect(went.statusCode).toBe(200);
      const card = went.json();
      const transfer = [...card.money]
        .reverse()
        .find(
          (move: { part: string; itemIds: number[] }) =>
            move.part === 'goods' && move.itemIds.includes(card.items[0].id),
        );
      await refundBecomes(transfer.refundId, {
        status: 'failed',
        reason: 'expired_or_canceled_card',
      });
      await told('refund.failed', transfer.refundId);

      expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([
        ['invoice', 53.4, 9.27],
        ['credit_note', -10, -1.74],
        ['credit_note', -43.4, -7.53],
        ['invoice', 43.4, 7.53],
      ]);
      // the statement keeps what the money already with the buyer paid
      expect((await statementCardOf(returnId)).refundedTotal).toBe(10);
    },
  );

  // an admin gave 10 back by hand, which root says was for a lamp that came scratched (a credit
  // note); the buyer withdraws from a lamp and the admin sends its money ahead of the parcel (a
  // credit note), and the lamp that comes is the scratched one: the 10 the buyer had for it are a
  // loss of the shop, so an invoice reverses the credit note of the decision and none is given anew
  mockOnly(
    'reverses the tax of the money given back by hand for a lamp a transfer ahead of it paid too',
    async () => {
      const sale = await buys('Quim Ruiz', [[lamp, 2]], 'ES');
      expect(sale.refusal).toBeNull();
      bought.paidTwice = sale;
      await shipped(sale.orderId);
      const byHand = await refundAtStripe(paymentOf[sale.orderId]!, { amount: 1000 });
      await told('refund.created', byHand.id);
      const [line] = (
        await alerts.listOf(root, 'hand_refunds_to_explain', { orderId: sale.orderId })
      ).items as unknown as { id: number }[];
      await decided(
        line!.id,
        [{ orderItemId: await itemOf(sale.orderId), quantity: 1, amount: 10 }],
        'A lamp came scratched: 10 off.',
      );

      // the buyer withdraws from one lamp on the page of the order
      const mails = watchMail();
      const [free] = (await get(sale.buyer, `/api/orders/${sale.orderId}`)).json().withdrawable;
      const made = await send(sale.buyer, 'POST', `/api/orders/${sale.orderId}/withdrawal`, {
        items: [{ orderItemId: free.orderItemId, quantity: 1 }],
      });
      expect(made.statusCode).toBe(201);
      const notice = mailTo(mails, sale.buyer.email, `Withdrawal from order #${sale.orderId}`);
      const [found] = (await get(admin, `/api/returns?q=${statementCodeIn(notice)}`)).json().items;
      const returnId = found.id as number;
      const [row] = (await statementCardOf(returnId)).items as { id: number }[];
      expect(
        (await send(admin, 'POST', `/api/returns/${returnId}/proof/confirm`, { buyerPaid: 0 }))
          .statusCode,
      ).toBe(200);
      expect((await send(admin, 'POST', `/api/returns/${returnId}/refund`)).statusCode).toBe(200);
      const came = await send(admin, 'POST', `/api/returns/${returnId}/receive`, {
        results: [{ itemId: row!.id, quantity: 1, goods: 'written_off', paidUnits: 1 }],
      });
      expect(came.statusCode).toBe(200);

      expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([
        ['invoice', 53.4, 9.27],
        ['credit_note', -10, -1.74],
        ['credit_note', -24.2, -4.2],
        ['invoice', 10, 1.74],
      ]);
    },
  );

  // the worker registers the receipts of the documents of the money that went back: the credit
  // notes and the invoices that reverse them correct the receipt of the sale
  it(
    'registers a receipt of each document of the money that went back',
    async () => {
      const sales = [
        'returned',
        'byHand',
        'lostUnsent',
        'lostSent',
        'ahead',
        'partFailed',
        'paidTwice',
      ].flatMap((name) => (bought[name] ? [bought[name]!] : []));
      await receiptsSent(sales.map((one) => one.orderId));
      for (const { buyer, orderId } of sales) {
        const documents = await documentsOf(buyer, orderId);
        const ofMoney = documents.filter(
          (one) => one.kind === 'invoice' || one.kind === 'credit_note',
        );
        expect(ofMoney.length).toBeGreaterThan(1);
        for (const document of ofMoney) {
          expect(documents.find((one) => one.documentId === document.id)).toMatchObject({
            receipt: { state: 'registered' },
          });
        }
      }
    },
    realFiskaly ? fiskalyWait : undefined,
  );

  // the tax authority refuses the receipt of a sale: root follows the refused receipts, finds the
  // order in the list of the alert, registers the receipt by hand and confirms it with its number.
  // Only the mock refuses on request
  (harness.refuseNext ? it : it.skip)(
    'lets root register by hand a receipt the tax authority refused, found by its alert',
    async () => {
      const sale = await buys('Lola Ruiz', [[book, 1]], 'ES');
      expect(sale.refusal).toBeNull();
      bought.refusedReceipt = sale;
      harness.refuseNext!();
      await receiptsSent([sale.orderId]);

      expect(
        (await send(root, 'PUT', '/api/admin/alerts/subscriptions/receipts_refused')).statusCode,
      ).toBe(200);
      expect(await alerts.idsOf(root, 'receipts_refused', { userId: sale.buyer.id })).toEqual([
        sale.orderId,
      ]);
      const receipt = (await documentsOf(root, sale.orderId)).find(
        (one) => one.kind === 'receipt',
      )!;
      expect(receipt.receipt).toMatchObject({ state: 'refused' });
      const byHand = await send(
        root,
        'POST',
        `/api/orders/${sale.orderId}/documents/${receipt.id}/receipt-confirmation`,
        { number: 'VF-HAND-1' },
      );
      expect(byHand.statusCode).toBe(200);
      expect(
        (await documentsOf(sale.buyer, sale.orderId)).find((one) => one.kind === 'receipt'),
      ).toMatchObject({ receipt: { state: 'manual', number: 'VF-HAND-1' } });
      expect(await alerts.idsOf(root, 'receipts_refused', { userId: sale.buyer.id })).toEqual([]);
    },
  );

  it('gives root the tax of the period by rule, country and rate as the documents hold it, and the alerts of the countries', async () => {
    const to = await dbNow();
    const report = await get(
      root,
      `/api/admin/reports/vat?from=${from.toISOString()}&to=${to.toISOString()}`,
    );
    expect(report.statusCode).toBe(200);

    // the tax the documents of the buyers hold, together
    let documentsTax = 0;
    for (const { buyer, orderId } of Object.values(bought)) {
      for (const document of await documentsOf(buyer, orderId)) {
        if (document.kind === 'invoice' || document.kind === 'credit_note')
          documentsTax += document.tax;
      }
    }
    const total = report.json().total as {
      rule: string | null;
      country: string | null;
      taxNumber: string | null;
      rate: number | null;
      tax: number;
    }[];
    const sum = Math.round(total.reduce((acc, row) => acc + row.tax, 0) * 100) / 100;
    expect(sum).toBe(Math.round(documentsTax * 100) / 100);
    expect(total).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'seller', country: 'ES', rate: 21 }),
        expect.objectContaining({ rule: 'seller', country: 'ES', rate: 4 }),
        expect.objectContaining({
          rule: 'recipient',
          country: 'AT',
          rate: 20,
          taxNumber: 'ATU12345678',
        }),
        expect.objectContaining({
          rule: 'recipient',
          country: 'GB',
          rate: 20,
          taxNumber: 'GB123456789',
        }),
        expect.objectContaining({ rule: 'buyer_at_receipt', country: 'CH', tax: 0 }),
      ]),
    );

    // root follows the alerts of the countries: Austria passed its threshold, the sales to France
    // stopped, the rate of Austria starts within the week
    await follow('tax_threshold_passed');
    await follow('tax_sales_stopped');
    await follow('tax_rate_soon', 7);
    expect((await alertOf('tax_threshold_passed')).count).toBe(1);
    expect((await alertOf('tax_sales_stopped')).count).toBe(1);
    expect((await alertOf('tax_rate_soon')).count).toBe(1);

    // root reads of the rate and closes it
    expect((await send(root, 'PUT', '/api/admin/alerts/seen/tax_rate_soon')).statusCode).toBe(200);
    expect((await alertOf('tax_rate_soon')).count).toBe(0);
  });

  // a threshold over the last 12 months (Ireland, where no other file sells): the sale that passes it
  // takes the tax of Ireland and so does every later one whatever the sum; root sees that it holds,
  // writes a higher sum, is told the sales fell below it and goes back to the first rule
  it('holds the tax of Ireland over the last 12 months from the sale that passed its threshold, until root goes back to the first rule', async () => {
    // the receipts of the flow are done: the server of the tests makes none, so the moment written
    // in the database goes before root writes the data of the shop again
    await writeInDatabase('receiptMoment', null);
    const threshold = {
      amount: 30,
      withVat: false,
      group: null,
      period: 'rolling_12',
      startMonth: null,
      nextCycle: 'recipient',
    };
    const ireland = (set: Record<string, unknown>) =>
      country({
        zone: { name: 'Europe', manualPrice: 8, freeFrom: null },
        rule: 'recipient',
        registered: true,
        taxNumber: 'IE1234567T',
        taxNumberLabel: 'VAT',
        taxNumberKind: 'other',
        threshold,
        deliveryVat: 'main',
        rates: [
          { group: null, rate: 23, from: null },
          { group: books, rate: 0, from: null },
        ],
        ...set,
      });
    const record = async () => (await get(root, '/api/root/countries/IE')).json();
    expect((await send(root, 'PUT', '/api/root/countries/IE', ireland({}))).statusCode).toBe(200);

    // root follows the thresholds that reach half of their sum
    await follow('tax_threshold_near', 50);
    // 26.61 of a lamp without its tax is below 30: the tax of Spain, and the threshold is near
    const first = await buys('Eoin Byrne', [[lamp, 1]], 'IE');
    const near = (await alertOf('tax_threshold_near')).count;
    // with this one the last 12 months pass 30: the tax of Ireland, and it holds from now on
    const second = await buys('Niamh Byrne', [[lamp, 1]], 'IE');
    expect([near, (await alertOf('tax_threshold_near')).count]).toEqual([1, 0]);
    expect([first.refusal, second.refusal]).toEqual([null, null]);
    const [firstInvoice] = await documentsOf(first.buyer, first.orderId);
    const [secondInvoice] = await documentsOf(second.buyer, second.orderId);
    // 4.20 of the lamp, 1.39 of the delivery of 8 at 21 %; 4.53 and 1.50 at 23 %
    expect(firstInvoice).toMatchObject({ kind: 'invoice', tax: 5.59, gross: 32.2 });
    expect(secondInvoice).toMatchObject({ kind: 'invoice', tax: 6.03, gross: 32.2 });
    expect((await record()).threshold).toMatchObject({ period: 'rolling_12', held: true });

    // root writes a sum the sales are far from: the tax of Ireland holds, the alert tells it
    expect(
      (
        await send(
          root,
          'PUT',
          '/api/root/countries/IE',
          ireland({ threshold: { ...threshold, amount: 1000 } }),
        )
      ).statusCode,
    ).toBe(200);
    expect(
      (await send(root, 'PUT', '/api/admin/alerts/subscriptions/tax_threshold_dropped')).statusCode,
    ).toBe(200);
    const dropped = (await get(root, '/api/admin/alerts?kinds=tax_threshold_dropped')).json()
      .alerts as { count: number }[];
    expect(dropped[0]!.count).toBe(1);
    const third = await buys('Aoife Byrne', [[lamp, 1]], 'IE');
    const [thirdInvoice] = await documentsOf(third.buyer, third.orderId);
    expect(thirdInvoice).toMatchObject({ tax: 6.03 });

    // root goes back to the first rule: the tax of Spain until the sales pass 1000
    expect(
      (
        await send(
          root,
          'PUT',
          '/api/root/countries/IE',
          ireland({ threshold: { ...threshold, amount: 1000, nextCycle: 'initial' } }),
        )
      ).statusCode,
    ).toBe(200);
    expect((await record()).threshold).toMatchObject({ held: false });
    const fourth = await buys('Ciara Byrne', [[lamp, 1]], 'IE');
    const [fourthInvoice] = await documentsOf(fourth.buyer, fourth.orderId);
    expect(fourthInvoice).toMatchObject({ tax: 5.59 });
    expect(
      (
        (await get(root, '/api/admin/alerts?kinds=tax_threshold_dropped')).json().alerts as {
          count: number;
        }[]
      )[0]!.count,
    ).toBe(0);
  });

  // Austria passed its threshold this year: the next year starts with the tax of Austria unless root
  // says the first rule (the law of the EU: this year or the year before)
  it('lets root start the next year of Austria with the first rule, and back', async () => {
    const kept = (await get(root, '/api/root/countries/AT')).json();
    const { country: _country, createdAt: _c, updatedAt: _u, ...body } = kept;
    const { cycleFrom: _f, nextCycleFrom: _n, held: _h, ...threshold } = body.threshold;
    expect(threshold.nextCycle).toBe('recipient');

    const initial = await send(root, 'PUT', '/api/root/countries/AT', {
      ...body,
      threshold: { ...threshold, nextCycle: 'initial' },
    });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().threshold).toMatchObject({
      nextCycle: 'initial',
      nextCycleFrom: kept.threshold.nextCycleFrom,
    });
    const back = await send(root, 'PUT', '/api/root/countries/AT', {
      ...body,
      threshold: { ...threshold, nextCycle: 'recipient' },
    });
    expect(back.json().threshold).toMatchObject({ nextCycle: 'recipient' });
  });

  // the shop opens a pickup in Vienna: a buyer whose address is in France (where the sales stopped)
  // collects the order there, by the tax of Austria
  it('takes the tax of the place of a pickup, not of the address of the buyer', async () => {
    await writeSettings([
      ['pickupAddress', 'Stephansplatz 1, 1010 Wien'],
      ['pickupHours', 'Mon-Fri 09:00-18:00'],
      ['pickupCountry', 'AT'],
      ['deliveryMethods', ['manual', 'carrier', 'pickup']],
    ]);
    const sale = await buys('Marie Martin', [[lamp, 1]], 'FR', 'pickup');
    await writeSettings([
      ['deliveryMethods', ['manual', 'carrier']],
      ['pickupCountry', null],
      ['pickupHours', null],
      ['pickupAddress', null],
    ]);

    expect(sale.refusal).toBeNull();
    // 24.20 of the lamp at the 20 % of Austria, nothing to pay for the delivery
    expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([['invoice', 24.2, 4.03]]);
  });

  // root sells to Belgium without a tax (the rule none) at the price without the tax of Spain: the
  // invoice holds no tax
  it('sells to a country of the rule none without a tax', async () => {
    const belgium = await send(
      root,
      'PUT',
      '/api/root/countries/BE',
      country({
        zone: { name: 'Europe', manualPrice: 8, freeFrom: null },
        rule: 'none',
        deliveryVat: 'main',
        exportPrice: 'without_seller_vat',
        exemptionText: 'Not subject to the tax',
      }),
    );
    expect(belgium.statusCode).toBe(200);
    const sale = await buys('Lucas Peeters', [[lamp, 1]], 'BE');
    expect(sale.refusal).toBeNull();
    // 20.00 of the lamp and 6.61 of the delivery of 8, both without the 21 % of Spain
    expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([['invoice', 26.61, 0]]);
  });

  // six shirts to Britain are above the limit of a parcel there (135 without the tax): the shop takes
  // no tax of Britain, the buyer pays it on receipt
  it('leaves the tax of a parcel to Britain above its limit to the buyer on receipt', async () => {
    const sale = await buys('Jack Smith', [[shirt, 6]], 'GB');
    expect(sale.refusal).toBeNull();
    // 180 of the shirts at the same price, 15 of the delivery
    expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([['invoice', 195, 0]]);
  });

  // the tax year of Austria starts next month: the sales of its year are counted from the 1st of
  // that month a year ago, so the threshold stays passed and the tax of Austria stays
  it('counts the year of the threshold of Austria from the month root writes', async () => {
    const kept = (await get(root, '/api/root/countries/AT')).json();
    const { country: _country, createdAt: _c, updatedAt: _u, ...body } = kept;
    const { cycleFrom: _f, nextCycleFrom: _n, held: _h, ...threshold } = body.threshold;
    const startMonth = ((new Date().getUTCMonth() + 1) % 12) + 1;
    const moved = await send(root, 'PUT', '/api/root/countries/AT', {
      ...body,
      threshold: { ...threshold, startMonth },
    });
    expect(moved.statusCode).toBe(200);
    const cycle = moved.json().threshold as { cycleFrom: string; nextCycleFrom: string };
    const now = Date.now();
    const days = (from: string, to: string) =>
      Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
    expect(Date.parse(cycle.cycleFrom)).toBeLessThan(now);
    expect(Date.parse(cycle.nextCycleFrom) - now).toBeLessThanOrEqual(32 * 86_400_000);
    expect([365, 366]).toContain(days(cycle.cycleFrom, cycle.nextCycleFrom));

    const sale = await buys('Lena Gruber', [[lamp, 1]], 'AT');
    expect(sale.refusal).toBeNull();
    // 4.03 of the lamp, 1.33 of the delivery of 8 at 20 %
    expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([['invoice', 32.2, 5.36]]);

    // root follows the years of the thresholds: it is told of the ones that started (Austria a year
    // from the month before this one, France from January), and closes them
    await follow('tax_threshold_period_ended');
    const told = (await alertOf('tax_threshold_period_ended')).count;
    await closed('tax_threshold_period_ended');
    expect([told, (await alertOf('tax_threshold_period_ended')).count]).toEqual([2, 0]);
  });

  // root puts Austria in a group of the threshold and Portugal joins it: Portugal takes the state of
  // the group, the threshold passed, and its first sale takes the tax of Portugal
  it('takes the tax of a country from its first sale once root puts it in a group whose threshold passed', async () => {
    const kept = (await get(root, '/api/root/countries/AT')).json();
    const { country: _country, createdAt: _c, updatedAt: _u, ...body } = kept;
    const { cycleFrom: _f, nextCycleFrom: _n, held: _h, ...threshold } = body.threshold;
    const grouped = { ...threshold, group: 'EU' };
    expect(
      (await send(root, 'PUT', '/api/root/countries/AT', { ...body, threshold: grouped }))
        .statusCode,
    ).toBe(200);
    const portugal = await send(
      root,
      'PUT',
      '/api/root/countries/PT',
      country({
        zone: { name: 'Europe', manualPrice: 8, freeFrom: null },
        rule: 'recipient',
        registered: true,
        taxNumber: 'PT123456789',
        taxNumberLabel: 'NIF',
        taxNumberKind: 'other',
        threshold: grouped,
        deliveryVat: 'main',
        rates: [
          { group: null, rate: 23, from: null },
          { group: books, rate: 6, from: null },
        ],
      }),
    );
    expect(portugal.statusCode).toBe(200);

    const sale = await buys('Rui Costa', [[lamp, 1]], 'PT');
    expect(sale.refusal).toBeNull();
    // 4.53 of the lamp, 1.50 of the delivery of 8 at 23 %
    expect(await taxDocumentsOf(sale.buyer, sale.orderId)).toEqual([['invoice', 32.2, 6.03]]);
  });

  // a carrier that does not take the commercial invoice electronically: the admin prints it for the
  // box of the parcel to Britain
  it('leaves the commercial invoice of a parcel to Britain to print with a carrier that does not take it', async () => {
    const sale = await buys(
      'Ian Smith',
      [[shirt, 1]],
      'GB',
      'carrier',
      false,
      CARRIERS.Generic.name,
    );
    expect(sale.refusal).toBeNull();
    const made = await send(admin, 'POST', `/api/orders/${sale.orderId}/parcels`);
    expect(made.statusCode).toBe(200);
    const [parcel] = made.json().order.shipments as { id: number; customsInvoice: string }[];
    expect(parcel!.customsInvoice).toBe('print');
    const pdf = await get(
      admin,
      `/api/orders/${sale.orderId}/shipments/${parcel!.id}/customs-invoice`,
    );
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  // Norway takes its tax through the import scheme of the shop (VOEC): the number goes with the
  // parcel. Root takes the number away before the parcel is made: the admin cannot send a parcel the
  // tax of Norway was taken on without it, root writes it again and the parcel goes with it
  it('sends a parcel to Norway with the number of its import scheme, once root writes the number taken away again', async () => {
    const norway = (registered: boolean) =>
      country({
        zone: { name: 'World', manualPrice: 15, freeFrom: null },
        customsFree: false,
        rule: 'recipient',
        registered,
        taxNumber: registered ? 'VOEC2012345' : null,
        taxNumberLabel: registered ? 'VOEC' : null,
        taxNumberKind: registered ? 'ioss' : null,
        parcelLimit: { amount: 250, withDelivery: false, withVat: false },
        deliveryVat: 'main',
        exportPrice: 'same',
        exemptionText: 'Export outside the customs union',
        rates: [
          { group: null, rate: 25, from: null },
          { group: books, rate: 0, from: null },
        ],
      });
    expect((await send(root, 'PUT', '/api/root/countries/NO', norway(true))).statusCode).toBe(200);
    const sale = await buys('Ola Nordmann', [[shirt, 1]], 'NO', 'carrier');
    expect(sale.refusal).toBeNull();
    const [invoice] = await documentsOf(sale.buyer, sale.orderId);
    // 6 of the shirt at 25 % and the tax of the delivery
    expect(invoice!.tax).toBeGreaterThan(6);

    expect((await send(root, 'PUT', '/api/root/countries/NO', norway(false))).statusCode).toBe(200);
    // meanwhile a buyer in Norway reads the refusal within the limit of a parcel and does not get past
    // the confirmation; root, who follows the refusals, is told
    await follow('tax_parcel_limit_refusals', 1, 7);
    const kari = await createUser({ name: 'Kari Nordmann' });
    userIds.push(kari.id);
    const cart = await cartTo(kari, [[shirt, 1]], 'NO');
    const way = cart.options.find(
      (one) => one.method === 'carrier' && one.carrier?.name === CARRIERS.MockExpress.name,
    )!;
    expect(way.tax.refusal).toMatchObject({ code: 'TAX_PARCEL_LIMIT' });
    expect(await confirmAndPay(kari, 'Kari', cart.orderId, 'NO', way)).toBe('TAX_PARCEL_LIMIT');
    expect((await alertOf('tax_parcel_limit_refusals')).count).toBe(1);
    // root stops following them: no other root does, the refusals are not counted any more
    expect(
      (await send(root, 'DELETE', '/api/admin/alerts/subscriptions/tax_parcel_limit_refusals'))
        .statusCode,
    ).toBe(200);

    const refused = await send(admin, 'POST', `/api/orders/${sale.orderId}/parcels`);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ errorCode: 'DELIVERY_TAX_NUMBER_MISSING' });

    expect((await send(root, 'PUT', '/api/root/countries/NO', norway(true))).statusCode).toBe(200);
    const calls = watchShippyPro();
    const made = await send(admin, 'POST', `/api/orders/${sale.orderId}/parcels`);
    expect(made.statusCode).toBe(200);
    expect(calls.find((call) => call.method === 'Ship')?.params.Attributes).toEqual({
      sp_ioss: 'VOEC2012345',
    });
    expect(made.json().order.shipments).toMatchObject([{ customsInvoice: null }]);
  });

  // an invoice on request: only the buyer who ticked the box gets one
  it('makes an invoice only of the order whose buyer asked for one, when root says so', async () => {
    await writeSettings([['invoiceMode', 'on_request']]);
    const plain = await buys('Elena Ruiz', [[book, 1]], 'ES');
    const asked = await buys('Pablo Ruiz', [[book, 1]], 'ES', 'manual', true);
    await writeSettings([['invoiceMode', 'every_order']]);

    expect(await documentsOf(plain.buyer, plain.orderId)).toEqual([]);
    expect((await documentsOf(asked.buyer, asked.orderId)).map((one) => one.kind)).toEqual([
      'invoice',
    ]);
  });

  // root starts the series again every year: the next invoice is the first of the series of the year
  it('numbers an invoice in the series of its year once root says so', async () => {
    await writeSettings([['invoiceYearly', true]]);
    const sale = await buys('Nuria Ruiz', [[book, 1]], 'ES');
    await writeSettings([['invoiceYearly', false]]);

    expect(sale.refusal).toBeNull();
    const [invoice] = await documentsOf(sale.buyer, sale.orderId);
    expect(invoice!.number).toBe(`${series}${new Date().getUTCFullYear()}-1`);
  });

  // root stops making invoices and takes the series away: a credit note of an invoice made goes on
  // in the last series; the credit notes may not take the series of the invoices
  it('numbers a credit note of an invoice made in the last series once root took the series away', async () => {
    await writeSettings([
      ['invoiceMode', null],
      ['invoicePrefix', null],
      ['creditNotePrefix', null],
      ['invoiceYearly', null],
    ]);
    const { buyer, orderId } = bought.below!;
    const given = await send(root, 'POST', '/api/payments/compensations', {
      orderId,
      amount: 2,
      note: 'A late parcel.',
    });
    expect(given.statusCode).toBe(200);

    const credit = (await documentsOf(buyer, orderId)).find((one) => one.kind === 'credit_note');
    expect(credit).toMatchObject({
      gross: -2,
      number: expect.stringMatching(new RegExp(`^${series}R-`)),
    });
    const taken = await send(root, 'PUT', '/api/root/shop-settings/creditNotePrefix', {
      value: series,
    });
    expect(taken.statusCode).toBe(400);
    expect(taken.json()).toMatchObject({ errorCode: 'INVOICE_SERIES_TAKEN' });
  });
});
