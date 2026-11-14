import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { setUserContext } from '@db/dbContext.service.js';
import { withdrawalCodeOf } from '@helpers/withdrawalCode.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { testTx } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';
import { moveClock } from '../../../helpers/payments.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import { beginReturnRefund, failReturnRefund, refundReturn } from '../../../helpers/returns.js';

// The alerts about the statements of withdrawal and of return, and about the orders shipped without
// a tracking number (GET /api/admin/alerts): shipped_without_tracking, return_refunds_in_transit,
// return_refunds_failed, returns_manual_check, returns_proof_waiting, returns_goods_not_sent,
// returns_money_late and returns_goods_late. The count of an alert is the total of the list it
// names, and a case is put aside by its id (the id of the statement, of the order, or of the
// transfer: its first line in the money journal). What a dispute of the payment and a refund made
// by hand do to the money of a statement is in alertsDisputes.test.ts and alertsHandRefunds.test.ts
//
// The alerts of the shop are shared by every file that runs at the same time, so a test looks at
// its own cases: the list of a kind narrowed to the buyer of the test, and the cases the admin can
// put aside, which the server lets only for a case the alert counts now. The count and the total of
// the whole shop are read again until two reads in a row agree, because another file may add a case
// between them.
//
// The statements are stated now by the clock of the database, and the alerts count their days from
// the clock of the app: a test ages the cases by moving the clock. A margin of an hour on both
// sides of a day keeps the check clear of the small difference the two clocks may have.

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;
const userIds: number[] = [];
let clock: { restore: () => void } | null = null;

const DAY = 86_400_000;
const HOUR = 3_600_000;

// no digit in the address: the search of the list reads a number as an order
const tag = uniqueTag().replace(/\d/g, (digit) => 'abcdefghij'[Number(digit)]!);

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// the buyer of a scenario, and the admin who reads the alerts
const newBuyer = () => newUser({ name: 'Anna Koval' });
const newAdmin = () => newUser({ role: 'ADMIN' });

const flows = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });
const { shippedOrder, adminStatement, setGoods, cardOf, confirmProof, post } = flows;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
  product = await createProduct({ price: 10, stock: 500 });
});

afterEach(() => {
  clock?.restore();
  clock = null;
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type AlertList = { path: string; query: Record<string, string> };
type Alert = {
  kind: string;
  subscribed: boolean;
  count: number;
  dismissed: number;
  threshold: number | null;
  list: AlertList | null;
};
type Alerts = { alerts: Alert[]; total: number; dismissalsAvailable: boolean };

// the token is signed at each request: a test that runs the clock forward gets one of that time
const get = (actor: TestUser, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

const change = (
  actor: TestUser,
  method: 'PUT' | 'DELETE' | 'PATCH',
  url: string,
  payload?: object,
) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    ...(payload ? { payload } : {}),
  });

const alertsOf = async (actor: TestUser, query = '') => {
  const res = await get(actor, `/api/admin/alerts${query}`);
  expect(res.statusCode).toBe(200);
  return res.json() as Alerts;
};

const alertOf = async (actor: TestUser, kind: string) =>
  (await alertsOf(actor)).alerts.find((alert) => alert.kind === kind)!;

const setThreshold = async (actor: TestUser, kind: string, value: unknown) =>
  change(actor, 'PUT', `/api/admin/alerts/subscriptions/${kind}/threshold`, { value });

const dismiss = (actor: TestUser, kind: string, id: number | string, on = true) =>
  change(actor, on ? 'PUT' : 'DELETE', `/api/admin/alerts/dismissals/${kind}/${id}`);

const runClock = (ms: number) => {
  clock?.restore();
  clock = moveClock(ms);
};

const byNumber = (a: number, b: number) => a - b;

// the list the alert of a kind names, narrowed to the rows of the test
async function listOf(actor: TestUser, kind: string, narrow: Record<string, string | number>) {
  const { list } = await alertOf(actor, kind);
  const query = new URLSearchParams({
    ...list!.query,
    ...Object.fromEntries(Object.entries(narrow).map(([key, value]) => [key, String(value)])),
  });
  const res = await get(actor, `${list!.path}?${query}`);
  expect(res.statusCode).toBe(200);
  return res.json() as { items: Array<{ id: number | string }>; total: number };
}

// the alert counts the case now: the server lets the admin put it aside, and names it aside
async function expectCounted(actor: TestUser, kind: string, id: number) {
  const res = await dismiss(actor, kind, id);
  expect(res.statusCode).toBe(200);
  expect((await alertOf(actor, kind)).dismissed).toBe(1);
  expect((await dismiss(actor, kind, id, false)).statusCode).toBe(200);
}

async function expectNotCounted(actor: TestUser, kind: string, id: number) {
  const res = await dismiss(actor, kind, id);
  expect(res.statusCode).toBe(404);
  expect(res.json()).toMatchObject({ errorCode: 'ALERT_ITEM_NOT_FOUND' });
}

// the count of the alert is the total of its list with its own query. Other files add and settle
// cases at the same time, so the two are read again, up to ten times, until the count read before
// the list, the total of the list and the count read after it are one number; a count that is
// never the total of the list fails with the numbers of the last try
async function expectCountIsTotalOfList(actor: TestUser, kind: string) {
  let last = { before: -1, total: -2, after: -3 };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const before = await alertOf(actor, kind);
    const res = await get(
      actor,
      `${before.list!.path}?${new URLSearchParams({ ...before.list!.query, limit: '1' })}`,
    );
    expect(res.statusCode).toBe(200);
    const after = await alertOf(actor, kind);
    last = { before: before.count, total: res.json().total, after: after.count };
    if (last.before === last.total && last.after === last.total) return;
  }
  expect(last.before).toBe(last.total);
  expect(last.after).toBe(last.total);
}

// the cases a kind counts for the buyer, found in the list it names (narrowed to the buyer) and by
// the alert itself (put aside), and the ids that are no case, without the count of the whole shop:
// a test checks that once a kind, each read of the alerts counts every kind of the actor
async function expectListed(
  actor: TestUser,
  kind: string,
  buyer: TestUser,
  counted: number[],
  notCounted: number[],
) {
  const page = await listOf(actor, kind, { userId: buyer.id, limit: 100 });

  expect(page.items.map((row) => Number(row.id)).sort(byNumber)).toEqual(
    [...counted].sort(byNumber),
  );
  expect(page.total).toBe(counted.length);
  for (const id of counted) await expectCounted(actor, kind, id);
  for (const id of notCounted) await expectNotCounted(actor, kind, id);
}

// the cases a kind counts for the buyer, found in the list it names (narrowed to the buyer) and by
// the alert itself (put aside), and the ids that are no case
async function expectCases(
  actor: TestUser,
  kind: string,
  buyer: TestUser,
  counted: number[],
  notCounted: number[],
) {
  const page = await listOf(actor, kind, { userId: buyer.id, limit: 100 });

  // the id of a case of the failed refunds is text (the id of a statement, or of a refund at the provider)
  expect(page.items.map((row) => Number(row.id)).sort(byNumber)).toEqual(
    [...counted].sort(byNumber),
  );
  expect(page.total).toBe(counted.length);
  for (const id of counted) await expectCounted(actor, kind, id);
  for (const id of notCounted) await expectNotCounted(actor, kind, id);
  await expectCountIsTotalOfList(actor, kind);
}

// ---- the statements of the scenarios ----

// an open statement of an admin for one unit of a new sent order: the goods are expected
const stated = async (buyer: TestUser) => {
  const placed = await shippedOrder(buyer, product, 1);
  return adminStatement(placed.orderId, placed.itemId, 1);
};

// the same, and the goods are on the shelf
const received = async (buyer: TestUser) => {
  const card = await stated(buyer);
  await setGoods(card, 1, 'to_stock');
  return card;
};

// the buyer withdraws from a new sent order from their account, and tells of the parcel or not
async function fromAccount(buyer: TestUser, told: boolean) {
  const placed = await shippedOrder(buyer, product, 1);
  const id = await flows.withdrawFromAccount(buyer, placed.orderId);
  if (told) await flows.tellOfParcel(buyer, placed.orderId, id);
  return id;
}

// the public form of a new sent order, with the code of the order or without it
async function fromForm(buyer: TestUser, withCode: boolean) {
  const placed = await shippedOrder(buyer, product, 1);
  return flows.formStatement(placed.orderId, withCode, `form.${tag}@example.com`);
}

// the root closes the rows that wait for their goods, without a refund
const closeWithoutRefund = async (returnId: number) => {
  const res = await post(
    `/api/returns/${returnId}/close`,
    { code: 'goods_not_returned', note: 'The parcel never came.' },
    root,
  );
  expect(res.statusCode).toBe(200);
};

// ---- the kinds in the answers of the alerts ----

const NEW_KINDS = [
  'returns_manual_check',
  'returns_proof_waiting',
  'returns_goods_not_sent',
  'returns_money_late',
  'returns_goods_late',
] as const;

// the default threshold of the kinds that have one, in days
const DEFAULT_DAYS = {
  shipped_without_tracking: 2,
  returns_proof_waiting: 2,
  returns_goods_not_sent: 21,
  returns_money_late: 10,
  returns_goods_late: 14,
} as const;

// the parameter of the list of the statements that holds the days of the threshold
const DAYS_PARAMETER = {
  returns_proof_waiting: 'proofOlderThanDays',
  returns_goods_not_sent: 'olderThanDays',
  returns_money_late: 'moneyDueForDays',
  returns_goods_late: 'paidAheadForDays',
} as const;

describe('the new kinds in GET /api/admin/alerts', () => {
  it('puts the kinds of the statements after the money and the kind of the tracking after the cost of the send', async () => {
    const { alerts, total } = await alertsOf(await newAdmin());
    const kinds = alerts.map((alert) => alert.kind);

    expect(kinds.indexOf('shipped_without_tracking')).toBe(
      kinds.indexOf('shipped_without_cost') + 1,
    );
    expect(kinds.indexOf('return_refunds_failed')).toBe(
      kinds.indexOf('return_refunds_in_transit') + 1,
    );
    expect(kinds.slice(kinds.indexOf('disputes_lost'))).toEqual([
      'disputes_lost',
      ...NEW_KINDS,
      'worker_stalled',
      'shop_settings_incomplete',
      'shop_locale_missing',
    ]);
    expect(total).toBe(alerts.reduce((sum, alert) => sum + alert.count, 0));
  });

  it('names the default threshold and the ready request to the list of each kind', async () => {
    const { alerts } = await alertsOf(await newAdmin());
    const of = (kind: string) => alerts.find((alert) => alert.kind === kind)!;

    expect(of('shipped_without_tracking')).toMatchObject({
      subscribed: true,
      dismissed: 0,
      threshold: 2,
      list: { path: '/api/orders', query: { shippedWithoutNumber: 'true' } },
    });
    expect(of('shipped_without_tracking').list!.query.shippedTo).toEqual(expect.any(String));
    expect(of('return_refunds_in_transit')).toMatchObject({
      threshold: 3,
      list: { path: '/api/payments/refunds', query: { purpose: 'return', state: 'in_transit' } },
    });
    expect(of('return_refunds_in_transit').list!.query.to).toEqual(expect.any(String));
    expect(of('return_refunds_failed')).toMatchObject({
      threshold: null,
      list: { path: '/api/payments/refunds', query: { purpose: 'return', state: 'failed' } },
    });
    expect(of('returns_manual_check')).toMatchObject({
      threshold: null,
      list: { path: '/api/returns', query: { state: 'open', source: 'form_manual' } },
    });
    expect(of('returns_proof_waiting')).toMatchObject({
      threshold: 2,
      list: {
        path: '/api/returns',
        query: { state: 'open', goods: 'proof_provided', proofOlderThanDays: '2' },
      },
    });
    expect(of('returns_goods_not_sent')).toMatchObject({
      threshold: 21,
      list: {
        path: '/api/returns',
        query: { state: 'open', goods: 'waiting_no_proof', olderThanDays: '21' },
      },
    });
    expect(of('returns_money_late')).toMatchObject({
      threshold: 10,
      list: {
        path: '/api/returns',
        query: { state: 'open', moneyDueForDays: '10', moneyHeld: 'false' },
      },
    });
    expect(of('returns_goods_late')).toMatchObject({
      threshold: 14,
      list: { path: '/api/returns', query: { state: 'open', paidAheadForDays: '14' } },
    });
  });

  it('gives root the kinds too, with the actions of the admins after them', async () => {
    const { alerts } = await alertsOf(root);
    const kinds = alerts.map((alert) => alert.kind);

    for (const kind of [
      'shipped_without_tracking',
      'return_refunds_in_transit',
      'return_refunds_failed',
      ...NEW_KINDS,
    ]) {
      expect(kinds).toContain(kind);
    }
    expect(kinds.at(-1)).toBe('admin_actions');
  });
});

describe('the subscriptions to the new kinds', () => {
  const itemOf = async (actor: TestUser, kind: string) => {
    const res = await get(actor, '/api/admin/alerts/subscriptions');
    expect(res.statusCode).toBe(200);
    return (res.json().items as Array<{ kind: string }>).find((item) => item.kind === kind);
  };

  it.each(Object.entries(DEFAULT_DAYS))(
    'has %s on with a threshold of %i days from 1 to 365 until the admin sets one',
    async (kind, days) => {
      const item = await itemOf(await newAdmin(), kind);

      expect(item).toEqual({
        kind,
        subscribed: true,
        threshold: { value: days, default: days, min: 1, max: 365, unit: 'days', custom: false },
      });
    },
  );

  it.each(['return_refunds_failed', 'returns_manual_check'])(
    'has %s on, with no threshold: every case waits',
    async (kind) => {
      expect(await itemOf(await newAdmin(), kind)).toEqual({
        kind,
        subscribed: true,
        threshold: null,
      });
    },
  );

  it.each(Object.keys(DEFAULT_DAYS))(
    'keeps the threshold an admin sets for %s for that admin only, and gives it back on reset',
    async (kind) => {
      const first = await newAdmin();
      const second = await newAdmin();

      const set = await setThreshold(first, kind, 30);

      expect(set.statusCode).toBe(200);
      expect(set.json()).toMatchObject({ kind, threshold: { value: 30, custom: true } });
      expect((await alertOf(first, kind)).threshold).toBe(30);
      expect((await alertOf(second, kind)).threshold).toBe(
        DEFAULT_DAYS[kind as keyof typeof DEFAULT_DAYS],
      );
      // the ready request of the list follows the threshold
      const query = (await alertOf(first, kind)).list!.query;
      if (kind === 'shipped_without_tracking') {
        expect(Math.abs(Date.now() - Date.parse(query.shippedTo!) - 30 * DAY)).toBeLessThan(HOUR);
      } else {
        expect(query[DAYS_PARAMETER[kind as keyof typeof DAYS_PARAMETER]]).toBe('30');
      }

      const reset = await change(
        first,
        'DELETE',
        `/api/admin/alerts/subscriptions/${kind}/threshold`,
      );
      expect(reset.statusCode).toBe(200);
      expect(reset.json()).toMatchObject({
        threshold: { value: DEFAULT_DAYS[kind as keyof typeof DEFAULT_DAYS], custom: false },
      });
    },
  );

  it.each(Object.keys(DEFAULT_DAYS))('takes %s from 1 to 365 days and no other', async (kind) => {
    const someone = await newAdmin();

    expect((await setThreshold(someone, kind, 1)).statusCode).toBe(200);
    expect((await setThreshold(someone, kind, 365)).statusCode).toBe(200);
    const over = await setThreshold(someone, kind, 366);
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({
      errorCode: 'ALERT_THRESHOLD_INVALID',
      details: { min: 1, max: 365 },
    });
    // the schema of the route refuses what is not a whole number from 1 before the kind looks at it
    for (const value of [0, 1.5, 'often', null]) {
      const res = await setThreshold(someone, kind, value);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
  });

  it.each(['return_refunds_failed', 'returns_manual_check'])(
    'answers ALERT_THRESHOLD_NOT_FOUND to a threshold for %s',
    async (kind) => {
      const res = await setThreshold(await newAdmin(), kind, 3);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'ALERT_THRESHOLD_NOT_FOUND' });
    },
  );

  it('turns a kind off and on for one admin only, and keeps its threshold', async () => {
    const first = await newAdmin();
    const second = await newAdmin();
    await setThreshold(first, 'returns_money_late', 12);

    const off = await change(first, 'DELETE', '/api/admin/alerts/subscriptions/returns_money_late');

    expect(off.statusCode).toBe(200);
    expect(off.json()).toMatchObject({
      kind: 'returns_money_late',
      subscribed: false,
      threshold: { value: 12, custom: true },
    });
    const followed = await alertsOf(first, '?subscribed=true');
    expect(followed.alerts.map((alert) => alert.kind)).not.toContain('returns_money_late');
    expect(followed.alerts.map((alert) => alert.kind)).toContain('returns_goods_late');
    expect((await alertOf(second, 'returns_money_late')).subscribed).toBe(true);

    const on = await change(first, 'PUT', '/api/admin/alerts/subscriptions/returns_money_late');
    expect(on.json()).toMatchObject({ subscribed: true, threshold: { value: 12 } });
  });
});

describe('shipped_without_tracking', () => {
  // an order paid and sent by an admin with a send (a carrier, and a number when it is given)
  async function sent(buyer: TestUser, shipment: Record<string, unknown>) {
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid');
    const res = await change(admin, 'PATCH', `/api/orders/${orderId}/status`, {
      status: 'shipped',
      shipment,
    });
    expect(res.statusCode).toBe(200);
    return { orderId, shipmentId: res.json().shipments[0].id as number };
  }

  it('counts the shipped orders whose send has no number once they were changed for the days of the threshold', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const numberless = await sent(buyer, { carrier: 'DHL' });
    const numbered = await sent(buyer, { carrier: 'DHL', trackingNumber: 'A1' });
    const kind = 'shipped_without_tracking';

    // changed just now
    await expectCases(someone, kind, buyer, [], [numberless.orderId, numbered.orderId]);

    runClock(DEFAULT_DAYS.shipped_without_tracking * DAY - HOUR);
    await expectListed(someone, kind, buyer, [], [numberless.orderId, numbered.orderId]);

    runClock(DEFAULT_DAYS.shipped_without_tracking * DAY + HOUR);
    await expectListed(someone, kind, buyer, [numberless.orderId], [numbered.orderId]);
  });

  it('stops counting an order when its number is written', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const order = await sent(buyer, { carrier: 'DHL' });
    runClock(3 * DAY);
    await expectCases(someone, 'shipped_without_tracking', buyer, [order.orderId], []);

    const written = await change(
      admin,
      'PATCH',
      `/api/orders/${order.orderId}/shipments/${order.shipmentId}`,
      { trackingNumber: 'B2' },
    );
    expect(written.statusCode).toBe(200);

    await expectListed(someone, 'shipped_without_tracking', buyer, [], [order.orderId]);
  });

  it('counts only an order that is shipped now, with the send that is on its way', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    // sent without a number, then delivered: not shipped any more
    const delivered = await sent(buyer, { carrier: 'DHL' });
    const done = await change(admin, 'PATCH', `/api/orders/${delivered.orderId}/status`, {
      status: 'delivered',
    });
    expect(done.statusCode).toBe(200);
    // sent without a number, taken back and sent again with one: the send taken back does not count
    const again = await sent(buyer, { carrier: 'DHL' });
    const back = await change(admin, 'PATCH', `/api/orders/${again.orderId}/status`, {
      status: 'paid',
      keepShippingCost: false,
    });
    expect(back.statusCode).toBe(200);
    const resent = await change(admin, 'PATCH', `/api/orders/${again.orderId}/status`, {
      status: 'shipped',
      shipment: { carrier: 'UPS', trackingNumber: 'C3' },
    });
    expect(resent.statusCode).toBe(200);
    // sent without a number and taken back, not sent again
    const taken = await sent(buyer, { carrier: 'DHL' });
    const takenBack = await change(admin, 'PATCH', `/api/orders/${taken.orderId}/status`, {
      status: 'paid',
      keepShippingCost: false,
    });
    expect(takenBack.statusCode).toBe(200);
    runClock(10 * DAY);

    await expectCases(
      someone,
      'shipped_without_tracking',
      buyer,
      [],
      [delivered.orderId, again.orderId, taken.orderId],
    );
  });

  it('counts with the threshold the admin sets, and names its days in the list', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const order = await sent(buyer, { carrier: 'DHL' });
    const kind = 'shipped_without_tracking';
    await setThreshold(someone, kind, 5);

    runClock(5 * DAY - HOUR);
    await expectCases(someone, kind, buyer, [], [order.orderId]);

    runClock(5 * DAY + HOUR);
    await expectListed(someone, kind, buyer, [order.orderId], []);
    expect((await alertOf(someone, kind)).threshold).toBe(5);
  });
});

// ---- the transfers of the statements ----

// the transfers of the money of the statements of the buyer, the oldest asked first (the list of the
// refunds of the money journal): a transfer is named by its first line, the id of its case
async function transfersOf(buyer: TestUser) {
  const res = await get(admin, `/api/payments/refunds?purpose=return&userId=${buyer.id}&limit=100`);
  expect(res.statusCode).toBe(200);
  return (res.json().items as Array<{ id: number; returnId: number; state: string }>).sort(
    (a, b) => a.id - b.id,
  );
}

// the transfer of a statement, the first asked unless another is named
const transferOf = async (buyer: TestUser, returnId: number, nth = 0) => {
  const found = (await transfersOf(buyer)).filter((one) => one.returnId === returnId)[nth];
  if (!found) throw new Error(`the statement ${returnId} has no transfer ${nth}`);
  return found.id;
};

// the provider tells the transfer of a statement that is on its way sent or failed
async function settleTransfer(returnId: number, status: 'succeeded' | 'failed') {
  await testTx(async (tx) => {
    await setUserContext(tx, { userId: admin.id, role: 'ADMIN' });
    const { transferKey } = await tx.moneyLog.findFirstOrThrow({
      where: { returnId, event: 'money.refund', transferKey: { not: null } },
      orderBy: { id: 'desc' },
      select: { transferKey: true },
    });
    const failed = status === 'failed';
    await tx.$queryRaw`
      select cartlify.settle_money_refund(
        ${transferKey}::text, ${`re_test_${transferKey}`}::text, ${status},
        ${failed ? 'card_unavailable' : null}::cartlify."RefundFailure", ${failed ? 'test' : null}
      ) as done
    `;
  });
}

describe('return_refunds_failed', () => {
  const kind = 'return_refunds_failed';

  // a transfer the bank refused for a dispute the app does not follow (no dispute of the payment is
  // open in the app) waits for the shop as any failure: a dispute the app follows holds it
  // (alertsDisputes.test.ts)
  it('counts a failed transfer whose rows still owe its money, until the money goes back', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const failed = await received(buyer);
    await failReturnRefund(admin.id, failed.id);
    const disputed = await received(buyer);
    await failReturnRefund(admin.id, disputed.id, 'disputed');
    const failedTransfer = await transferOf(buyer, failed.id);
    const disputedTransfer = await transferOf(buyer, disputed.id);

    await expectCases(someone, kind, buyer, [failedTransfer, disputedTransfer], []);
    expect(
      (await listOf(someone, kind, { userId: buyer.id })).items.sort(
        (a, b) => Number(a.id) - Number(b.id),
      ),
    ).toEqual([
      expect.objectContaining({ id: failedTransfer, returnId: failed.id, purpose: 'return' }),
      expect.objectContaining({ id: disputedTransfer, returnId: disputed.id, purpose: 'return' }),
    ]);

    // the second try goes through
    await refundReturn(admin.id, failed.id);

    await expectListed(someone, kind, buyer, [disputedTransfer], [failedTransfer]);
  });

  // a row that waits for its first try has no transfer; one whose rows went at the second try, the
  // second try itself and one the provider has not answered yet wait for nothing of the shop
  it('counts no transfer of rows that wait for the first try, went at the second, or wait for the provider', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const waiting = await received(buyer);
    const retried = await received(buyer);
    await failReturnRefund(admin.id, retried.id, 'card_unavailable');
    await refundReturn(admin.id, retried.id);
    const pending = await received(buyer);
    await beginReturnRefund(admin.id, pending.id);

    expect((await transfersOf(buyer)).map((one) => one.returnId)).not.toContain(waiting.id);
    await expectListed(
      someone,
      kind,
      buyer,
      [],
      [
        await transferOf(buyer, retried.id),
        await transferOf(buyer, retried.id, 1),
        await transferOf(buyer, pending.id),
      ],
    );
  });

  it('counts at once, whatever the days, for the admin who reads', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const failed = await received(buyer);
    await failReturnRefund(admin.id, failed.id);
    const transfer = await transferOf(buyer, failed.id);

    await expectCases(someone, kind, buyer, [transfer], []);

    runClock(400 * DAY);
    await expectListed(someone, kind, buyer, [transfer], []);
  });

  it('leaves the count of the admin who put the case aside, for that admin only, and takes the mark off when the case is over', async () => {
    const someone = await newAdmin();
    const other = await newAdmin();
    const buyer = await newBuyer();
    const failed = await received(buyer);
    await failReturnRefund(admin.id, failed.id);
    const transfer = await transferOf(buyer, failed.id);

    const res = await dismiss(someone, kind, transfer);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind, id: String(transfer), dismissed: true });
    expect((await alertOf(someone, kind)).dismissed).toBe(1);
    expect((await alertOf(other, kind)).dismissed).toBe(0);
    const aside = await get(someone, '/api/admin/alerts/dismissals');
    expect(aside.json().items).toEqual([
      { kind, id: String(transfer), dismissedAt: expect.any(String) },
    ]);

    await refundReturn(admin.id, failed.id);

    expect((await alertOf(someone, kind)).dismissed).toBe(0);
    expect((await get(someone, '/api/admin/alerts/dismissals')).json().items).toEqual([]);
  });
});

describe('return_refunds_in_transit', () => {
  const kind = 'return_refunds_in_transit';

  it('has a threshold of 3 days from 1 to 365 until the admin sets one', async () => {
    const res = await get(await newAdmin(), '/api/admin/alerts/subscriptions');

    expect((res.json().items as Array<{ kind: string }>).find((one) => one.kind === kind)).toEqual({
      kind,
      subscribed: true,
      threshold: { value: 3, default: 3, min: 1, max: 365, unit: 'days', custom: false },
    });
  });

  it('counts a transfer the provider has not told sent, asked more than the days ago', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const pending = await received(buyer);
    await beginReturnRefund(admin.id, pending.id);
    const transfer = await transferOf(buyer, pending.id);
    // a transfer told sent at once is none, however old
    const sent = await received(buyer);
    await refundReturn(admin.id, sent.id);
    const done = await transferOf(buyer, sent.id);

    await expectCases(someone, kind, buyer, [], [transfer, done]);

    runClock(3 * DAY - HOUR);
    await expectListed(someone, kind, buyer, [], [transfer, done]);

    runClock(3 * DAY + HOUR);
    await expectListed(someone, kind, buyer, [transfer], [done]);
  });

  it('counts with the threshold the admin sets, and names its days in the list', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const pending = await received(buyer);
    await beginReturnRefund(admin.id, pending.id);
    const transfer = await transferOf(buyer, pending.id);
    expect((await setThreshold(someone, kind, 5)).statusCode).toBe(200);

    runClock(5 * DAY - HOUR);
    await expectCases(someone, kind, buyer, [], [transfer]);
    expect(
      Math.abs(Date.now() - Date.parse((await alertOf(someone, kind)).list!.query.to!) - 5 * DAY),
    ).toBeLessThan(HOUR);

    runClock(5 * DAY + HOUR);
    await expectListed(someone, kind, buyer, [transfer], []);
  });

  it('stops counting a transfer once it is told sent, and hands one that failed to the failed ones', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const toSend = await received(buyer);
    await beginReturnRefund(admin.id, toSend.id);
    const toFail = await received(buyer);
    await beginReturnRefund(admin.id, toFail.id);
    const sent = await transferOf(buyer, toSend.id);
    const failed = await transferOf(buyer, toFail.id);
    runClock(3 * DAY + HOUR);
    await expectCases(someone, kind, buyer, [sent, failed], []);

    await settleTransfer(toSend.id, 'succeeded');
    await settleTransfer(toFail.id, 'failed');

    await expectListed(someone, kind, buyer, [], [sent, failed]);
    await expectCases(someone, 'return_refunds_failed', buyer, [failed], [sent]);
  });
});

describe('returns_manual_check', () => {
  const kind = 'returns_manual_check';

  it('counts the open statements of the public form that no code vouches for, until an admin accepts them', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const byHand = await fromForm(buyer, false);
    const secondByHand = await fromForm(buyer, false);
    const withCode = await fromForm(buyer, true);
    const ofAccount = await fromAccount(buyer, false);
    const byAdmin = await stated(buyer);

    await expectCases(
      someone,
      kind,
      buyer,
      [byHand, secondByHand],
      [withCode, ofAccount, byAdmin.id],
    );

    // the admin checks the first and accepts it: it leaves the alert, its goods and money go on
    await flows.acceptStatement(byHand);
    await expectCases(someone, kind, buyer, [secondByHand], [byHand]);

    await setGoods(await cardOf(byHand), 1, 'to_stock');
    await refundReturn(admin.id, byHand);
    await expectListed(someone, kind, buyer, [secondByHand], [byHand]);
  });

  // a step of the goods or of the money waits for the acceptance (RETURN_NOT_ACCEPTED), so the
  // acceptance alone takes a statement out
  it('stops counting a statement once an admin accepts it, though it stays open', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const byHand = await fromForm(buyer, false);
    await expectCases(someone, kind, buyer, [byHand], []);

    await flows.acceptStatement(byHand);

    await expectListed(someone, kind, buyer, [], [byHand]);
  });

  it('counts at once, whatever the days', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const byHand = await fromForm(buyer, false);

    runClock(100 * DAY);

    await expectCases(someone, kind, buyer, [byHand], []);
  });

  it('stops counting a statement the root closes without a refund', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const byHand = await fromForm(buyer, false);
    await expectCases(someone, kind, buyer, [byHand], []);

    await closeWithoutRefund(byHand);

    await expectListed(someone, kind, buyer, [], [byHand]);
  });
});

describe('returns_proof_waiting', () => {
  const kind = 'returns_proof_waiting';
  const days = DEFAULT_DAYS.returns_proof_waiting;

  it('counts the open statements whose buyer told of the parcel and the shop has not confirmed it for the days of the threshold', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const told = await fromAccount(buyer, true);
    const silent = await fromAccount(buyer, false);
    const confirmed = await fromAccount(buyer, true);
    await confirmProof(confirmed);
    // told of, and then the goods came in without the proof being confirmed: nothing waits any more
    const arrived = await fromAccount(buyer, true);
    await setGoods(await cardOf(arrived), 1, 'to_stock');
    const rest = [silent, confirmed, arrived];

    await expectCases(someone, kind, buyer, [], [told, ...rest]);

    runClock(days * DAY - HOUR);
    await expectListed(someone, kind, buyer, [], [told, ...rest]);

    runClock(days * DAY + HOUR);
    await expectListed(someone, kind, buyer, [told], rest);

    // the shop confirms it: nothing waits for the shop any more
    await confirmProof(told);

    await expectListed(someone, kind, buyer, [], [told, ...rest]);
  });

  it('counts with the threshold the admin sets', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const told = await fromAccount(buyer, true);
    await setThreshold(someone, kind, 5);

    runClock(3 * DAY);
    await expectCases(someone, kind, buyer, [], [told]);

    runClock(5 * DAY - HOUR);
    await expectListed(someone, kind, buyer, [], [told]);

    runClock(5 * DAY + HOUR);
    await expectListed(someone, kind, buyer, [told], []);
    expect((await alertOf(someone, kind)).list!.query.proofOlderThanDays).toBe('5');
  });

  it('counts the proof of a statement of the form with the code too', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const placed = await shippedOrder(buyer, product, 1);
    const returnId = await flows.formStatement(placed.orderId, true, `form.${tag}@example.com`);
    const res = await post(
      '/api/withdrawals/proof',
      {
        orderId: placed.orderId,
        code: withdrawalCodeOf(placed.orderId),
        returnId,
        carrier: 'DHL',
        trackingNumber: 'JD0146000123',
      },
      null,
    );
    expect(res.statusCode).toBe(200);

    runClock(days * DAY + HOUR);

    await expectCases(someone, kind, buyer, [returnId], []);
  });
});

describe('returns_goods_not_sent', () => {
  const kind = 'returns_goods_not_sent';
  const days = DEFAULT_DAYS.returns_goods_not_sent;

  it('counts the open statements whose goods are expected and whose buyer told nothing of the parcel, stated more than the days ago', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const silent = (await stated(buyer)).id;
    const byForm = await fromForm(buyer, true);
    // the buyer told of the parcel: this is the proof kinds' case
    const told = await fromAccount(buyer, true);
    // the goods are in already
    const inShop = (await received(buyer)).id;
    // closed without a refund by the root
    const closed = (await stated(buyer)).id;
    await closeWithoutRefund(closed);
    const rest = [told, inShop, closed];

    await expectCases(someone, kind, buyer, [], [silent, byForm, ...rest]);

    runClock(days * DAY - HOUR);
    await expectListed(someone, kind, buyer, [], [silent, byForm, ...rest]);

    runClock(days * DAY + HOUR);
    await expectListed(someone, kind, buyer, [silent, byForm], rest);

    // the root closes one: it is no case any more
    await closeWithoutRefund(silent);

    await expectListed(someone, kind, buyer, [byForm], [silent, ...rest]);
  });

  it('counts with the threshold the admin sets', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const silent = (await stated(buyer)).id;
    await setThreshold(someone, kind, 3);

    runClock(3 * DAY - HOUR);
    await expectCases(someone, kind, buyer, [], [silent]);

    runClock(3 * DAY + HOUR);
    await expectListed(someone, kind, buyer, [silent], []);
    expect((await alertOf(someone, kind)).list!.query.olderThanDays).toBe('3');
  });

  it('stops counting a statement when the buyer tells of the parcel', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const placed = await shippedOrder(buyer, product, 1);
    const id = await flows.withdrawFromAccount(buyer, placed.orderId);
    runClock(days * DAY + HOUR);
    await expectCases(someone, kind, buyer, [id], []);

    await flows.tellOfParcel(buyer, placed.orderId, id);

    await expectListed(someone, kind, buyer, [], [id]);
  });
});

describe('returns_money_late', () => {
  const kind = 'returns_money_late';
  const days = DEFAULT_DAYS.returns_money_late;

  // the money of a row is due when the goods are in, or the shop confirmed the proof of the parcel,
  // and it is late when it is not back yet (not refunded, or on its way) so many days after the
  // statement; a statement whose goods were not sent is a case of the goods (returns_goods_not_sent)
  async function scenario(buyer: TestUser) {
    // due: the goods are on the shelf and the money is not tried
    const goodsIn = (await received(buyer)).id;
    // due: the goods are expected but the shop confirmed the proof of the parcel
    const confirmed = await stated(buyer);
    await confirmProof(confirmed.id);
    // due: the goods are in and the transfer waits for the provider
    const onItsWay = await received(buyer);
    await beginReturnRefund(admin.id, onItsWay.id);
    // due: the goods are in and the transfer failed
    const failed = await received(buyer);
    await failReturnRefund(admin.id, failed.id);
    // not due: the goods are expected and nothing proves the parcel
    const expected = (await stated(buyer)).id;
    // not due: the buyer told of the parcel and the shop has not confirmed it
    const told = await fromAccount(buyer, true);
    // not due: the money is back
    const back = await received(buyer);
    await refundReturn(admin.id, back.id);

    return {
      due: [goodsIn, confirmed.id, onItsWay.id, failed.id],
      notDue: [expected, told, back.id],
      goodsIn,
    };
  }

  it('counts the open statements whose money is due and not back, stated more than the days ago', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const { due, notDue } = await scenario(buyer);

    await expectCases(someone, kind, buyer, [], [...due, ...notDue]);

    runClock(days * DAY - HOUR);
    await expectListed(someone, kind, buyer, [], [...due, ...notDue]);

    runClock(days * DAY + HOUR);
    await expectListed(someone, kind, buyer, due, notDue);
  });

  it('stops counting a statement once its money goes back', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const goodsIn = (await received(buyer)).id;
    const failed = await received(buyer);
    await failReturnRefund(admin.id, failed.id);
    runClock(days * DAY + HOUR);
    await expectListed(someone, kind, buyer, [goodsIn, failed.id], []);

    await refundReturn(admin.id, goodsIn);

    await expectListed(someone, kind, buyer, [failed.id], [goodsIn]);
  });

  it('counts with the threshold the admin sets', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const { due, notDue } = await scenario(buyer);
    await setThreshold(someone, kind, 4);

    runClock(4 * DAY - HOUR);
    await expectCases(someone, kind, buyer, [], [...due, ...notDue]);

    runClock(4 * DAY + HOUR);
    await expectListed(someone, kind, buyer, due, notDue);
    expect((await alertOf(someone, kind)).list!.query.moneyDueForDays).toBe('4');
  });
});

describe('returns_goods_late', () => {
  const kind = 'returns_goods_late';
  const days = DEFAULT_DAYS.returns_goods_late;

  // the money went back before the goods: the shop confirmed the proof of the parcel and paid
  async function paidAhead(buyer: TestUser) {
    const card = await stated(buyer);
    await confirmProof(card.id);
    await refundReturn(admin.id, card.id);
    return card;
  }

  it('counts the open statements whose money went back more than the days ago while the goods are not in', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const ahead = await paidAhead(buyer);
    // the goods and the money are both in: closed
    const done = await received(buyer);
    await refundReturn(admin.id, done.id);
    // the goods are expected and the money is not back
    const expected = await stated(buyer);
    // the goods are in, the money is not back
    const goodsOnly = await received(buyer);
    // paid ahead, and the goods came in since: closed
    const arrived = await paidAhead(buyer);
    await setGoods(arrived, 1, 'to_stock');
    const rest = [done.id, expected.id, goodsOnly.id, arrived.id];

    await expectCases(someone, kind, buyer, [], [ahead.id, ...rest]);

    runClock(days * DAY - HOUR);
    await expectListed(someone, kind, buyer, [], [ahead.id, ...rest]);

    runClock(days * DAY + HOUR);
    await expectListed(someone, kind, buyer, [ahead.id], rest);

    // the goods come in: no case any more
    await setGoods(await cardOf(ahead.id), 1, 'to_stock');

    await expectListed(someone, kind, buyer, [], [ahead.id, ...rest]);
  });

  it('counts with the threshold the admin sets', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const ahead = await paidAhead(buyer);
    await setThreshold(someone, kind, 3);

    runClock(3 * DAY - HOUR);
    await expectCases(someone, kind, buyer, [], [ahead.id]);

    runClock(3 * DAY + HOUR);
    await expectListed(someone, kind, buyer, [ahead.id], []);
    expect((await alertOf(someone, kind)).list!.query.paidAheadForDays).toBe('3');
  });
});

describe('a case of a kind of the statements put aside', () => {
  it('is put aside by the id of the statement, for the admin who put it, and goes by itself once the case is over', async () => {
    const someone = await newAdmin();
    const other = await newAdmin();
    const buyer = await newBuyer();
    const byHand = await fromForm(buyer, false);
    const kind = 'returns_manual_check';

    const res = await dismiss(someone, kind, byHand);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ kind, id: String(byHand), dismissed: true });
    expect((await alertOf(someone, kind)).dismissed).toBe(1);
    expect((await alertOf(other, kind)).dismissed).toBe(0);

    await closeWithoutRefund(byHand);

    expect((await alertOf(someone, kind)).dismissed).toBe(0);
    expect((await get(someone, '/api/admin/alerts/dismissals')).json().items).toEqual([]);
  });

  it('is not put aside when it is no case of the kind: another kind, another id', async () => {
    const someone = await newAdmin();
    const buyer = await newBuyer();
    const byHand = await fromForm(buyer, false);

    // a statement of the form is a case of the manual check and of no other kind
    await expectNotCounted(someone, 'returns_money_late', byHand);
    await expectNotCounted(someone, 'returns_manual_check', 2_000_000_000);
  });
});
