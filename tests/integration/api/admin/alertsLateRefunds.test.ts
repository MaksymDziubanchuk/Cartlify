import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  deliverOk,
  failedLateRefund,
  latePayment,
  refundEvent,
  refundOf,
} from '../../../helpers/lateRefund.js';
import { moveClock } from '../../../helpers/payments.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import { failReturnRefund } from '../../../helpers/returns.js';
import {
  closeOpenSessions,
  deliver,
  queueRefundOutcome,
  realStripe,
} from '../../../helpers/stripe.js';

// The alerts of the refunds of the payments an order could not take (GET /api/admin/alerts):
// failed_refunds counts the refunds that failed together with the transfers of the statements that
// failed, until root records the money as sent another way; refunded_payments_not_sent counts the
// refunds made some days ago that the provider has told neither sent nor failed. The count of an
// alert is the total of the list it names (GET /api/payments/refunds), and a case is put aside by
// its id (the id of the refund at the provider, or of the statement).
//
// The alerts of the shop are shared by every file that runs at the same time, so a test looks at
// its own cases: the list narrowed to the buyer of the test, and the cases the admin can put aside,
// which the server lets only for a case the alert counts now. The count and the total of the whole
// shop are read again until two reads in a row agree, because another file may add a case between
// them. The refunds are made by the clock of the database and the alerts count their days from
// the clock of the app: a test ages the cases by moving the clock, a margin of an hour on both
// sides of a day keeps the check clear of the small difference the two clocks may have.

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let buyer: TestUser;
let product: TestProduct;
const userIds: number[] = [];
const products: TestProduct[] = [];
let clock: { restore: () => void } | null = null;
const deps = () => ({ app, csrf, users: userIds, products });

const DAY = 86_400_000;
const HOUR = 3_600_000;

const mockOnly = realStripe ? it.skip : it;

const flows = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });

const newAdmin = async () => {
  const user = await createUser({ role: 'ADMIN' });
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newAdmin();
  root = await createUser({ role: 'ROOT' });
  buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(root.id, buyer.id);
  product = await createProduct({ price: 10, stock: 500 });
  products.push(product);
});

afterEach(() => {
  clock?.restore();
  clock = null;
});

afterAll(async () => {
  try {
    await closeOpenSessions();
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Alert = {
  kind: string;
  count: number;
  dismissed: number;
  threshold: number | null;
  list: { path: string; query: Record<string, string> } | null;
};

// the token is signed at each request: a test that runs the clock forward gets one of that time
const get = (actor: TestUser, url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(actor) } });

const change = (actor: TestUser, method: 'PUT' | 'DELETE', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: withCsrf(csrf, accessCookie(actor)),
    ...(payload ? { payload } : {}),
  });

const alertOf = async (actor: TestUser, kind: string) => {
  const res = await get(actor, '/api/admin/alerts');
  expect(res.statusCode).toBe(200);
  return (res.json().alerts as Alert[]).find((alert) => alert.kind === kind)!;
};

const runClock = (ms: number) => {
  clock?.restore();
  clock = moveClock(ms);
};

const setThreshold = (actor: TestUser, kind: string, value: unknown) =>
  change(actor, 'PUT', `/api/admin/alerts/subscriptions/${kind}/threshold`, { value });

const dismiss = (actor: TestUser, kind: string, id: string, on = true) =>
  change(actor, on ? 'PUT' : 'DELETE', `/api/admin/alerts/dismissals/${kind}/${id}`);

// the list the alert of a kind names, narrowed to the rows of the test
async function listOf(actor: TestUser, kind: string, userId: number) {
  const { list } = await alertOf(actor, kind);
  const query = new URLSearchParams({ ...list!.query, userId: String(userId), limit: '100' });
  const res = await get(actor, `${list!.path}?${query}`);
  expect(res.statusCode).toBe(200);
  return res.json() as { items: Array<{ id: string; source: string; at: string }>; total: number };
}

const idsOf = async (actor: TestUser, kind: string, userId: number) =>
  (await listOf(actor, kind, userId)).items.map((row) => row.id).sort();

// the count of the alert is the total of its list with its own query, whatever other files add
// meanwhile: the two are read again, up to ten times, until the count read before the list, the
// total of the list and the count read after it are one number
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

// root records the money as sent another way, on the day the refund failed
const markOutside = (refundId: string, at: string) =>
  app.inject({
    method: 'POST',
    url: `/api/payments/refunds/${refundId}/outside`,
    headers: withCsrf(csrf, accessCookie(root)),
    payload: { method: 'bank_transfer', note: 'Sent by hand.', at },
  });

describe('failed_refunds and the late payments', () => {
  const kind = 'failed_refunds';

  it('names the list of the refunds that wait, with no threshold', async () => {
    const alert = await alertOf(admin, kind);

    expect(alert).toMatchObject({
      threshold: null,
      list: { path: '/api/payments/refunds', query: { state: 'failed' } },
    });
  });

  it('counts a late payment whose refund failed, until root records the money as sent another way', async () => {
    const failed = await failedLateRefund(deps());
    const someone = await newAdmin();

    expect(await idsOf(someone, kind, failed.user.id)).toEqual([failed.refundId]);
    expect(await idsOf(root, kind, failed.user.id)).toEqual([failed.refundId]);
    // the admin can put the case aside: the server counts it now
    expect((await dismiss(someone, kind, failed.refundId)).statusCode).toBe(200);
    expect((await alertOf(someone, kind)).dismissed).toBe(1);
    expect((await dismiss(someone, kind, failed.refundId, false)).statusCode).toBe(200);
    await expectCountIsTotalOfList(someone, kind);

    const [made] = (await listOf(someone, kind, failed.user.id)).items;
    expect(made!.source).toBe('payment');
    const marked = await markOutside(
      failed.refundId,
      (await listOf(someone, kind, failed.user.id)).items[0]!.at,
    );
    expect(marked.statusCode).toBe(200);

    expect(await idsOf(someone, kind, failed.user.id)).toEqual([]);
    const gone = await dismiss(someone, kind, failed.refundId);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toMatchObject({ errorCode: 'ALERT_ITEM_NOT_FOUND' });
    await expectCountIsTotalOfList(someone, kind);
  });

  it('counts at once, whatever the days, for every admin', async () => {
    const failed = await failedLateRefund(deps());
    const someone = await newAdmin();

    runClock(400 * DAY);

    expect(await idsOf(someone, kind, failed.user.id)).toEqual([failed.refundId]);
  });

  it('counts a statement whose transfer failed together with it, the same alert', async () => {
    const failed = await failedLateRefund(deps());
    const someone = await newAdmin();
    const placed = await flows.shippedOrder(failed.user, product, 1);
    const card = await flows.adminStatement(placed.orderId, placed.itemId, 1);
    await flows.setGoods(card, 1, 'to_stock');
    await failReturnRefund(admin.id, card.id, 'card_unavailable');

    expect(await idsOf(someone, kind, failed.user.id)).toEqual(
      [failed.refundId, String(card.id)].sort(),
    );
    // each case is put aside by its own id
    expect((await dismiss(someone, kind, String(card.id))).statusCode).toBe(200);
    expect((await dismiss(someone, kind, failed.refundId)).statusCode).toBe(200);
    expect((await alertOf(someone, kind)).dismissed).toBe(2);
    // the cases put aside stay in the list: taken back, the count is the total again
    expect((await dismiss(someone, kind, String(card.id), false)).statusCode).toBe(200);
    expect((await dismiss(someone, kind, failed.refundId, false)).statusCode).toBe(200);
    await expectCountIsTotalOfList(someone, kind);
  });

  it('leaves the count of the admin who put the case aside, for that admin only', async () => {
    const failed = await failedLateRefund(deps());
    const someone = await newAdmin();
    const other = await newAdmin();

    expect((await dismiss(someone, kind, failed.refundId)).statusCode).toBe(200);

    expect((await alertOf(someone, kind)).dismissed).toBe(1);
    expect((await alertOf(other, kind)).dismissed).toBe(0);
  });

  it('does not count a refund whose money was sent', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const someone = await newAdmin();

    expect(await idsOf(someone, kind, late.user.id)).toEqual([]);
    const refused = await dismiss(someone, kind, (await refundOf(late.paymentId)).id);
    expect(refused.statusCode).toBe(404);
  });

  it('counts a refund that was sent and then failed: the bank sent the money back', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const refund = await refundOf(late.paymentId);
    const someone = await newAdmin();
    expect(await idsOf(someone, kind, late.user.id)).toEqual([]);

    await deliverOk(
      app,
      refundEvent('refund.failed', {
        id: refund.id,
        paymentId: late.paymentId,
        status: 'failed',
        reason: 'expired_or_canceled_card',
      }),
    );

    expect(await idsOf(someone, kind, late.user.id)).toEqual([refund.id]);
  });
});

describe('refunded_payments_not_sent', () => {
  const kind = 'refunded_payments_not_sent';

  // a refund of a late payment the provider has not told sent or failed
  async function pendingRefund() {
    const late = await latePayment(deps());
    queueRefundOutcome({ status: 'pending' });
    await deliver(app, late.event);
    return { ...late, refundId: (await refundOf(late.paymentId)).id };
  }

  it('sits after the late payments given back, with three days unless set', async () => {
    const someone = await newAdmin();
    const res = await get(someone, '/api/admin/alerts');
    const alerts = res.json().alerts as Alert[];
    const kinds = alerts.map((alert) => alert.kind);

    expect(kinds.indexOf(kind)).toBe(kinds.indexOf('refunded_payments') + 1);
    expect(kinds.indexOf('failed_refunds')).toBe(kinds.indexOf(kind) + 1);
    expect(alerts.find((alert) => alert.kind === kind)).toMatchObject({
      subscribed: true,
      dismissed: 0,
      threshold: 3,
      list: { path: '/api/payments/refunds', query: { state: 'unsent' } },
    });
    expect(alerts.find((alert) => alert.kind === kind)!.list!.query.to).toEqual(expect.any(String));
  });

  it('is a kind with a threshold of days within 1 to 365, for admin and root', async () => {
    const someone = await newAdmin();

    for (const actor of [someone, root]) {
      const subscriptions = (await get(actor, '/api/admin/alerts/subscriptions')).json().items as {
        kind: string;
        threshold: unknown;
      }[];
      expect(subscriptions.find((one) => one.kind === kind)!.threshold).toEqual({
        value: 3,
        default: 3,
        min: 1,
        max: 365,
        unit: 'days',
        custom: false,
      });
    }
    for (const value of [0, 366, 1.5, 'x']) {
      const res = await setThreshold(someone, kind, value);
      expect(res.statusCode).toBe(400);
    }
    expect((await setThreshold(someone, kind, 365)).statusCode).toBe(200);
    expect((await alertOf(someone, kind)).threshold).toBe(365);
  });

  mockOnly(
    'counts a refund made more than the threshold days ago that is not told sent',
    async () => {
      const pending = await pendingRefund();
      const someone = await newAdmin();

      runClock(3 * DAY - HOUR);
      expect(await idsOf(someone, kind, pending.user.id)).toEqual([]);
      const early = await dismiss(someone, kind, pending.refundId);
      expect(early.statusCode).toBe(404);
      expect(early.json()).toMatchObject({ errorCode: 'ALERT_ITEM_NOT_FOUND' });

      runClock(3 * DAY + HOUR);
      expect(await idsOf(someone, kind, pending.user.id)).toEqual([pending.refundId]);
      expect((await dismiss(someone, kind, pending.refundId)).statusCode).toBe(200);
      expect((await alertOf(someone, kind)).dismissed).toBe(1);
      expect((await dismiss(someone, kind, pending.refundId, false)).statusCode).toBe(200);
      await expectCountIsTotalOfList(someone, kind);
    },
  );

  mockOnly('counts with the threshold the admin sets, and names its days in the list', async () => {
    const pending = await pendingRefund();
    const someone = await newAdmin();
    const other = await newAdmin();
    expect((await setThreshold(someone, kind, 5)).statusCode).toBe(200);

    runClock(4 * DAY + HOUR);
    expect(await idsOf(someone, kind, pending.user.id)).toEqual([]);
    expect(await idsOf(other, kind, pending.user.id)).toEqual([pending.refundId]);

    runClock(5 * DAY + HOUR);
    expect(await idsOf(someone, kind, pending.user.id)).toEqual([pending.refundId]);
  });

  mockOnly('stops counting a refund once its money is told sent', async () => {
    const pending = await pendingRefund();
    const someone = await newAdmin();
    runClock(3 * DAY + HOUR);
    expect(await idsOf(someone, kind, pending.user.id)).toEqual([pending.refundId]);

    await deliverOk(
      app,
      refundEvent('refund.updated', {
        id: pending.refundId,
        paymentId: pending.paymentId,
        status: 'succeeded',
      }),
    );

    expect(await idsOf(someone, kind, pending.user.id)).toEqual([]);
    expect(await idsOf(someone, 'failed_refunds', pending.user.id)).toEqual([]);
  });

  mockOnly('hands a refund that failed over to the failed refunds', async () => {
    const pending = await pendingRefund();
    const someone = await newAdmin();
    runClock(3 * DAY + HOUR);
    expect(await idsOf(someone, kind, pending.user.id)).toEqual([pending.refundId]);

    await deliverOk(
      app,
      refundEvent('refund.failed', {
        id: pending.refundId,
        paymentId: pending.paymentId,
        status: 'failed',
        reason: 'expired_or_canceled_card',
      }),
    );

    expect(await idsOf(someone, kind, pending.user.id)).toEqual([]);
    expect(await idsOf(someone, 'failed_refunds', pending.user.id)).toEqual([pending.refundId]);
  });

  it('never counts a refund whose money was sent at once, however old', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const someone = await newAdmin();

    runClock(30 * DAY);

    expect(await idsOf(someone, kind, late.user.id)).toEqual([]);
    await expectCountIsTotalOfList(someone, kind);
  });
});
