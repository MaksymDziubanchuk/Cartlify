import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { issuePendingReceipts } from '@routes/api/orders/services/receipts.service.js';

import { accessCookie } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin, testTx } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { breakFiskaly, realFiskaly } from '../../helpers/fiskaly.js';
import { watchMail } from '../../helpers/mail.js';
import { placeOrder } from '../../helpers/orders.js';
import { receiptHarness, type ReceiptHarness } from '../../helpers/providers.js';
import { cancelAndRefund } from '../../helpers/returns.js';
import { resetShopSettings, setShopSettings } from '../../helpers/shopSettings.js';
import { setUserContext } from '@db/dbContext.service.js';

// The worker of the fiscal receipts (docs/taxes.md) with the provider fiskaly (its mock, or TEST
// with service:fiskaly): the receipt the payment made goes to the provider, is asked about until it
// is registered and is mailed to the buyer; a correction goes once the receipt of its sale was
// taken; a provider that does not answer leaves the receipt for a later try, a refusal leaves it to
// an admin, who confirms it made by hand (POST /api/orders/:orderId/documents/:documentId/
// receipt-confirmation). The shop registers the receipt of a sale at the payment with an invoice of
// every order: settings of the whole shop (*.shopwide.test.ts), written in the database (the server
// of the tests makes no receipts, RECEIPT_PROVIDER none, so no write of root takes the moment) and
// put back at the end. Each run is kept to the orders of its test

const harness = receiptHarness.fiskaly as ReceiptHarness;
const provider = harness.provider;

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let admin: TestUser;
let buyer: TestUser;
let product: TestProduct;

// the series of the run: a number is taken once at fiskaly, in every run
const series = { invoice: `W${randomBytes(3).toString('hex').toUpperCase()}`, credit: '' };
series.credit = `${series.invoice}R`;

const SETTINGS: [string, unknown][] = [
  ['invoicePrefix', series.invoice],
  ['creditNotePrefix', series.credit],
  ['invoiceYearly', false],
  ['invoiceMode', 'every_order'],
  ['receiptMoment', 'payment'],
];

const writeSettings = (values: [string, unknown][]) =>
  testTx(async (tx) => {
    await setUserContext(tx, { userId: root.id, role: 'ROOT' });
    for (const [key, value] of values) {
      await tx.$executeRaw`insert into cartlify.shop_settings (key, value, "setById")
        values (${key}, ${JSON.stringify(value)}::jsonb, ${root.id})`;
    }
  });

// what the worker logs, kept by the test
const logged: { level: string; msg: string | undefined }[] = [];
const log = {
  info: (_obj: unknown, msg?: string) => logged.push({ level: 'info', msg }),
  warn: (_obj: unknown, msg?: string) => logged.push({ level: 'warn', msg }),
  error: (_obj: unknown, msg?: string) => logged.push({ level: 'error', msg }),
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT' });
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser({ name: 'Ana García' });
  product = await createProduct({ price: 12, stock: 40 });
  await writeSettings(SETTINGS);
  // the provider registers for the taxpayer of the account of the tests
  setShopSettings(harness.shop);
});

afterAll(async () => {
  try {
    await writeSettings([...SETTINGS].reverse().map(([key]) => [key, null]));
    resetShopSettings();
    await closeSessions([root.id, admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ReceiptRow = {
  id: number;
  kind: string;
  documentId: number | null;
  provider: string | null;
  receiptState: string | null;
  receiptNumber: string | null;
  receiptUrl: string | null;
  receiptCode: string | null;
  receiptText: string | null;
  receiptAttempts: number;
  receiptError: string | null;
  receiptNextAt: Date | null;
};

const receiptsOf = (orderId: number) =>
  asAdmin((tx) =>
    tx.taxDocument.findMany({
      where: { orderId, kind: { in: ['receipt', 'return_receipt'] } },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        kind: true,
        documentId: true,
        provider: true,
        receiptState: true,
        receiptNumber: true,
        receiptUrl: true,
        receiptCode: true,
        receiptText: true,
        receiptAttempts: true,
        receiptError: true,
        receiptNextAt: true,
      },
    }),
  ) as Promise<ReceiptRow[]>;

// one sweep of the worker, kept to the orders given, as of a moment the next tries are due
const sweep = (orderIds: number[], later = false) =>
  issuePendingReceipts(log, {
    orderIds,
    provider,
    ...(later ? { dueBy: new Date(Date.now() + 10 * 60_000) } : {}),
  });

// sweeps until no receipt of the orders waits (the tax authority of the test takes seconds to
// minutes; the mock registers by the next look)
async function untilDone(orderIds: number[]) {
  for (let round = 0; round < 60; round += 1) {
    const waiting = (await Promise.all(orderIds.map(receiptsOf)))
      .flat()
      .filter((r) => r.receiptState === 'pending');
    if (!waiting.length) return;
    await sweep(orderIds, true);
    if (realFiskaly) await sleep(3000);
  }
}

const get = (actor: TestUser, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

const confirmByHand = (actor: TestUser, orderId: number, documentId: number, payload: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/orders/${orderId}/documents/${documentId}/receipt-confirmation`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: payload as Record<string, unknown>,
  });

describe('the receipt of a sale', () => {
  it(
    'goes to the provider, is registered and is mailed to the buyer with its number and its link',
    async () => {
      const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 2);
      const mails = watchMail();

      const sent = await sweep([orderId]);
      const [taken] = await receiptsOf(orderId);
      await untilDone([orderId]);
      const [done] = await receiptsOf(orderId);

      expect(sent).toBe(1);
      expect(taken).toMatchObject({ provider: 'fiskaly', receiptAttempts: 1, receiptError: null });
      expect(['pending', 'registered']).toContain(taken!.receiptState);
      expect(taken!.receiptNumber).not.toBeNull();
      expect(done).toMatchObject({
        receiptState: 'registered',
        receiptNumber: expect.any(String),
        receiptUrl: expect.stringMatching(/^https:\/\//),
        receiptNextAt: null,
      });
      const toBuyer = mails.filter((m) => m.to.includes(buyer.email));
      expect(toBuyer).toHaveLength(1);
      expect(toBuyer[0]!.subject).toContain(`#${orderId}`);
      expect(toBuyer[0]!.text).toContain(done!.receiptNumber!);
      expect(toBuyer[0]!.text).toContain(done!.receiptUrl!);

      // the buyer sees it with the invoice, without the errors of the provider
      const listed = await get(buyer, `/api/orders/${orderId}/documents`);
      expect(listed.json().items).toEqual([
        expect.objectContaining({ kind: 'invoice', number: `${series.invoice}-1`, receipt: null }),
        expect.objectContaining({
          kind: 'receipt',
          documentId: listed.json().items[0].id,
          number: null,
          receipt: {
            provider: 'fiskaly',
            state: 'registered',
            number: done!.receiptNumber,
            url: done!.receiptUrl,
            text: done!.receiptText,
            error: null,
          },
        }),
      ]);
    },
    harness.wait,
  );

  it(
    'sends the return receipt of a refund once the receipt of its sale is registered, and mails it too',
    async () => {
      const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 1);
      await cancelAndRefund(admin.id, orderId);
      const mails = watchMail();

      const first = await sweep([orderId]);
      const afterFirst = await receiptsOf(orderId);
      const second = await sweep([orderId]);
      await untilDone([orderId]);
      const done = await receiptsOf(orderId);

      // the sale first; its correction waits while the sale is taken and not registered yet (the
      // tax authority may still refuse it), and goes once it is
      expect(first).toBe(1);
      expect(afterFirst.map((r) => [r.kind, r.provider])).toEqual([
        ['receipt', 'fiskaly'],
        ['return_receipt', null],
      ]);
      expect(second).toBe(0);
      expect(done.map((r) => [r.kind, r.receiptState])).toEqual([
        ['receipt', 'registered'],
        ['return_receipt', 'registered'],
      ]);
      expect(mails.filter((m) => m.to.includes(buyer.email))).toHaveLength(2);
    },
    harness.wait,
  );
});

describe('a receipt the provider does not take', () => {
  it('waits for a later try while the provider does not answer, and stops the sweep', async () => {
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 1);
    breakFiskaly('down');
    const before = Date.now();

    const sent = await sweep([orderId]);
    const [receipt] = await receiptsOf(orderId);

    expect(sent).toBe(0);
    expect(receipt).toMatchObject({
      provider: 'fiskaly',
      receiptState: 'pending',
      receiptAttempts: 1,
    });
    expect(JSON.parse(receipt!.receiptError!)).toMatchObject({
      code: 'RECEIPT_PROVIDER_UNAVAILABLE',
    });
    // the next try in a minute at the soonest
    expect(receipt!.receiptNextAt!.getTime()).toBeGreaterThanOrEqual(before + 59_000);
    expect(logged.at(-1)).toEqual({ level: 'warn', msg: 'the receipt provider did not answer' });
  });

  it('is left to an admin when the tax authority refuses it, who confirms it made by hand', async () => {
    if (!harness.refuseNext) return;
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 1);
    harness.refuseNext();
    const mails = watchMail();

    await sweep([orderId]);
    await untilDone([orderId]);
    const [refused] = await receiptsOf(orderId);

    expect(refused).toMatchObject({ receiptState: 'refused', receiptNextAt: null });
    expect(JSON.parse(refused!.receiptError!)).toMatchObject({
      code: 'RECEIPT_PROVIDER_REFUSED',
      details: { registration: 'REQUIRES_INSPECTION' },
    });
    expect(mails.filter((m) => m.to.includes(buyer.email))).toHaveLength(0);

    // the admin sees why, the buyer does not
    const byAdmin = (await get(admin, `/api/orders/${orderId}/documents`)).json().items[1];
    const byBuyer = (await get(buyer, `/api/orders/${orderId}/documents`)).json().items[1];
    expect(byAdmin.receipt).toMatchObject({ state: 'refused', error: refused!.receiptError });
    expect(byBuyer.receipt).toMatchObject({ state: 'refused', error: null });

    const confirmed = await confirmByHand(admin, orderId, refused!.id, {
      number: 'A-HAND-1',
      url: 'https://check.example/hand',
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().items[1]).toMatchObject({
      kind: 'receipt',
      receipt: { state: 'manual', number: 'A-HAND-1', url: 'https://check.example/hand' },
    });
    const audit = await asAdmin((tx) =>
      tx.adminAuditLog.findFirst({
        where: { entityType: 'order', entityId: orderId, event: 'order.receipt_confirm' },
        select: { actorId: true, action: true },
      }),
    );
    expect(audit).toEqual({ actorId: admin.id, action: 'OTHER' });
    // a receipt made by hand is not sent again
    expect(await sweep([orderId], true)).toBe(0);
    const again = await confirmByHand(admin, orderId, refused!.id, { number: 'A-HAND-2' });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      errorCode: 'RECEIPT_STATE_INVALID',
      details: { state: 'manual' },
    });
  });
});

describe('the confirmation of a receipt by hand', () => {
  it('is for an admin and root, of a receipt of the order, with a number', async () => {
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 1);
    const [receipt] = await receiptsOf(orderId);

    const byBuyer = await confirmByHand(buyer, orderId, receipt!.id, { number: 'A-1' });
    const invoice = await confirmByHand(admin, orderId, receipt!.documentId!, { number: 'A-1' });
    const elsewhere = await confirmByHand(admin, orderId + 100000, receipt!.id, { number: 'A-1' });
    const blank = await confirmByHand(admin, orderId, receipt!.id, { number: '   ' });
    // the link is shown to the buyer: https only
    const script = await confirmByHand(root, orderId, receipt!.id, {
      number: 'A-ROOT-1',
      url: 'javascript:alert(1)',
    });
    expect(script.statusCode).toBe(400);
    expect(script.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    const byRoot = await confirmByHand(root, orderId, receipt!.id, {
      number: 'A-ROOT-1',
      url: null,
    });

    expect(byBuyer.statusCode).toBe(403);
    expect(invoice.json()).toMatchObject({ errorCode: 'TAX_DOCUMENT_NOT_FOUND' });
    expect(elsewhere.statusCode).toBe(404);
    expect(blank.statusCode).toBe(400);
    expect(byRoot.statusCode).toBe(200);
    expect(byRoot.json().items[1].receipt).toMatchObject({
      state: 'manual',
      number: 'A-ROOT-1',
      url: null,
    });
  });
});
