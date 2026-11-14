import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

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
import { placePaidOrder } from '../../../helpers/payments.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import {
  closeOpenSessions,
  deliver,
  disputeEvent,
  endDispute,
  openDispute,
  queueRefundOutcome,
  realStripe,
  refundAtStripe,
  stripeEvent,
} from '../../../helpers/stripe.js';

// The alerts of the money of root and of an admin root allowed to handle it
// (GET /api/admin/alerts): a compensation of the app that failed (compensation_refunds_failed),
// what a bank took for a dispute lost on an order sent that waits for the decision of what it was for
// (bank_money_to_decide), a statement whose money does not fit in what is left of the payment
// (returns_money_short), and the statements of an order whose money already with the buyer gave more
// than they took (returns_money_overpaid). An admin without the right has none of them. Each test
// looks at its own cases (the alerts of the shop are shared by every file that runs at the same time)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];

const describeMock = realStripe ? describe.skip : describe;

const flows = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });
const alerts = alertsOf({ app: () => app, csrf: () => csrf });
const { alertOf, expectCases, expectListed } = alerts;

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

afterAll(async () => {
  try {
    await closeOpenSessions();
    await removeProducts(products);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const post = (url: string, payload: Record<string, unknown>, actor: TestUser = root) =>
  app.inject({ method: 'POST', url, headers: withCsrf(csrf, accessCookie(actor)), payload });

// an order of two units at 10, a total of 20, paid and sent
async function sentOrder() {
  const buyer = await newUser({ name: 'Anna Koval' });
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 2, stage: 'shipped' });
  const item = await asAdmin((tx) =>
    tx.orderItem.findFirstOrThrow({ where: { orderId: placed.orderId }, select: { id: true } }),
  );
  return { ...placed, buyer, itemId: item.id };
}

// an admin made a statement for both units and took the goods in: its rows wait for their money
async function waitingStatement(orderId: number, itemId: number) {
  const card = await flows.adminStatement(orderId, itemId, 2);
  await flows.setGoods(card, 2, 'to_stock');
  return card;
}

// money given back in the dashboard of Stripe and its event delivered: its line
async function refundByHand(paymentId: string, cents: number) {
  const refund = await refundAtStripe(paymentId, { amount: cents });
  expect((await deliver(app, await stripeEvent('refund.created', refund.id))).statusCode).toBe(200);
  return asAdmin((tx) =>
    tx.moneyLog.findFirstOrThrow({
      where: { refundId: refund.id, event: 'money.refund' },
      select: { id: true },
    }),
  );
}

const decide = (lineId: number, items: Record<string, unknown>[]) =>
  post(`/api/payments/money-lines/${lineId}/decision`, { items, note: 'For the goods.' });

describe('the kinds of the money', () => {
  it('are root s and a money admin s, each naming its list', async () => {
    const plain = await newUser({ role: 'ADMIN' });
    const manager = await newUser({ role: 'ADMIN' });
    await giveMoneyRight(root.id, manager.id);
    const kinds = (await alerts.alerts(plain)).map((alert) => alert.kind);
    const managerKinds = (await alerts.alerts(manager)).map((alert) => alert.kind);

    for (const kind of [
      'compensation_refunds_in_transit',
      'compensation_refunds_failed',
      'bank_money_to_decide',
      'returns_money_short',
      'returns_money_overpaid',
    ]) {
      expect(kinds).not.toContain(kind);
      expect(managerKinds).toContain(kind);
    }
    expect(await alertOf(root, 'compensation_refunds_failed')).toMatchObject({
      list: { path: '/api/payments/refunds', query: { purpose: 'compensation', state: 'failed' } },
    });
    expect(await alertOf(root, 'compensation_refunds_in_transit')).toMatchObject({
      threshold: 3,
    });
    expect(await alertOf(root, 'bank_money_to_decide')).toMatchObject({
      threshold: null,
      list: { path: '/api/payments/disputes', query: { status: 'lost', moneyUndecided: 'true' } },
    });
  });
});

describeMock('compensation_refunds_failed', () => {
  it('counts a compensation the card did not take until root sends it another way', async () => {
    const order = await sentOrder();
    queueRefundOutcome({ status: 'failed', reason: 'expired_or_canceled_card' });
    const given = await post('/api/payments/compensations', {
      orderId: order.orderId,
      amount: 5,
      note: 'A gesture',
    });
    const narrow = { orderId: order.orderId };

    await expectCases(root, 'compensation_refunds_failed', narrow, [given.json().id]);

    const [row] = (await alerts.listOf(root, 'compensation_refunds_failed', narrow)).items;
    const sent = await post(`/api/payments/refunds/${given.json().id}/outside`, {
      method: 'bank_transfer',
      note: 'Sent by hand.',
      at: String(row!.at),
    });
    expect(sent.statusCode).toBe(200);

    await expectListed(root, 'compensation_refunds_failed', narrow, [], [given.json().id]);
  });
});

describeMock('bank_money_to_decide', () => {
  // the bank took half of the payment: what it took of all of a payment with no other money before
  // is shared by itself (db/moneyWhole.test.ts)
  it('counts a dispute lost on an order sent until root says what the money was for', async () => {
    const order = await sentOrder();
    const disputeId = openDispute(order.paymentId, { amount: 1000 });
    expect(
      (await deliver(app, await disputeEvent('charge.dispute.created', disputeId))).statusCode,
    ).toBe(200);
    expect(
      (await deliver(app, await disputeEvent('charge.dispute.funds_withdrawn', disputeId)))
        .statusCode,
    ).toBe(200);
    endDispute(disputeId, 'lost');
    expect(
      (await deliver(app, await disputeEvent('charge.dispute.closed', disputeId))).statusCode,
    ).toBe(200);
    const narrow = { orderId: order.orderId };
    const row = await asAdmin((tx) =>
      tx.paymentDispute.findFirstOrThrow({ where: { stripeId: disputeId }, select: { id: true } }),
    );

    await expectCases(root, 'bank_money_to_decide', narrow, [row.id]);

    const line = await asAdmin((tx) =>
      tx.moneyLog.findFirstOrThrow({
        where: { disputeId: row.id, event: 'money.dispute_withdrawn' },
        select: { id: true },
      }),
    );
    expect(
      (await post(`/api/payments/money-lines/${line.id}/decision`, { items: [], note: 'Lost.' }))
        .statusCode,
    ).toBe(200);

    await expectListed(root, 'bank_money_to_decide', narrow, [], [row.id]);
  });
});

describe('returns_money_short', () => {
  // 10 went back by hand as a gesture: the payment holds 10 of the 20 the statement owes
  it('counts a statement whose money does not fit in the payment until it is sent another way', async () => {
    const order = await sentOrder();
    const card = await waitingStatement(order.orderId, order.itemId);
    const hand = await refundByHand(order.paymentId, 1000);
    expect((await decide(hand.id, [])).statusCode).toBe(200);
    const narrow = { userId: order.buyer.id };

    await expectCases(root, 'returns_money_short', narrow, [card.id]);

    const [{ now }] = await asAdmin(
      (tx) => tx.$queryRaw<{ now: Date }[]>`select (now() at time zone 'UTC') as now`,
    );
    const sent = await post(`/api/returns/${card.id}/refund/outside`, {
      method: 'bank_transfer',
      note: 'All of it by a bank transfer.',
      at: now!.toISOString(),
    });
    expect(sent.statusCode).toBe(200);

    await expectListed(root, 'returns_money_short', narrow, [], [card.id]);
  });
});

describe('returns_money_overpaid', () => {
  // the shop did not accept the goods, and then half of the payment went back by hand and root gave
  // it to a unit of them: the buyer has the money of goods no statement owes
  it('counts the statement of an order whose money already with the buyer gave more than it took, until root records what came back', async () => {
    const order = await sentOrder();
    const card = await flows.adminStatement(order.orderId, order.itemId, 2);
    await flows.setGoods(card, 2, 'not_accepted', { notAcceptedReason: 'used' });
    const hand = await refundByHand(order.paymentId, 1000);
    expect(
      (await decide(hand.id, [{ orderItemId: order.itemId, quantity: 1, amount: 10 }])).statusCode,
    ).toBe(200);
    const narrow = { userId: order.buyer.id };

    await expectCases(root, 'returns_money_overpaid', narrow, [card.id]);

    const [{ now }] = await asAdmin(
      (tx) => tx.$queryRaw<{ now: Date }[]>`select (now() at time zone 'UTC') as now`,
    );
    const back = await post(`/api/returns/${card.id}/overpaid/received`, {
      amount: 10,
      method: 'bank_transfer',
      note: 'The buyer paid it back.',
      at: now!.toISOString(),
    });
    expect(back.statusCode).toBe(200);

    await expectListed(root, 'returns_money_overpaid', narrow, [], [card.id]);
  });
});
