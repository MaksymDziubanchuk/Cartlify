import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import appStripe from '@config/stripe.js';

import { alertsOf } from '../../../helpers/alerts.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { giveMoneyRight } from '../../../helpers/moneyManager.js';
import { moveClock, placePaidOrder } from '../../../helpers/payments.js';
import { returnFlows } from '../../../helpers/returnFlows.js';
import { failReturnRefund } from '../../../helpers/returns.js';
import {
  closeOpenSessions,
  deliver,
  disputeEvent,
  endDispute,
  openDispute,
  outOfReachDuring,
  realStripe,
  stripeOfTests,
} from '../../../helpers/stripe.js';

// The alerts of the disputes of the payments at the bank (GET /api/admin/alerts), for admin and root: disputes_to_answer counts the open disputes and inquiries
// no evidence was submitted for yet (no threshold; the list puts the nearest date due first and
// marks a dispute of an order with an open statement), disputes_lost the disputes lost in the last
// days; dispute_refunds_in_transit and dispute_refunds_failed count the transfers of what the bank
// did not give back after a dispute lost on an order not sent. The money of a statement of an order
// with an open dispute waits for the bank: it is in no alert of the statements until the dispute
// ends. A case of the disputes is a dispute (its id in the list of the disputes), a case of the
// refunds its first line in the money journal. The disputes are made by the Stripe mock (the sandbox
// makes one only for a test card of its own), so the file runs with the mock only.
//
// The alerts of the shop are shared by every file that runs at the same time, so a test looks at
// its own cases: the list narrowed to the order or the buyer of the test, and the cases the admin
// can put aside, which the server lets only for a case the alert counts now. The disputes end by the
// clock of the database and the alerts count their days from the clock of the app: a margin of an
// hour on both sides of a day keeps the check clear of the small difference the two clocks may have.

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
let clock: { restore: () => void } | null = null;

const DAY = 86_400_000;
const HOUR = 3_600_000;

const describeMock = realStripe ? describe.skip : describe;

const flows = returnFlows({ app: () => app, csrf: () => csrf, admin: () => admin });
const alerts = alertsOf({ app: () => app, csrf: () => csrf });
const {
  alertOf,
  listOf,
  idsOf,
  setThreshold,
  subscriptionOf,
  expectNotCounted,
  expectListed,
  expectCases,
} = alerts;

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
});

afterEach(() => {
  clock?.restore();
  clock = null;
  jest.restoreAllMocks();
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

// an order of two units at 10, a total of 20, paid by a card, not sent yet or sent
async function paidOrder(stage: 'paid' | 'shipped' = 'paid') {
  const buyer = await createUser({ name: 'Anna Koval' });
  userIds.push(buyer.id);
  const product = await createProduct({ price: 10, stock: 10 });
  products.push(product);
  const placed = await placePaidOrder(app, csrf, buyer, product, { quantity: 2, stage });
  return { ...placed, buyer, product };
}

// an event of the dispute, around the dispute as Stripe has it now, delivered
async function tell(type: string, disputeId: string) {
  const res = await deliver(app, await disputeEvent(type, disputeId));
  expect(res.statusCode).toBe(200);
}

// the bank opens a dispute (an inquiry takes no money) and Stripe tells of it
async function disputed(paymentId: string, opening: Parameters<typeof openDispute>[1] = {}) {
  const disputeId = openDispute(paymentId, opening);
  await tell('charge.dispute.created', disputeId);
  if ((opening.status ?? 'needs_response') === 'needs_response') {
    await tell('charge.dispute.funds_withdrawn', disputeId);
  }
  return disputeId;
}

// the bank ends it and Stripe tells of it
async function ended(disputeId: string, end: Parameters<typeof endDispute>[1]) {
  endDispute(disputeId, end);
  await tell('charge.dispute.closed', disputeId);
  if (end === 'won') await tell('charge.dispute.funds_reinstated', disputeId);
}

// a person submits the evidence of the dispute in the dashboard of Stripe
async function answered(disputeId: string) {
  await stripeOfTests.disputes.update(disputeId, {
    evidence: { uncategorized_text: 'The parcel was delivered.' },
    submit: true,
  });
  await tell('charge.dispute.updated', disputeId);
}

// the dispute in the app: the id of its case
const caseOf = async (stripeId: string) =>
  (await asAdmin((tx) => tx.paymentDispute.findUniqueOrThrow({ where: { stripeId } }))).id;

// an admin made a statement for both units of the sent order and took the goods in: its rows wait
// for their money; the transfer failed when the test says so
async function waitingStatement(orderId: number, failed = false) {
  const item = await asAdmin((tx) =>
    tx.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } }),
  );
  const card = await flows.adminStatement(orderId, item.id, 2);
  await flows.setGoods(card, 2, 'to_stock');
  if (failed) await failReturnRefund(admin.id, card.id, 'card_unavailable');
  return card.id;
}

// the transfers of the statements of the buyer in the list of the refunds, by their first line
async function transfersOf(buyer: TestUser, purpose: string) {
  const res = await alerts.get(
    admin,
    '/api/payments/refunds?purpose=' + purpose + '&userId=' + buyer.id,
  );
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<{ id: number; purpose: string; state: string }>;
}

describeMock('the kinds of the disputes', () => {
  // the refusal of the rest after a dispute lost is root's and a money admin's to send another way:
  // it sits among the money kinds, with what a bank took
  // waiting for the decision
  it('sit after the refunds, for admin and root, with the days of the lost ones only', async () => {
    const someone = await newAdmin();

    for (const actor of [someone, root]) {
      const kinds = (await alerts.alerts(actor)).map((alert) => alert.kind);
      const at = kinds.indexOf('dispute_refunds_in_transit');
      expect(kinds.slice(at, at + 3)).toEqual([
        'dispute_refunds_in_transit',
        'disputes_to_answer',
        'disputes_lost',
      ]);
    }
    const rootKinds = (await alerts.alerts(root)).map((alert) => alert.kind);
    const at = rootKinds.indexOf('dispute_refunds_failed');
    expect(rootKinds.slice(at, at + 2)).toEqual(['dispute_refunds_failed', 'bank_money_to_decide']);
    expect((await alerts.alerts(someone)).map((alert) => alert.kind)).not.toContain(
      'dispute_refunds_failed',
    );
    expect(await subscriptionOf(someone, 'disputes_to_answer')).toEqual({
      kind: 'disputes_to_answer',
      subscribed: true,
      threshold: null,
    });
    expect(await subscriptionOf(someone, 'disputes_lost')).toEqual({
      kind: 'disputes_lost',
      subscribed: true,
      threshold: { value: 7, default: 7, min: 1, max: 365, unit: 'days', custom: false },
    });
    expect(await subscriptionOf(someone, 'dispute_refunds_in_transit')).toMatchObject({
      threshold: { value: 3, unit: 'days' },
    });
    expect((await subscriptionOf(root, 'dispute_refunds_failed'))!.threshold).toBeNull();
  });

  it('name the list of the disputes and the list of the refunds', async () => {
    const someone = await newAdmin();

    expect(await alertOf(someone, 'disputes_to_answer')).toMatchObject({
      threshold: null,
      list: { path: '/api/payments/disputes', query: { toAnswer: 'true' } },
    });
    const lost = await alertOf(someone, 'disputes_lost');
    expect(lost).toMatchObject({
      threshold: 7,
      list: { path: '/api/payments/disputes', query: { status: 'lost' } },
    });
    expect(Math.abs(Date.now() - Date.parse(lost.list!.query.closedFrom!) - 7 * DAY)).toBeLessThan(
      HOUR,
    );
    expect(await alertOf(root, 'dispute_refunds_failed')).toMatchObject({
      list: {
        path: '/api/payments/refunds',
        query: { purpose: 'dispute_remainder', state: 'failed' },
      },
    });
  });
});

describeMock('disputes_to_answer', () => {
  const kind = 'disputes_to_answer';

  it('counts an open dispute and an inquiry of the bank until evidence is submitted, with its date due', async () => {
    const someone = await newAdmin();
    const order = await paidOrder();
    const chargeback = await disputed(order.paymentId, { method: 'paypal', amount: 1000 });
    const inquiry = await disputed(order.paymentId, {
      method: 'paypal',
      amount: 1000,
      status: 'warning_needs_response',
    });
    const ids = [await caseOf(chargeback), await caseOf(inquiry)];

    await expectCases(someone, kind, { orderId: order.orderId }, ids);
    await expectListed(root, kind, { orderId: order.orderId }, ids);
    const page = await listOf(someone, kind, { orderId: order.orderId });
    for (const item of page.items) {
      expect(Date.parse(String(item.evidenceDueBy))).toBeGreaterThan(Date.now());
      expect(item).toMatchObject({ open: true, submissionCount: 0, returnOpen: false });
    }

    await answered(chargeback);

    await expectListed(someone, kind, { orderId: order.orderId }, [ids[1]!], [ids[0]!]);
  });

  it('stops counting a dispute once it ends', async () => {
    const someone = await newAdmin();
    const order = await paidOrder();
    const disputeId = await disputed(order.paymentId);
    const id = await caseOf(disputeId);
    await expectCases(someone, kind, { orderId: order.orderId }, [id]);

    await ended(disputeId, 'won');

    await expectListed(someone, kind, { orderId: order.orderId }, [], [id]);
  });

  // the money of the statement is due, its transfer waits for the end of the dispute: the dispute is
  // marked, so the shop answers it knowing it
  it('marks a dispute of an order with an open statement', async () => {
    const someone = await newAdmin();
    const order = await paidOrder('shipped');
    await waitingStatement(order.orderId);
    const id = await caseOf(await disputed(order.paymentId));

    await expectCases(someone, kind, { orderId: order.orderId }, [id]);
    expect((await listOf(someone, kind, { orderId: order.orderId })).items).toEqual([
      expect.objectContaining({ id, returnOpen: true }),
    ]);
  });
});

describeMock('disputes_lost', () => {
  const kind = 'disputes_lost';

  it('counts a dispute lost in the days of the threshold, not one won', async () => {
    const someone = await newAdmin();
    const other = await newAdmin();
    expect((await setThreshold(other, kind, 10)).statusCode).toBe(200);
    const order = await paidOrder('shipped');
    const lost = await disputed(order.paymentId, { method: 'paypal', amount: 1000 });
    const won = await disputed(order.paymentId, { method: 'paypal', amount: 1000 });
    await ended(lost, 'lost');
    await ended(won, 'won');
    const lostId = await caseOf(lost);
    const wonId = await caseOf(won);

    await expectCases(someone, kind, { orderId: order.orderId }, [lostId], [wonId]);

    runClock(7 * DAY - HOUR);
    await expectListed(someone, kind, { orderId: order.orderId }, [lostId], [wonId]);

    runClock(7 * DAY + HOUR);
    await expectListed(someone, kind, { orderId: order.orderId }, [], [lostId, wonId]);
    await expectListed(other, kind, { orderId: order.orderId }, [lostId], [wonId]);
  });
});

describeMock('the transfers of what the bank did not give back', () => {
  // the bank gave the buyer 15 of the 20 of an order not sent: the system cancels the order and
  // sends the 5 left
  it('counts the transfer that failed in dispute_refunds_failed, not among the statements', async () => {
    const someone = await newAdmin();
    await giveMoneyRight(root.id, someone.id);
    const order = await paidOrder();
    const disputeId = await disputed(order.paymentId, { amount: 1500 });
    await ended(disputeId, 'lost');
    const [transfer, ...others] = await transfersOf(order.buyer, 'dispute_remainder');
    expect(others).toEqual([]);
    expect(transfer).toMatchObject({ purpose: 'dispute_remainder', state: 'failed' });

    await expectCases(someone, 'dispute_refunds_failed', { userId: order.buyer.id }, [
      transfer!.id,
    ]);
    expect(await idsOf(someone, 'return_refunds_failed', { userId: order.buyer.id })).toEqual([]);
    // nothing is left to answer: the dispute is over
    expect(await idsOf(someone, 'disputes_to_answer', { orderId: order.orderId })).toEqual([]);
  });

  it('counts the transfer the provider has not answered, asked more than the days ago', async () => {
    const someone = await newAdmin();
    const order = await paidOrder();
    const disputeId = await disputed(order.paymentId, { amount: 1500 });
    outOfReachDuring(appStripe.refunds, 'create');
    await ended(disputeId, 'lost');
    jest.restoreAllMocks();
    const [transfer] = await transfersOf(order.buyer, 'dispute_remainder');
    expect(transfer).toMatchObject({ state: 'in_transit' });
    const kind = 'dispute_refunds_in_transit';

    runClock(3 * DAY - HOUR);
    await expectCases(someone, kind, { userId: order.buyer.id }, [], [transfer!.id]);

    runClock(3 * DAY + HOUR);
    await expectListed(someone, kind, { userId: order.buyer.id }, [transfer!.id]);
    expect(await idsOf(someone, 'return_refunds_in_transit', { userId: order.buyer.id })).toEqual(
      [],
    );
  });
});

describeMock('the money of a statement while a dispute of the payment is open', () => {
  it('waits for the bank: the failed transfer and the late money are in no alert until the dispute ends', async () => {
    const someone = await newAdmin();
    const order = await paidOrder('shipped');
    const returnId = await waitingStatement(order.orderId, true);
    const [transfer] = await transfersOf(order.buyer, 'return');
    const narrow = { userId: order.buyer.id };
    expect(await idsOf(someone, 'return_refunds_failed', narrow)).toEqual([transfer!.id]);

    const inquiry = await disputed(order.paymentId, { status: 'warning_needs_response' });
    runClock(10 * DAY + HOUR);

    expect(await idsOf(someone, 'return_refunds_failed', narrow)).toEqual([]);
    await expectNotCounted(someone, 'return_refunds_failed', transfer!.id);
    expect(await idsOf(someone, 'returns_money_late', narrow)).toEqual([]);
    await expectNotCounted(someone, 'returns_money_late', returnId);
    // the dispute is to answer, and it says the statement is open
    expect((await listOf(someone, 'disputes_to_answer', { orderId: order.orderId })).items).toEqual(
      [expect.objectContaining({ id: await caseOf(inquiry), returnOpen: true })],
    );
    // the list of the statements names the statement with its money held
    const held = await listOf(someone, 'returns_money_late', {
      userId: order.buyer.id,
      moneyHeld: 'true',
    });
    expect(held.items.map((row) => row.id)).toEqual([returnId]);

    await ended(inquiry, 'warning_closed');

    // the counts of these kinds as the totals of their lists are alertsReturns.test.ts
    await expectListed(someone, 'return_refunds_failed', narrow, [transfer!.id]);
    await expectListed(someone, 'returns_money_late', narrow, [returnId]);
  });
});
