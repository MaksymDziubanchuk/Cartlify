import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { settleRefundsInTransit } from '@routes/api/payments/services/settleRefundsInTransit.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { alertsOf } from '../../../helpers/alerts.js';
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
  lateRefundFailedAtStripe,
  latePayment,
  refundEvent,
  refundOf,
} from '../../../helpers/lateRefund.js';
import { moveClock } from '../../../helpers/payments.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import { failReturnRefund, refundReturn } from '../../../helpers/returns.js';
import {
  closeOpenSessions,
  deliver,
  disputeEvent,
  endDispute,
  openDispute,
  queueRefundOutcome,
  realStripe,
  withStripeOutOfReach,
} from '../../../helpers/stripe.js';

// The alerts of the refunds of the payments an order could not take (GET /api/admin/alerts), each
// followed on its own:
// late_refunds counts the refunds that came to their state in the last days (the buyer may ask),
// late_refunds_in_transit the refunds asked some days ago that the provider has told neither sent nor
// failed, late_refunds_failed the refunds that failed until root records the money as sent another
// way. A refund the bank refused for a dispute waits for the dispute (disputes_to_answer), and so
// does a failure while a dispute of the payment is open. The count of an alert is the total of the
// list it names (GET /api/payments/refunds), and a case is put aside by the id of the refund there:
// its first line in the money journal.
//
// The alerts of the shop are shared by every file that runs at the same time, so a test looks at
// its own cases: the list narrowed to the buyer of the test, and the cases the admin can put aside,
// which the server lets only for a case the alert counts now. The refunds are made by the clock of
// the database and the alerts count their days from the clock of the app: a test ages the cases by
// moving the clock, a margin of an hour on both sides of a day keeps the check clear of the small
// difference the two clocks may have.

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;
const userIds: number[] = [];
const products: TestProduct[] = [];
let clock: { restore: () => void } | null = null;
const deps = () => ({ app, csrf, users: userIds, products });

const DAY = 86_400_000;
const HOUR = 3_600_000;

const mockOnly = realStripe ? it.skip : it;

const flows = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });
const alerts = alertsOf({ app: () => app, csrf: () => csrf });
const { alertOf, idsOf, dismiss, setThreshold, subscriptionOf, expectListed, expectCases } = alerts;

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
  userIds.push(root.id);
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

const runClock = (ms: number) => {
  clock?.restore();
  clock = moveClock(ms);
};

// the refund of the late payment of the buyer in the list of the refunds: its first line, the id of
// its case
async function refundIdOf(buyer: TestUser): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/payments/refunds?purpose=late_payment&userId=${buyer.id}`,
    headers: { cookie: accessCookie(admin) },
  });
  expect(res.statusCode).toBe(200);
  const [refund, ...others] = res.json().items as Array<{ id: number }>;
  if (!refund || others.length) throw new Error('the buyer has no single late refund');
  return refund.id;
}

// root records the money as sent another way, on the day the refund failed
const markOutside = (refundId: number, at: string) =>
  app.inject({
    method: 'POST',
    url: `/api/payments/refunds/${refundId}/outside`,
    headers: withCsrf(csrf, accessCookie(root)),
    payload: { method: 'bank_transfer', note: 'Sent by hand.', at },
  });

// a refund of a late payment the provider has not told sent or failed
async function pendingRefund() {
  const late = await latePayment(deps());
  queueRefundOutcome({ status: 'pending' });
  await deliver(app, late.event);
  return { ...late, refundId: (await refundOf(late.paymentId)).id };
}

// the bank opens a chargeback of the payment (the money leaves the shop), or an inquiry (no money
// moves), and Stripe tells of it
async function disputed(paymentId: string, status?: 'warning_needs_response') {
  const disputeId = openDispute(paymentId, status ? { status } : {});
  const types = ['charge.dispute.created', ...(status ? [] : ['charge.dispute.funds_withdrawn'])];
  for (const type of types) {
    const res = await deliver(app, await disputeEvent(type, disputeId));
    expect(res.statusCode).toBe(200);
  }
  return disputeId;
}

// the bank ends it and Stripe tells of it: won puts the money back with the shop
const ended = async (disputeId: string, end: 'warning_closed' | 'won' | 'lost') => {
  endDispute(disputeId, end);
  const types = [
    'charge.dispute.closed',
    ...(end === 'won' ? ['charge.dispute.funds_reinstated'] : []),
  ];
  for (const type of types) {
    const res = await deliver(app, await disputeEvent(type, disputeId));
    expect(res.statusCode).toBe(200);
  }
};

describe('the kinds of the late refunds', () => {
  it('go together after the chats, for admin and root', async () => {
    const someone = await newAdmin();

    for (const actor of [someone, root]) {
      const kinds = (await alerts.alerts(actor)).map((alert) => alert.kind);
      const at = kinds.indexOf('late_refunds');
      expect(at).toBe(kinds.indexOf('chats_waiting') + 1);
      expect(kinds.slice(at, at + 3)).toEqual([
        'late_refunds',
        'late_refunds_in_transit',
        'late_refunds_failed',
      ]);
    }
  });

  it('have the thresholds of their days, the failed ones none', async () => {
    const someone = await newAdmin();
    const days = (value: number) => ({
      value,
      default: value,
      min: 1,
      max: 365,
      unit: 'days',
      custom: false,
    });

    expect(await subscriptionOf(someone, 'late_refunds')).toEqual({
      kind: 'late_refunds',
      subscribed: true,
      threshold: days(7),
    });
    expect(await subscriptionOf(someone, 'late_refunds_in_transit')).toEqual({
      kind: 'late_refunds_in_transit',
      subscribed: true,
      threshold: days(3),
    });
    expect(await subscriptionOf(someone, 'late_refunds_failed')).toEqual({
      kind: 'late_refunds_failed',
      subscribed: true,
      threshold: null,
    });
    for (const value of [0, 366, 1.5, 'x']) {
      expect((await setThreshold(someone, 'late_refunds_in_transit', value)).statusCode).toBe(400);
    }
    expect((await setThreshold(someone, 'late_refunds_failed', 3)).statusCode).toBe(404);
  });
});

describe('late_refunds', () => {
  const kind = 'late_refunds';

  it('names the refunds of the late payments that came to their state in the days', async () => {
    const alert = await alertOf(await newAdmin(), kind);

    expect(alert).toMatchObject({
      threshold: 7,
      list: { path: '/api/payments/refunds', query: { purpose: 'late_payment' } },
    });
    expect(Math.abs(Date.now() - Date.parse(alert.list!.query.from!) - 7 * DAY)).toBeLessThan(HOUR);
  });

  it('counts a refund of a late payment within the days of the threshold', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const refund = await refundIdOf(late.user);
    const someone = await newAdmin();
    const other = await newAdmin();
    expect((await setThreshold(other, kind, 10)).statusCode).toBe(200);

    await expectCases(someone, kind, { userId: late.user.id }, [refund]);

    runClock(7 * DAY - HOUR);
    await expectListed(someone, kind, { userId: late.user.id }, [refund]);

    runClock(7 * DAY + HOUR);
    await expectListed(someone, kind, { userId: late.user.id }, [], [refund]);
    await expectListed(other, kind, { userId: late.user.id }, [refund]);
  });

  // the money of a statement goes back by a transfer of the money journal too: it is no late payment
  it('does not count the transfer of a statement', async () => {
    const buyer = await createUser({ name: 'Anna Koval' });
    userIds.push(buyer.id);
    const placed = await flows.shippedOrder(buyer, product, 1);
    const card = await flows.adminStatement(placed.orderId, placed.itemId, 1);
    await flows.setGoods(card, 1, 'to_stock');
    await refundReturn(admin.id, card.id);

    expect(await idsOf(await newAdmin(), kind, { userId: buyer.id })).toEqual([]);
  });
});

describe('late_refunds_in_transit', () => {
  const kind = 'late_refunds_in_transit';

  it('names the late refunds in transit asked before the days', async () => {
    const alert = await alertOf(await newAdmin(), kind);

    expect(alert).toMatchObject({
      threshold: 3,
      list: {
        path: '/api/payments/refunds',
        query: { purpose: 'late_payment', state: 'in_transit' },
      },
    });
    expect(Math.abs(Date.now() - Date.parse(alert.list!.query.to!) - 3 * DAY)).toBeLessThan(HOUR);
  });

  mockOnly(
    'counts a refund made more than the threshold days ago that is not told sent',
    async () => {
      const pending = await pendingRefund();
      const refund = await refundIdOf(pending.user);
      const someone = await newAdmin();

      runClock(3 * DAY - HOUR);
      await expectCases(someone, kind, { userId: pending.user.id }, [], [refund]);

      runClock(3 * DAY + HOUR);
      await expectListed(someone, kind, { userId: pending.user.id }, [refund]);
      await expectListed(root, kind, { userId: pending.user.id }, [refund]);
    },
  );

  mockOnly('counts with the threshold the admin sets, for that admin only', async () => {
    const pending = await pendingRefund();
    const refund = await refundIdOf(pending.user);
    const someone = await newAdmin();
    const other = await newAdmin();
    expect((await setThreshold(someone, kind, 5)).statusCode).toBe(200);

    runClock(4 * DAY + HOUR);
    expect(await idsOf(someone, kind, { userId: pending.user.id })).toEqual([]);
    expect(await idsOf(other, kind, { userId: pending.user.id })).toEqual([refund]);

    runClock(5 * DAY + HOUR);
    expect(await idsOf(someone, kind, { userId: pending.user.id })).toEqual([refund]);
  });

  mockOnly('stops counting a refund once its money is told sent', async () => {
    const pending = await pendingRefund();
    const refund = await refundIdOf(pending.user);
    const someone = await newAdmin();
    runClock(3 * DAY + HOUR);
    expect(await idsOf(someone, kind, { userId: pending.user.id })).toEqual([refund]);

    await deliverOk(
      app,
      refundEvent('refund.updated', {
        id: pending.refundId,
        paymentId: pending.paymentId,
        status: 'succeeded',
      }),
    );

    await expectCases(someone, kind, { userId: pending.user.id }, [], [refund]);
    expect(await idsOf(someone, 'late_refunds_failed', { userId: pending.user.id })).toEqual([]);
  });

  mockOnly('hands a refund that failed over to the failed late refunds', async () => {
    const pending = await pendingRefund();
    const refund = await refundIdOf(pending.user);
    const someone = await newAdmin();
    runClock(3 * DAY + HOUR);
    expect(await idsOf(someone, kind, { userId: pending.user.id })).toEqual([refund]);

    await deliverOk(
      app,
      refundEvent('refund.failed', {
        id: pending.refundId,
        paymentId: pending.paymentId,
        status: 'failed',
        reason: 'expired_or_canceled_card',
      }),
    );

    expect(await idsOf(someone, kind, { userId: pending.user.id })).toEqual([]);
    await expectCases(someone, 'late_refunds_failed', { userId: pending.user.id }, [refund]);
  });

  it('never counts a refund whose money was sent at once, however old', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const refund = await refundIdOf(late.user);
    const someone = await newAdmin();

    runClock(30 * DAY);

    await expectCases(someone, kind, { userId: late.user.id }, [], [refund]);
  });
});

describe('late_refunds_failed', () => {
  const kind = 'late_refunds_failed';

  it('names the failed late refunds that wait for the shop, with no threshold', async () => {
    expect(await alertOf(await newAdmin(), kind)).toMatchObject({
      threshold: null,
      list: { path: '/api/payments/refunds', query: { purpose: 'late_payment', state: 'failed' } },
    });
  });

  it('counts a late payment whose refund failed, until root records the money as sent another way', async () => {
    const failed = await failedLateRefund(deps());
    const refund = await refundIdOf(failed.user);
    const someone = await newAdmin();

    await expectCases(someone, kind, { userId: failed.user.id }, [refund]);
    await expectListed(root, kind, { userId: failed.user.id }, [refund]);
    const [row] = (await alerts.listOf(someone, kind, { userId: failed.user.id })).items;
    expect(row).toMatchObject({ id: refund, purpose: 'late_payment', state: 'failed' });

    const marked = await markOutside(refund, String(row!.at));
    expect(marked.statusCode).toBe(200);

    await expectListed(someone, kind, { userId: failed.user.id }, [], [refund]);
  });

  it('counts at once, whatever the days, and leaves the count of the admin who put it aside only', async () => {
    const failed = await failedLateRefund(deps());
    const refund = await refundIdOf(failed.user);
    const someone = await newAdmin();
    const other = await newAdmin();

    runClock(400 * DAY);
    expect(await idsOf(someone, kind, { userId: failed.user.id })).toEqual([refund]);

    expect((await dismiss(someone, kind, refund)).statusCode).toBe(200);
    expect((await alertOf(someone, kind)).dismissed).toBe(1);
    expect((await alertOf(other, kind)).dismissed).toBe(0);
  });

  it('does not count a refund whose money was sent, and counts one the bank sent back later', async () => {
    const late = await latePayment(deps());
    await deliver(app, late.event);
    const refund = await refundIdOf(late.user);
    const someone = await newAdmin();
    await expectCases(someone, kind, { userId: late.user.id }, [], [refund]);

    await deliverOk(
      app,
      refundEvent('refund.failed', {
        id: (await refundOf(late.paymentId)).id,
        paymentId: late.paymentId,
        status: 'failed',
        reason: 'expired_or_canceled_card',
      }),
    );

    await expectListed(someone, kind, { userId: late.user.id }, [refund]);
  });

  // the transfers of the statements have their alert (return_refunds_failed)
  it('does not count a transfer of a statement that failed', async () => {
    const buyer = await createUser({ name: 'Anna Koval' });
    userIds.push(buyer.id);
    const placed = await flows.shippedOrder(buyer, product, 1);
    const card = await flows.adminStatement(placed.orderId, placed.itemId, 1);
    await flows.setGoods(card, 1, 'to_stock');
    await failReturnRefund(admin.id, card.id, 'card_unavailable');

    const someone = await newAdmin();
    expect(await idsOf(someone, kind, { userId: buyer.id })).toEqual([]);
    expect(await idsOf(someone, 'return_refunds_failed', { userId: buyer.id })).toHaveLength(1);
  });

  // the refund was asked while the bank opened a dispute of the payment: Stripe refused it for the
  // dispute, the end of the dispute decides what becomes of the money (the app sends it again when
  // the shop wins). The shop answers the dispute, the alert of the disputes counts it
  mockOnly('leaves a refund the bank refused for a dispute to the disputes to answer', async () => {
    const late = await latePayment(deps());
    await withStripeOutOfReach(() => deliver(app, late.event));
    const disputeId = await disputed(late.paymentId);
    await settleRefundsInTransit(
      { info: () => undefined, warn: () => undefined, error: () => undefined },
      { paymentId: late.paymentId, olderThanMs: 0 },
    );
    const refund = await refundIdOf(late.user);
    const someone = await newAdmin();

    await expectCases(someone, kind, { userId: late.user.id }, [], [refund]);
    const answer = await alerts.listOf(someone, 'disputes_to_answer', { orderId: late.orderId });
    expect(answer.items).toEqual([expect.objectContaining({ stripeId: disputeId, late: true })]);
  });

  // what the bank decides may give the buyer the money: root does not send it another way meanwhile
  mockOnly('leaves a failed refund out while a dispute of the payment is open', async () => {
    const failed = await failedLateRefund(deps());
    const refund = await refundIdOf(failed.user);
    const someone = await newAdmin();
    const inquiry = await disputed(failed.paymentId, 'warning_needs_response');

    await expectCases(someone, kind, { userId: failed.user.id }, [], [refund]);

    await ended(inquiry, 'warning_closed');

    await expectListed(someone, kind, { userId: failed.user.id }, [refund]);
  });

  // lost: the bank gave the buyer the money of the payment; won: the money came back to the shop and
  // the app sent the payment back again. Either way the buyer has it: the failure waits for no one
  mockOnly(
    'does not count a failed refund again once the dispute of the payment gave the money back',
    async () => {
      const someone = await newAdmin();

      for (const end of ['lost', 'won'] as const) {
        const failed = await lateRefundFailedAtStripe(deps());
        const refund = await refundIdOf(failed.user);
        await ended(await disputed(failed.paymentId), end);

        await expectListed(someone, kind, { userId: failed.user.id }, [], [refund]);
      }
    },
  );
});
