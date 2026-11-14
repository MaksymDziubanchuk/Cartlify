import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { alertsOf } from '../../../helpers/alerts.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { giveMoneyRight } from '../../../helpers/moneyManager.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { moveClock, placePaidOrder } from '../../../helpers/payments.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import {
  closeOpenSessions,
  deliver,
  PENDING_REFUND_CARD,
  realStripe,
  refundAtStripe,
  settleRefund,
  stripeEvent,
} from '../../../helpers/stripe.js';

// The alerts of the refunds made by hand in the dashboard of Stripe (GET /api/admin/alerts): hand_refunds_in_transit and
// hand_refunds_failed for admin and root, and two of root alone, for the work root does:
// hand_refunds_to_explain (an order sent, delivered or cancelled, or a statement of the order waits
// for its money: root says what the refund was for, POST /api/payments/money-lines/:id/decision) and
// hand_refunds_to_decide (part of an order not sent came back by hand: the order is held until root
// decides to send it or to cancel it). Each root follows them for themselves, a
// case goes for all of them once one acts. A refund made by hand that waits for root holds the money
// of the statements of the order: they are in no alert of the statements meanwhile. The case of the
// refunds is the refund (its first line in the money journal), the case of the decision an order.
//
// The alerts of the shop are shared by every file that runs at the same time, so a test looks at
// its own cases: the list narrowed to the buyer of the test, and the cases the actor can put aside,
// which the server lets only for a case the alert counts now.

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
let clock: { restore: () => void } | null = null;

const DAY = 86_400_000;
const HOUR = 3_600_000;

const mockOnly = realStripe ? it.skip : it;

const flows = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });
const alerts = alertsOf({ app: () => app, csrf: () => csrf });
const {
  alertOf,
  idsOf,
  dismiss,
  subscriptionOf,
  expectCounted,
  expectNotCounted,
  expectListed,
  expectCases,
} = alerts;

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
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

const post = (url: string, payload: Record<string, unknown>, actor: TestUser = root) =>
  app.inject({ method: 'POST', url, headers: withCsrf(csrf, accessCookie(actor)), payload });

// an order of two units at 10, a total of 20, paid by a card, not sent yet or sent
async function paidOrder(opts: { stage?: 'paid' | 'shipped'; card?: string } = {}) {
  const buyer = await newUser({ name: 'Anna Koval' });
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 2, ...opts });
  return { ...placed, buyer };
}

// money given back in the dashboard of Stripe, and the event of it delivered; the line of the
// refund in the money journal, the id of its case
async function refundByHand(paymentId: string, cents: number) {
  const refund = await refundAtStripe(paymentId, { amount: cents });
  const res = await deliver(app, await stripeEvent('refund.created', refund.id));
  expect(res.statusCode).toBe(200);
  const line = await asAdmin((tx) =>
    tx.moneyLog.findFirstOrThrow({
      where: { refundId: refund.id, event: 'money.refund' },
      select: { id: true },
    }),
  );
  return { refund, lineId: line.id };
}

// an admin made a statement for both units of the sent order and took the goods in: its rows wait
// for their money (20)
async function waitingStatement(orderId: number) {
  const item = await asAdmin((tx) =>
    tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } }),
  );
  const card = await flows.adminStatement(orderId, item.id, 2);
  await flows.setGoods(card, 2, 'to_stock');
  return card.id;
}

const ROOT_KINDS = ['hand_refunds_to_explain', 'hand_refunds_to_decide'];

// the item of an order of one product
const itemOf = async (orderId: number) =>
  (
    await asAdmin((tx) =>
      tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } }),
    )
  ).id;

// root says what a refund made by hand was for: a compensation, or the units it gave back
const decide = (lineId: number, items: Record<string, unknown>[] = [], note = 'Goodwill') =>
  post(`/api/payments/money-lines/${lineId}/decision`, { items, note });

describe('the kinds of the refunds made by hand', () => {
  // the refunds made by hand in transit and failed are root's and a money admin's to follow, first among the kinds of the money
  it('give root the refunds in transit and failed and the work of root, an admin without the right none of them', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const adminKinds = (await alerts.alerts(someone)).map((alert) => alert.kind);
    const rootKinds = (await alerts.alerts(root)).map((alert) => alert.kind);

    const at = rootKinds.indexOf('hand_refunds_in_transit');
    expect(at).toBe(rootKinds.indexOf('newsletter_sending_halted') + 1);
    expect(rootKinds[at + 1]).toBe('hand_refunds_failed');
    for (const kind of ['hand_refunds_in_transit', 'hand_refunds_failed']) {
      expect(adminKinds).not.toContain(kind);
    }
    for (const kind of ROOT_KINDS) {
      expect(adminKinds).not.toContain(kind);
      const res = await dismiss(someone, kind, 1);
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'ALERT_KIND_NOT_FOUND' });
      expect(await subscriptionOf(root, kind)).toEqual({ kind, subscribed: true, threshold: null });
    }
    expect(rootKinds.slice(rootKinds.indexOf('hand_refunds_to_explain'), -1)).toEqual([
      ...ROOT_KINDS,
      'fraud_warnings',
      'fraud_warnings_shipped',
      'payment_reviews',
    ]);
    expect(await subscriptionOf(root, 'hand_refunds_in_transit')).toMatchObject({
      threshold: { value: 3, default: 3, min: 1, max: 365, unit: 'days' },
    });
  });

  // root allows an admin to handle the money: the admin gets the decisions on the money as root does,
  // each for themselves, and never the actions of the admins
  it('give an admin root allowed to handle the money the decisions on the money too, not the actions of the admins', async () => {
    const manager = await newUser({ role: 'ADMIN' });
    await giveMoneyRight(root.id, manager.id);
    const kinds = (await alerts.alerts(manager)).map((alert) => alert.kind);

    const money = [...ROOT_KINDS, 'fraud_warnings', 'fraud_warnings_shipped', 'payment_reviews'];
    expect(kinds.slice(kinds.indexOf('hand_refunds_to_explain'))).toEqual(money);
    expect(kinds).not.toContain('admin_actions');
    for (const kind of money) {
      expect(await subscriptionOf(manager, kind)).toMatchObject({ kind, subscribed: true });
    }
  });

  it('name the lists of the refunds and of the orders held', async () => {
    expect(await alertOf(root, 'hand_refunds_to_explain')).toMatchObject({
      threshold: null,
      list: {
        path: '/api/payments/refunds',
        query: { purpose: 'hand', state: 'unassigned', need: 'explain' },
      },
    });
    expect(await alertOf(root, 'hand_refunds_to_decide')).toMatchObject({
      threshold: null,
      list: { path: '/api/orders', query: { statuses: 'paid', holds: 'hand_refund' } },
    });
    expect(await alertOf(root, 'hand_refunds_failed')).toMatchObject({
      list: { path: '/api/payments/refunds', query: { purpose: 'hand', state: 'failed' } },
    });
  });
});

describe('hand_refunds_to_explain', () => {
  const kind = 'hand_refunds_to_explain';

  it('counts a refund of an order sent with nothing waiting, until root says what it was for, for every root', async () => {
    const otherRoot = await newUser({ role: 'ROOT' });
    const order = await paidOrder({ stage: 'shipped' });
    const { lineId } = await refundByHand(order.paymentId, 500);
    const narrow = { userId: order.buyer.id };

    await expectCases(root, kind, narrow, [lineId]);
    await expectListed(otherRoot, kind, narrow, [lineId]);

    const res = await decide(lineId);
    expect(res.statusCode).toBe(200);

    await expectListed(root, kind, narrow, [], [lineId]);
    await expectListed(otherRoot, kind, narrow, [], [lineId]);
  });

  it('counts a refund while a statement of the order waits, until root says what it was for', async () => {
    const order = await paidOrder({ stage: 'shipped' });
    await waitingStatement(order.orderId);
    const { lineId } = await refundByHand(order.paymentId, 1000);
    const narrow = { userId: order.buyer.id };

    await expectCases(root, kind, narrow, [lineId]);

    const res = await decide(lineId, [
      { orderItemId: await itemOf(order.orderId), quantity: 1, amount: 10 },
    ]);
    expect(res.statusCode).toBe(200);

    await expectListed(root, kind, narrow, [], [lineId]);
  });

  // the transfers of the statement wait for root (RETURN_HAND_REFUND_PENDING): its money is not late
  // for the shop meanwhile, and the list of the statements names it held
  it('holds the money of the statement out of the late money until root decides', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const order = await paidOrder({ stage: 'shipped' });
    const returnId = await waitingStatement(order.orderId);
    const { lineId } = await refundByHand(order.paymentId, 1000);
    const narrow = { userId: order.buyer.id };
    runClock(10 * DAY + HOUR);

    await expectCases(someone, 'returns_money_late', narrow, [], [returnId]);
    const held = await alerts.listOf(someone, 'returns_money_late', {
      ...narrow,
      moneyHeld: 'true',
    });
    expect(held.items.map((row) => row.id)).toEqual([returnId]);

    // root calls it a compensation: the statement goes on as always, its money is late
    const res = await decide(lineId, [], 'A gesture');
    expect(res.statusCode).toBe(200);

    await expectListed(someone, 'returns_money_late', narrow, [returnId]);
    await expectCases(root, kind, narrow, [], [lineId]);
  });
});

describe('hand_refunds_to_decide', () => {
  const kind = 'hand_refunds_to_decide';

  it('counts an order not sent part of which came back by hand, until root decides, and it is not to ship meanwhile', async () => {
    const someone = await newUser({ role: 'ADMIN' });
    const order = await paidOrder();
    await refundByHand(order.paymentId, 500);
    const narrow = { userId: order.buyer.id };

    await expectCases(root, kind, narrow, [order.orderId]);
    // root decides on the order: the refund is not for root to explain apart
    expect(await idsOf(root, 'hand_refunds_to_explain', narrow)).toEqual([]);
    // the order waits for root, not for the shop to send it (the paid orders of the whole shop change
    // all the time: the list of the buyer and the case are looked at, the count is alerts.test.ts)
    expect(await idsOf(someone, 'paid_orders_waiting', narrow)).toEqual([]);
    await expectNotCounted(someone, 'paid_orders_waiting', order.orderId);

    const res = await post(`/api/orders/${order.orderId}/holds/hand_refund/decision`, {
      decision: 'ship',
      note: 'The buyer was paid back for a scratch',
    });
    expect(res.statusCode).toBe(200);

    expect(await idsOf(root, kind, narrow)).toEqual([]);
    await expectNotCounted(root, kind, order.orderId);
    expect(await idsOf(someone, 'paid_orders_waiting', narrow)).toEqual([order.orderId]);
    await expectCounted(someone, 'paid_orders_waiting', order.orderId);
    expect(await idsOf(root, 'hand_refunds_to_explain', narrow)).toEqual([]);
  });
});

describe('hand_refunds_in_transit', () => {
  const kind = 'hand_refunds_in_transit';

  mockOnly(
    'counts a refund made by hand the provider has not told sent, made more than the days ago',
    async () => {
      const someone = await newUser({ role: 'ADMIN' });
      await giveMoneyRight(root.id, someone.id);
      const order = await paidOrder({ stage: 'shipped', card: PENDING_REFUND_CARD });
      const { refund, lineId } = await refundByHand(order.paymentId, 500);
      const narrow = { userId: order.buyer.id };

      runClock(3 * DAY - HOUR);
      await expectCases(someone, kind, narrow, [], [lineId]);

      runClock(3 * DAY + HOUR);
      await expectListed(someone, kind, narrow, [lineId]);
      await expectListed(root, kind, narrow, [lineId]);

      settleRefund(refund.id, { status: 'succeeded' });
      const res = await deliver(app, await stripeEvent('refund.updated', refund.id));
      expect(res.statusCode).toBe(200);

      await expectListed(someone, kind, narrow, [], [lineId]);
    },
  );
});

describe('hand_refunds_failed', () => {
  const kind = 'hand_refunds_failed';

  mockOnly(
    'counts a refund made by hand that failed, until root sends the money another way',
    async () => {
      const someone = await newUser({ role: 'ADMIN' });
      await giveMoneyRight(root.id, someone.id);
      const order = await paidOrder({ stage: 'shipped' });
      const { refund, lineId } = await refundByHand(order.paymentId, 500);
      expect((await decide(lineId)).statusCode).toBe(200);
      const narrow = { userId: order.buyer.id };
      await expectCases(someone, kind, narrow, [], [lineId]);

      settleRefund(refund.id, { status: 'failed', reason: 'expired_or_canceled_card' });
      const told = await deliver(app, await stripeEvent('refund.failed', refund.id));
      expect(told.statusCode).toBe(200);

      await expectListed(someone, kind, narrow, [lineId]);
      await expectListed(root, kind, narrow, [lineId]);
      const [row] = (await alerts.listOf(root, kind, narrow)).items;

      const sent = await post(`/api/payments/refunds/${lineId}/outside`, {
        method: 'bank_transfer',
        note: 'Sent by hand.',
        at: String(row!.at),
      });
      expect(sent.statusCode).toBe(200);

      await expectListed(someone, kind, narrow, [], [lineId]);
    },
  );
});
