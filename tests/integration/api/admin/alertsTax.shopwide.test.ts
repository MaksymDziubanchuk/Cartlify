import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { setUserContext } from '@db/dbContext.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { alertsOf } from '../../../helpers/alerts.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin, testTx } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { giveMoneyRight } from '../../../helpers/moneyManager.js';
import { deliveryBody, placeOrder } from '../../../helpers/orders.js';
import { moveClock } from '../../../helpers/payments.js';
import {
  applyTestShopSettingsBaseline,
  INTEGRATION_SHOP_BASELINE,
} from '../../../helpers/shopSettings.js';

// The alerts of the tax (docs/taxes.md): root's own kinds of the countries, the threshold near (its
// sales at the per cent root wrote), passed where the shop is registered (the tax of the country
// taken now), the sales it stopped where the shop is not (an order refused for it), and what only
// informs (Close puts it away for root alone): the orders refused within the limit of a parcel (two
// numbers, counted while a root follows the kind), a rate that starts soon, the period of a
// threshold that ended; and the fiscal receipts, root's and a money admin's: the ones not registered
// for long and the ones refused. The countries and the receipts are of the whole shop
// (*.shopwide.test.ts), the records of the countries go at the end

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let cashier: TestUser;
let plain: TestUser;
let buyer: TestUser;
let product: TestProduct;

// countries no other file writes: one with a threshold, one with the limit of a parcel
const BE = 'BE';
const NL = 'NL';
const ZONE = { name: 'Tax alerts test', manualPrice: 0, freeFrom: null };

const alerts = alertsOf({ app: () => app, csrf: () => csrf });

const call = (method: 'PUT' | 'DELETE', url: string, payload?: object, actor = root) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    ...(payload ? { payload } : {}),
  });

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();

// the record of Belgium: taxed by the rule recipient past a threshold of 25 with the tax, the shop
// registered there or not, a rate of 22 that starts in 10 days
const belgium = (fields: Record<string, unknown> = {}) => ({
  zone: ZONE,
  customsFree: true,
  rule: 'recipient',
  registered: true,
  taxNumber: 'BE0123456789',
  taxNumberLabel: 'BTW',
  taxNumberKind: 'other',
  parcelLimit: null,
  threshold: {
    amount: 25,
    withVat: true,
    group: null,
    period: 'year',
    startMonth: null,
    nextCycle: 'recipient',
  },
  deliveryVat: 'main',
  exportPrice: null,
  exemptionText: null,
  rates: [
    { group: null, rate: 21, from: null },
    { group: null, rate: 22, from: rateFrom },
  ],
  ...fields,
});
const rateFrom = inDays(10);

// the record of the Netherlands: the shop is not registered there, a parcel within 150 is refused
const netherlands = {
  zone: ZONE,
  customsFree: true,
  rule: 'recipient',
  registered: false,
  taxNumber: null,
  taxNumberLabel: null,
  taxNumberKind: null,
  parcelLimit: { amount: 150, withDelivery: false, withVat: true },
  threshold: null,
  deliveryVat: 'main',
  exportPrice: null,
  exemptionText: null,
  rates: [{ group: null, rate: 21, from: null }],
};

const to = (country: string, postalCode: string, city: string) => ({
  ...deliveryBody,
  address: { ...deliveryBody.address, country, postalCode, city },
});
const TO_BE = to(BE, '1000', 'Brussels');
const TO_NL = to(NL, '1011 AB', 'Amsterdam');

// an order the buyer confirms and pays, or the code of its refusal
async function ordered(delivery: object, quantity = 1): Promise<number | string> {
  try {
    return await placeOrder(app, csrf, buyer, product, 'paid', quantity, delivery as never);
  } catch (err) {
    const code = /answered 409 (\w+)/.exec((err as Error).message)?.[1];
    if (code) return code;
    throw err;
  }
}

// root (and the money admin) follows a kind, with the number it needs written first
async function follow(actor: TestUser, kind: string, value?: number, window?: number) {
  if (value !== undefined) {
    const set = await call(
      'PUT',
      `/api/admin/alerts/subscriptions/${kind}/threshold`,
      window === undefined ? { value } : { value, window },
      actor,
    );
    expect(set.statusCode).toBe(200);
  }
  expect((await call('PUT', `/api/admin/alerts/subscriptions/${kind}`, {}, actor)).statusCode).toBe(
    200,
  );
}

const countOf = async (actor: TestUser, kind: string) => (await alerts.alertOf(actor, kind)).count;

const close = (actor: TestUser, kind: string) =>
  call('PUT', `/api/admin/alerts/seen/${kind}`, {}, actor);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT' });
  cashier = await createUser({ role: 'ADMIN' });
  plain = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
  await giveMoneyRight(root.id, cashier.id);
  product = await createProduct({ price: 10, stock: 200 });
});

afterAll(async () => {
  try {
    for (const country of [BE, NL]) await call('DELETE', `/api/root/countries/${country}`);
    await closeSessions([root.id, cashier.id, plain.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

describe('who has the kinds of the tax and of the receipts', () => {
  it('gives root the kinds of the tax, root and a money admin the receipts, a plain admin none', async () => {
    const kindsOf = async (actor: TestUser) => (await alerts.alerts(actor)).map((a) => a.kind);
    const tax = [
      'tax_threshold_near',
      'tax_threshold_passed',
      'tax_threshold_dropped',
      'tax_sales_stopped',
      'tax_parcel_limit_refusals',
      'tax_rate_soon',
      'tax_threshold_period_ended',
    ];
    const receipts = ['receipts_not_issued', 'receipts_refused'];

    const ofRoot = await kindsOf(root);
    const ofCashier = await kindsOf(cashier);
    const ofPlain = await kindsOf(plain);

    for (const kind of [...tax, ...receipts]) expect(ofRoot).toContain(kind);
    for (const kind of receipts) expect(ofCashier).toContain(kind);
    for (const kind of tax) expect(ofCashier).not.toContain(kind);
    for (const kind of [...tax, ...receipts]) expect(ofPlain).not.toContain(kind);
    const informational = (await alerts.alerts(root))
      .filter((a) => a.kind.startsWith('tax_'))
      .map((a) => [a.kind, (a as unknown as { informational: boolean }).informational]);
    expect(Object.fromEntries(informational)).toEqual({
      tax_threshold_near: false,
      tax_threshold_passed: false,
      tax_threshold_dropped: false,
      tax_sales_stopped: false,
      tax_parcel_limit_refusals: true,
      tax_rate_soon: true,
      tax_threshold_period_ended: true,
    });
  });
});

describe('the threshold of a country', () => {
  beforeAll(async () => {
    expect((await call('PUT', `/api/root/countries/${BE}`, belgium())).statusCode).toBe(200);
    await follow(root, 'tax_threshold_near', 80);
    await follow(root, 'tax_threshold_passed');
  });

  it('is near once the sales reach the per cent of root, and passed once they pass it where the shop is registered', async () => {
    expect(await countOf(root, 'tax_threshold_near')).toBe(0);

    // 20 of 25: 80 per cent
    expect(typeof (await ordered(TO_BE, 2))).toBe('number');
    const near = await countOf(root, 'tax_threshold_near');
    const notYet = await countOf(root, 'tax_threshold_passed');

    // 30 of 25: the order passes the threshold, the tax of Belgium is taken
    expect(typeof (await ordered(TO_BE, 1))).toBe('number');
    const after = await countOf(root, 'tax_threshold_near');
    const passed = await countOf(root, 'tax_threshold_passed');

    expect([near, notYet]).toEqual([1, 0]);
    expect([after, passed]).toEqual([0, 1]);
  });

  it('stops the sales where the shop is not registered: the refusal of an order is told, in its period', async () => {
    expect(
      (
        await call(
          'PUT',
          `/api/root/countries/${BE}`,
          belgium({
            registered: false,
            taxNumber: null,
            taxNumberLabel: null,
            taxNumberKind: null,
          }),
        )
      ).statusCode,
    ).toBe(200);
    await follow(root, 'tax_sales_stopped');
    expect(await countOf(root, 'tax_sales_stopped')).toBe(0);

    expect(await ordered(TO_BE, 1)).toBe('TAX_SALES_STOPPED');

    expect(await countOf(root, 'tax_sales_stopped')).toBe(1);
    // a case of root to put aside, as the other kinds
    const aside = await alerts.dismiss(root, 'tax_sales_stopped', BE);
    expect(aside.statusCode).toBe(200);
    expect(await alerts.alertOf(root, 'tax_sales_stopped')).toMatchObject({
      count: 0,
      dismissed: 1,
    });
  });

  it('informs of a rate that starts within the days of root, until root closes it', async () => {
    await follow(root, 'tax_rate_soon', 30);

    expect(await countOf(root, 'tax_rate_soon')).toBe(1);
    const closed = await close(root, 'tax_rate_soon');
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toEqual({ kind: 'tax_rate_soon', seenUntil: expect.any(String) });
    expect(await alerts.alertOf(root, 'tax_rate_soon')).toMatchObject({
      count: 0,
      seenUntil: closed.json().seenUntil,
    });

    // within 5 days the rate of 10 days ahead is no news yet
    await call('PUT', '/api/admin/alerts/subscriptions/tax_rate_soon/threshold', { value: 5 });
    expect(await countOf(root, 'tax_rate_soon')).toBe(0);
  });

  // a year of a threshold starts on the 1st of its month: the one of this month started already
  it('informs of the year of a threshold that started, until root closes it', async () => {
    await follow(root, 'tax_threshold_period_ended');
    const month = new Date().getUTCMonth() + 1;
    expect(
      (
        await call(
          'PUT',
          `/api/root/countries/${BE}`,
          belgium({
            threshold: {
              amount: 25,
              withVat: true,
              group: null,
              period: 'rolling_12',
              startMonth: null,
              nextCycle: 'recipient',
            },
          }),
        )
      ).statusCode,
    ).toBe(200);
    // the last 12 months have no year that ends
    expect(await countOf(root, 'tax_threshold_period_ended')).toBe(0);
    expect(
      (
        await call(
          'PUT',
          `/api/root/countries/${BE}`,
          belgium({
            threshold: {
              amount: 25,
              withVat: true,
              group: null,
              period: 'year',
              startMonth: month,
              nextCycle: 'recipient',
            },
          }),
        )
      ).statusCode,
    ).toBe(200);

    expect(await countOf(root, 'tax_threshold_period_ended')).toBe(1);
    expect((await close(root, 'tax_threshold_period_ended')).statusCode).toBe(200);
    expect(await countOf(root, 'tax_threshold_period_ended')).toBe(0);
  });

  it('closes only a kind that informs', async () => {
    const res = await close(root, 'tax_threshold_near');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'ALERT_KIND_NOT_FOUND' });
  });
});

describe('the orders refused within the limit of a parcel', () => {
  beforeAll(async () => {
    expect((await call('PUT', `/api/root/countries/${NL}`, netherlands)).statusCode).toBe(200);
  });

  it('are counted while root follows the kind with both numbers, and told once they reach the number in the days', async () => {
    // nobody follows the kind: a refusal is not counted
    expect(await ordered(TO_NL, 1)).toBe('TAX_PARCEL_LIMIT');
    await follow(root, 'tax_parcel_limit_refusals', 2, 7);
    expect(await countOf(root, 'tax_parcel_limit_refusals')).toBe(0);

    expect(await ordered(TO_NL, 1)).toBe('TAX_PARCEL_LIMIT');
    const one = await countOf(root, 'tax_parcel_limit_refusals');
    expect(await ordered(TO_NL, 1)).toBe('TAX_PARCEL_LIMIT');
    const two = await countOf(root, 'tax_parcel_limit_refusals');

    expect([one, two]).toEqual([0, 1]);
    expect(await alerts.alertOf(root, 'tax_parcel_limit_refusals')).toMatchObject({
      threshold: 2,
      window: 7,
      informational: true,
    });

    // root closes it: what was seen goes; a refusal of the same day is the same news
    expect((await close(root, 'tax_parcel_limit_refusals')).statusCode).toBe(200);
    expect(await countOf(root, 'tax_parcel_limit_refusals')).toBe(0);
  });
});

describe('the receipts', () => {
  const series = `A${randomBytes(3).toString('hex').toUpperCase()}`;
  const SETTINGS: [string, unknown][] = [
    ['invoicePrefix', series],
    ['creditNotePrefix', `${series}R`],
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

  beforeAll(async () => {
    // the writes of the countries read the settings of the database into the memory: the shop of the
    // tests on them again, its zone of the buyers of the tests
    applyTestShopSettingsBaseline(INTEGRATION_SHOP_BASELINE);
    await writeSettings(SETTINGS);
    for (const actor of [root, cashier]) {
      await follow(actor, 'receipts_not_issued', 60);
      await follow(actor, 'receipts_refused');
    }
  });

  afterAll(async () => {
    await writeSettings([...SETTINGS].reverse().map(([key]) => [key, null]));
  });

  const receiptOf = (orderId: number) =>
    asAdmin((tx) =>
      tx.taxDocument.findFirstOrThrow({
        where: { orderId, kind: 'receipt' },
        select: { id: true },
      }),
    );

  it('tells of a receipt not registered for the minutes of the person, to root and the money admin', async () => {
    const orderId = (await ordered(deliveryBody)) as number;
    const { id } = await receiptOf(orderId);

    // a receipt just made is not late; an hour on it is, and the list of the alert names its order
    const early = await alerts.dismiss(cashier, 'receipts_not_issued', id);
    const listedEarly = await alerts.idsOf(root, 'receipts_not_issued', { q: orderId });
    let listedLate: number[] | undefined;
    const clock = moveClock(61 * 60_000);
    try {
      listedLate = await alerts.idsOf(root, 'receipts_not_issued', { q: orderId });
      for (const actor of [root, cashier]) {
        const aside = await alerts.dismiss(actor, 'receipts_not_issued', id);
        expect(aside.statusCode).toBe(200);
      }
    } finally {
      clock.restore();
    }
    expect(listedEarly).toEqual([]);
    expect(listedLate).toEqual([orderId]);

    expect(early.statusCode).toBe(404);
    expect(early.json()).toMatchObject({ errorCode: 'ALERT_ITEM_NOT_FOUND' });
  });

  it('tells of a receipt the provider refused until it is made by hand', async () => {
    const orderId = (await ordered(deliveryBody)) as number;
    const { id } = await receiptOf(orderId);
    await testTx(async (tx) => {
      await tx.$executeRaw`select cartlify.set_current_context('ADMIN'::cartlify."Role", null, null)`;
      await tx.$queryRaw`select cartlify.record_receipt_result(${id}::int, 'fiskaly', 'refused',
        null, null, null, null, '{"code":"RECEIPT_PROVIDER_REFUSED"}', null::timestamp) as r`;
    });

    expect((await alerts.dismiss(root, 'receipts_refused', id)).statusCode).toBe(200);
    expect((await alerts.dismiss(root, 'receipts_refused', id, false)).statusCode).toBe(200);
    // the list of the alert names the order, whose documents hold the receipt
    expect(await alerts.idsOf(root, 'receipts_refused', { q: orderId })).toEqual([orderId]);

    // the money admin made it by hand and confirms it: it is no case any more
    const byHand = await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/documents/${id}/receipt-confirmation`,
      headers: withCsrf(csrf, accessCookie(cashier)),
      payload: { number: 'A-HAND' },
    });
    expect(byHand.statusCode).toBe(200);
    const after = await alerts.dismiss(root, 'receipts_refused', id);
    expect(after.statusCode).toBe(404);
    expect(await alerts.idsOf(root, 'receipts_refused', { q: orderId })).toEqual([]);
  });
});
