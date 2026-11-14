import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { paidOrderOf, type DeliveryRule, type Items } from '../../helpers/dbOrders.js';
import {
  CLOSED_AT,
  DUE_BY,
  OPENED_AT,
  SYSTEM,
  answerOf,
  begun,
  call,
  disputesOf,
  holdsOf,
  itemIdsOf,
  linesWhere,
  newDisputeId,
  reasonsOf,
  reinstatement,
  rowsOf,
  shopCancelOf,
  settledOf,
  statementOf,
  stepOf,
  syncOf,
  synced,
  withdrawal,
  type DisputeStatus,
  type Snapshot,
} from '../../helpers/dbMoney.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// The disputes of a payment at the bank in the database: the
// function the webhook and the worker call with what the provider says of a dispute, the money a
// dispute moves, the hold it puts on an order that waits to be sent, what a lost dispute does to the
// statements of the order, and the mark of the draft of the evidence. All in transactions that roll
// back, as the system (the admin context without a user id) unless a test says otherwise.
//
// The contract the tests hold the functions to:
//
// cartlify.sync_payment_dispute(p_provider "PaymentProvider", p_stripe_id text, p_payment_id text,
//     p_status "DisputeStatus", p_reason text, p_due_by timestamp, p_has_evidence boolean,
//     p_submission_count integer, p_is_refundable boolean, p_opened_at timestamp,
//     p_closed_at timestamp, p_transactions jsonb) RETURNS jsonb
//   The system only: MONEY_FORBIDDEN for anyone else. DISPUTE_INVALID for a blank stripe id or
//   payment id, no status, no opened_at, or transactions that are not a list of objects, each with a
//   non-blank id and an amount that is a json number (null is an empty list). The times are utc
//   without a zone, as the columns hold them.
//   The payment is found as the payment of an order (orders.paymentId) or as a late payment (its line
//   money.late_payment: the order and the buyer are the ones of that line, the order may be none).
//   Found neither way, the answer is { foreign: true } and nothing is written.
//   The row of payment_disputes (one for p_stripe_id) is made by the first sync and takes the state
//   of the snapshot: reason, status, evidenceDueBy, hasEvidence, submissionCount,
//   isChargeRefundable, openedAt, the order and the buyer. closedAt: null while the status is open;
//   for a status that ends a dispute (warning_closed, won, lost, prevented) the time the provider
//   gives, or the time of the database when it gives none; set once.
//   A snapshot read before the one kept does not move the state back. The steps in order are
//   warning_needs_response, warning_under_review, needs_response, under_review, then the ends. A
//   snapshot is stale when its step is earlier than the one kept, or the same step with fewer
//   submissions, or when the dispute kept has ended and the snapshot names another status (an end is
//   final). A stale snapshot changes nothing of the row nor of the hold.
//   Every balance transaction is a line of the money journal, once for its id (stripeTxId), from any
//   snapshot, stale or not: below 0 money.dispute_withdrawn, above 0 money.dispute_reinstated (0
//   writes nothing). The purpose dispute, the part whole, the amount of the transaction (the fee of
//   the provider is not money of the order), its currency, the dispute, the order and the buyer, the
//   provider and the payment; no actor.
//   The hold of the order (orders.holds): { reason: 'dispute', since, ref: <the id of the row of
//   payment_disputes> }, one for each open dispute of the payment of an order whose status is paid,
//   made sure of at each sync that is not stale, and taken away when that dispute ends. A dispute of
//   a late payment, or of an order that is not paid, holds nothing.
//   A lost dispute of the payment of an order ties its lines that name no statement (returnId) to the
//   earliest statement of the order (the smallest id) that is open and has a row whose money is
//   not_refunded or failed. With no such statement the lines stay as they are, and any later sync of
//   the dispute ties them once one is there. A dispute of a late payment ties nothing.
//   The answer: { foreign: false, id, created, stale, status, open, drafted, late, orderId, userId,
//   orderStatus, held, lineIds, withdrawn, returnId }. created: the row was made by this call; stale:
//   the snapshot was older than the state kept; status and open: the state kept after the call;
//   drafted: draftedAt is set; late: the payment is a late payment; orderStatus: null without an
//   order; held: the order is held by this dispute after the call; lineIds: the lines written by this
//   call, ascending; withdrawn: what the dispute has taken in all less what it gave back, text with
//   two decimals ('0.00' when nothing); returnId: the statement its lines are tied to, or null.
//
// cartlify.mark_dispute_drafted(p_dispute_id integer) RETURNS jsonb
//   The system only (MONEY_FORBIDDEN); DISPUTE_NOT_FOUND for no such dispute. Sets draftedAt to the
//   time of the database, once: { id, changed }, changed false when it was set already.
//
// What an open dispute stops (RETURN_REFUND_DISPUTED of begin_return_refund and
// mark_return_refunded_outside) is returnMoney.test.ts; the rights and the guard of the table are
// paymentDisputes.test.ts.

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let first: TestProduct;
let second: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  first = await createProduct({ price: 10, stock: 400 });
  second = await createProduct({ price: 10, stock: 100 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const refused = (code: string) => ({ ok: false, message: expect.stringContaining(code) });

// the units at 10 and a delivery of 5: an order of 25
const DELIVERY: DeliveryRule = { flat: 5, freeFrom: null, expected: 5 };

type Paid = { orderId: number; paymentId: string; itemIds: number[] };

// a paid order of 25: two units of the first product, or a unit of each product (two rows)
async function paidOrder(db: DbSession, apart = false): Promise<Paid> {
  const items: Items = apart
    ? [
        [first.variantId, 1],
        [second.variantId, 1],
      ]
    : [[first.variantId, 2]];
  const orderId = await paidOrderOf(db, buyer.id, admin.id, items, DELIVERY);
  return {
    orderId,
    paymentId: `pi_db_${orderId}`,
    itemIds: await itemIdsOf(db, admin.id, orderId),
  };
}

// a new dispute of the payment in the status given
const disputeOf = (
  paymentId: string,
  status: DisputeStatus,
  more: Partial<Snapshot> = {},
): Snapshot => ({ stripeId: newDisputeId(), paymentId, status, ...more });

// the payment an order could not take, as the payment webhook records it
const LATE = `select cartlify.record_late_payment(
  'stripe'::cartlify."PaymentProvider", $1, $2::int, $3::int, $4::numeric, 'eur', $5) as result`;

const DRAFTED = `select cartlify.mark_dispute_drafted($1::int) as result`;

// two times of the database, utc without a zone, within a minute of each other
const withinAMinute = (a: string | null, b: string) =>
  a !== null &&
  Math.abs(Date.parse(a.replace(' ', 'T')) - Date.parse(b.replace(' ', 'T'))) < 60_000;

describe('a dispute of a payment the shop does not know', () => {
  it('is a foreign payment: no dispute and no line is written', async () => {
    const result = await inRolledBackTx(async (db) => {
      const paymentId = `pi_foreign_${randomUUID()}`;
      const answer = await synced(
        db,
        disputeOf(paymentId, 'needs_response', { transactions: [withdrawal(25)] }),
      );
      return {
        answer,
        disputes: await disputesOf(db, admin.id, paymentId),
        lines: await linesWhere(db, admin.id, '"paymentId" = $1', paymentId),
      };
    });

    expect(result.answer).toMatchObject({ foreign: true });
    expect(result.disputes).toEqual([]);
    expect(result.lines).toEqual([]);
  });
});

describe('the state of a dispute', () => {
  it('is written as the provider gives it, for the order of the payment and its buyer', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const snapshot = disputeOf(order.paymentId, 'needs_response', {
        reason: 'product_not_received',
      });
      return {
        order,
        snapshot,
        answer: await synced(db, snapshot),
        disputes: await disputesOf(db, admin.id, order.paymentId),
      };
    });

    expect(result.answer).toMatchObject({
      foreign: false,
      created: true,
      stale: false,
      status: 'needs_response',
      open: true,
      drafted: false,
      late: false,
      orderId: result.order.orderId,
      userId: buyer.id,
      orderStatus: 'paid',
      lineIds: [],
      withdrawn: '0.00',
      shared: false,
    });
    expect(result.disputes).toEqual([
      expect.objectContaining({
        id: result.answer.id,
        provider: 'stripe',
        stripeId: result.snapshot.stripeId,
        paymentId: result.order.paymentId,
        orderId: result.order.orderId,
        userId: buyer.id,
        reason: 'product_not_received',
        status: 'needs_response',
        evidenceDueBy: DUE_BY,
        hasEvidence: false,
        submissionCount: 0,
        isChargeRefundable: false,
        openedAt: OPENED_AT,
        closedAt: null,
        draftedAt: null,
      }),
    ]);
  });

  it('follows a later state: the evidence, the count, the date due, whether it can still be refunded', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const snapshot = disputeOf(order.paymentId, 'needs_response');
      await synced(db, snapshot);
      const answer = await synced(db, {
        ...snapshot,
        status: 'under_review',
        hasEvidence: true,
        submissions: 1,
        refundable: true,
        dueBy: '2026-11-28 23:59:59',
        reason: 'unrecognized',
      });
      return { answer, disputes: await disputesOf(db, admin.id, order.paymentId) };
    });

    expect(result.answer).toMatchObject({ created: false, stale: false, status: 'under_review' });
    expect(result.disputes).toEqual([
      expect.objectContaining({
        status: 'under_review',
        hasEvidence: true,
        submissionCount: 1,
        isChargeRefundable: true,
        evidenceDueBy: '2026-11-28 23:59:59',
        reason: 'unrecognized',
        openedAt: OPENED_AT,
      }),
    ]);
  });

  it('follows an inquiry of the bank that becomes a dispute, step by step', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const taken = withdrawal(25);
      const snapshot = disputeOf(order.paymentId, 'warning_needs_response');
      const answers = [
        await synced(db, snapshot),
        await synced(db, { ...snapshot, status: 'warning_under_review' }),
        await synced(db, { ...snapshot, status: 'needs_response', transactions: [taken] }),
        await synced(db, {
          ...snapshot,
          status: 'under_review',
          hasEvidence: true,
          submissions: 1,
          transactions: [taken],
        }),
      ];
      return {
        answers,
        disputes: await disputesOf(db, admin.id, order.paymentId),
        holds: await holdsOf(db, admin.id, order.orderId),
      };
    });

    expect(result.answers.map((a) => [a.status, a.stale, a.open])).toEqual([
      ['warning_needs_response', false, true],
      ['warning_under_review', false, true],
      ['needs_response', false, true],
      ['under_review', false, true],
    ]);
    expect(result.disputes).toHaveLength(1);
    expect(reasonsOf(result.holds)).toEqual([['dispute', result.answers[0]!.id]]);
  });

  it('ends with the time the provider gives, or with the time of the database when it gives none', async () => {
    const result = await inRolledBackTx(async (db) => {
      const a = await paidOrder(db);
      const b = await paidOrder(db);
      await synced(db, disputeOf(a.paymentId, 'won'));
      await synced(db, disputeOf(b.paymentId, 'lost', { closedAt: null }));
      return {
        won: (await disputesOf(db, admin.id, a.paymentId))[0]!,
        lost: (await disputesOf(db, admin.id, b.paymentId))[0]!,
      };
    });

    expect(result.won.closedAt).toBe(CLOSED_AT);
    expect(withinAMinute(result.lost.closedAt, result.lost.now)).toBe(true);
  });

  const STATUSES: [DisputeStatus, boolean][] = [
    ['warning_needs_response', true],
    ['warning_under_review', true],
    ['warning_closed', false],
    ['needs_response', true],
    ['under_review', true],
    ['won', false],
    ['lost', false],
    ['prevented', false],
  ];

  it.each(STATUSES)(
    'is %s (open: %s), and holds a paid order while it is open, and once lost until it is cancelled',
    async (status, open) => {
      const result = await inRolledBackTx(async (db) => {
        const order = await paidOrder(db);
        const answer = await synced(db, disputeOf(order.paymentId, status));
        return {
          answer,
          row: (await disputesOf(db, admin.id, order.paymentId))[0]!,
          holds: await holdsOf(db, admin.id, order.orderId),
        };
      });

      // a lost one keeps the order not sent held: the system cancels it next, the cancel takes the
      // holds away
      const holding = open || status === 'lost';
      expect(result.answer).toMatchObject({ status, open, held: holding });
      expect(result.row.status).toBe(status);
      expect(result.row.closedAt === null).toBe(open);
      expect(reasonsOf(result.holds)).toEqual(holding ? [['dispute', result.answer.id]] : []);
    },
  );

  it('is the same state for the same snapshot again: one row, each line once, one hold', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const snapshot = disputeOf(order.paymentId, 'needs_response', {
        transactions: [withdrawal(25)],
      });
      const once = await synced(db, snapshot);
      const again = await synced(db, snapshot);
      return {
        once,
        again,
        disputes: await disputesOf(db, admin.id, order.paymentId),
        lines: await linesWhere(db, admin.id, '"disputeId" = $1', once.id),
        holds: await holdsOf(db, admin.id, order.orderId),
      };
    });

    expect(result.again).toMatchObject({
      id: result.once.id,
      created: false,
      stale: false,
      status: 'needs_response',
      lineIds: [],
      withdrawn: '25.00',
      held: true,
    });
    expect(result.disputes).toHaveLength(1);
    expect(result.lines).toHaveLength(1);
    expect(reasonsOf(result.holds)).toEqual([['dispute', result.once.id]]);
  });

  // the app reads the dispute from the provider at each event; two events close together may give
  // their snapshots in the other order
  it('is not moved back by an older snapshot after the end, and an end is never changed for another', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const opened = disputeOf(order.paymentId, 'needs_response');
      await synced(db, opened);
      await synced(db, { ...opened, status: 'won' });
      const older = await synced(db, opened);
      const other = await synced(db, {
        ...opened,
        status: 'lost',
        closedAt: '2026-11-12 08:00:00',
      });
      return {
        older,
        other,
        row: (await disputesOf(db, admin.id, order.paymentId))[0]!,
        holds: await holdsOf(db, admin.id, order.orderId),
      };
    });

    expect(result.older).toMatchObject({ stale: true, status: 'won', open: false, held: false });
    expect(result.other).toMatchObject({ stale: true, status: 'won' });
    expect(result.row).toMatchObject({ status: 'won', closedAt: CLOSED_AT });
    expect(result.holds).toEqual([]);
  });

  it('is not moved back to an earlier step while it is open, nor to fewer submissions', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const reviewed = disputeOf(order.paymentId, 'under_review', {
        hasEvidence: true,
        submissions: 1,
      });
      await synced(db, reviewed);
      const earlier = await synced(db, {
        ...reviewed,
        status: 'needs_response',
        hasEvidence: false,
        submissions: 0,
      });
      const fewer = await synced(db, { ...reviewed, hasEvidence: false, submissions: 0 });
      return {
        earlier,
        fewer,
        row: (await disputesOf(db, admin.id, order.paymentId))[0]!,
      };
    });

    expect(result.earlier).toMatchObject({ stale: true, status: 'under_review', open: true });
    expect(result.fewer).toMatchObject({ stale: true, status: 'under_review' });
    expect(result.row).toMatchObject({
      status: 'under_review',
      hasEvidence: true,
      submissionCount: 1,
    });
  });
});

describe('the money a dispute moves', () => {
  it('is a line for each balance transaction: what the bank took and gave back, without the fee', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const taken = withdrawal(25);
      const given = reinstatement(25);
      const snapshot = disputeOf(order.paymentId, 'needs_response', { transactions: [taken] });
      const opened = await synced(db, snapshot);
      const won = await synced(db, { ...snapshot, status: 'won', transactions: [taken, given] });
      return {
        order,
        taken,
        given,
        opened,
        won,
        lines: await linesWhere(db, admin.id, '"disputeId" = $1', opened.id),
      };
    });

    expect(result.lines.map((l) => [l.event, l.purpose, l.part, l.amount, l.stripeTxId])).toEqual([
      ['money.dispute_withdrawn', 'dispute', 'whole', '-25.00', result.taken.id],
      ['money.dispute_reinstated', 'dispute', 'whole', '25.00', result.given.id],
    ]);
    for (const line of result.lines) {
      expect(line).toMatchObject({
        currency: 'eur',
        provider: 'stripe',
        paymentId: result.order.paymentId,
        orderId: result.order.orderId,
        userId: buyer.id,
        disputeId: result.opened.id,
        returnId: null,
        actorId: null,
      });
    }
    expect(result.opened).toMatchObject({ lineIds: [result.lines[0]!.id], withdrawn: '25.00' });
    expect(result.won).toMatchObject({ lineIds: [result.lines[1]!.id], withdrawn: '0.00' });
  });
});

describe('the hold a dispute puts on an order', () => {
  // PayPal opens a dispute for each claim of the buyer: several on one payment are normal
  it('is one for each open dispute of the payment, and the order is let go when the last one ends', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const a = disputeOf(order.paymentId, 'needs_response');
      const b = disputeOf(order.paymentId, 'warning_needs_response');
      const heldA = await synced(db, a);
      const heldB = await synced(db, b);
      const both = reasonsOf(await holdsOf(db, admin.id, order.orderId));
      const endA = await synced(db, { ...a, status: 'won' });
      const one = reasonsOf(await holdsOf(db, admin.id, order.orderId));
      const endB = await synced(db, { ...b, status: 'warning_closed' });
      const none = await holdsOf(db, admin.id, order.orderId);
      return { heldA, heldB, both, endA, one, endB, none };
    });

    expect(result.both).toEqual([
      ['dispute', result.heldA.id],
      ['dispute', result.heldB.id],
    ]);
    expect(result.endA.held).toBe(false);
    expect(result.one).toEqual([['dispute', result.heldB.id]]);
    expect(result.endB.held).toBe(false);
    expect(result.none).toEqual([]);
  });

  it.each([['shipped' as const], ['delivered' as const]])(
    'is none on an order that is already %s',
    async (status) => {
      const result = await inRolledBackTx(async (db) => {
        const order = await paidOrder(db);
        const shipped = await stepOf(db, admin.id, order.orderId, 'shipped');
        if (!shipped.ok) throw new Error(`the order was not shipped: ${shipped.message}`);
        if (status === 'delivered') {
          const delivered = await stepOf(db, admin.id, order.orderId, 'delivered');
          if (!delivered.ok) throw new Error(`the order was not delivered: ${delivered.message}`);
        }
        return {
          answer: await synced(db, disputeOf(order.paymentId, 'needs_response')),
          holds: await holdsOf(db, admin.id, order.orderId),
        };
      });

      expect(result.answer).toMatchObject({ open: true, held: false, orderStatus: status });
      expect(result.holds).toEqual([]);
    },
  );
});

describe('a dispute of a late payment', () => {
  it('is found by the line of the late payment, with the order it names or with none, and holds nothing', async () => {
    const result = await inRolledBackTx(async (db) => {
      // the order took a payment of its own: the late one is a second payment
      const order = await paidOrder(db);
      const known = `pi_late_${randomUUID()}`;
      const gone = `pi_late_${randomUUID()}`;
      await answerOf(
        db,
        SYSTEM,
        LATE,
        known,
        order.orderId,
        buyer.id,
        25,
        'ALREADY_PAID_OTHER_PAYMENT',
      );
      await answerOf(db, SYSTEM, LATE, gone, 999_999_999, buyer.id, 9, 'ORDER_NOT_FOUND');
      const ofKnown = await synced(
        db,
        disputeOf(known, 'needs_response', { transactions: [withdrawal(25)] }),
      );
      const ofGone = await synced(
        db,
        disputeOf(gone, 'needs_response', { transactions: [withdrawal(9)] }),
      );
      return {
        order,
        ofKnown,
        ofGone,
        known: await disputesOf(db, admin.id, known),
        gone: await disputesOf(db, admin.id, gone),
        lines: await linesWhere(db, admin.id, '"disputeId" = any($1::int[])', [
          ofKnown.id,
          ofGone.id,
        ]),
        holds: await holdsOf(db, admin.id, order.orderId),
      };
    });

    expect(result.ofKnown).toMatchObject({
      foreign: false,
      late: true,
      orderId: result.order.orderId,
      userId: buyer.id,
      orderStatus: 'paid',
      held: false,
    });
    expect(result.ofGone).toMatchObject({
      foreign: false,
      late: true,
      orderId: null,
      userId: buyer.id,
      orderStatus: null,
      held: false,
    });
    expect(result.known).toEqual([
      expect.objectContaining({ orderId: result.order.orderId, userId: buyer.id }),
    ]);
    expect(result.gone).toEqual([expect.objectContaining({ orderId: null, userId: buyer.id })]);
    expect(result.lines.map((l) => [l.orderId, l.userId, l.amount])).toEqual([
      [result.order.orderId, buyer.id, '-25.00'],
      [null, buyer.id, '-9.00'],
    ]);
    // the order sends what it took: a dispute of another payment does not hold it
    expect(result.holds).toEqual([]);
  });

  it('shares nothing among the items of its order when it is lost', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const returnId = await shopCancelOf(db, admin.id, order.orderId);
      const late = `pi_late_${randomUUID()}`;
      await answerOf(db, SYSTEM, LATE, late, order.orderId, buyer.id, 25, 'ORDER_CANCELLED');
      const snapshot = disputeOf(late, 'needs_response', { transactions: [withdrawal(25)] });
      await synced(db, snapshot);
      const lost = await synced(db, { ...snapshot, status: 'lost' });
      return {
        lost,
        lines: await linesWhere(db, admin.id, '"disputeId" = $1', lost.id),
        statement: await statementOf(db, admin.id, returnId),
      };
    });

    expect(result.lost.shared).toBe(false);
    expect(result.lines.map((l) => [l.returnId, l.moneyUse])).toEqual([[null, null]]);
    expect(result.statement.refundedTotal).toBe('0.00');
  });
});

describe('a lost dispute of an order not sent', () => {
  it('shares what the bank took among the items and the delivery by their sums; the statements of the cancel take their own shares', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db, true);
      const snapshot = disputeOf(order.paymentId, 'needs_response', {
        transactions: [withdrawal(25)],
      });
      const opened = await synced(db, snapshot);
      const lost = await synced(db, { ...snapshot, status: 'lost' });
      const earlier = await shopCancelOf(db, admin.id, order.orderId, [order.itemIds[0]!]);
      const later = await shopCancelOf(db, admin.id, order.orderId, [order.itemIds[1]!]);
      const first = await begun(db, admin.id, earlier);
      const second = await begun(db, admin.id, later);
      return {
        opened,
        lost,
        lines: await linesWhere(db, admin.id, '"disputeId" = $1', opened.id),
        first,
        second,
        totals: [await statementOf(db, admin.id, earlier), await statementOf(db, admin.id, later)],
      };
    });

    expect(result.opened.shared).toBe(false);
    expect(result.lost.shared).toBe(true);
    // no statement waited: nothing was paid at once
    expect(result.lost.covered).toEqual([]);
    expect(result.lines.map((l) => [l.returnId, l.moneyUse])).toEqual([[null, 'goods']]);
    // 10 a unit and the delivery of 5 with the second: the bank gave all of it
    expect(result.first).toMatchObject({ amount: '0.00', covered: '10.00', settled: true });
    expect(result.second).toMatchObject({ amount: '0.00', covered: '15.00', settled: true });
    expect(result.totals.map((one) => one.refundedTotal)).toEqual(['10.00', '15.00']);
  });

  it('shares nothing when the shop won: the bank gave the money back', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const returnId = await shopCancelOf(db, admin.id, order.orderId);
      const taken = withdrawal(25);
      const snapshot = disputeOf(order.paymentId, 'needs_response', { transactions: [taken] });
      await synced(db, snapshot);
      const won = await synced(db, {
        ...snapshot,
        status: 'won',
        transactions: [taken, reinstatement(25)],
      });
      return {
        won,
        lines: await linesWhere(db, admin.id, '"disputeId" = $1', won.id),
        transfer: await begun(db, admin.id, returnId),
      };
    });

    expect(result.won.shared).toBe(false);
    expect(result.lines.map((l) => l.moneyUse)).toEqual([null, null]);
    expect(result.transfer).toMatchObject({ amount: '25.00', covered: '0.00' });
  });

  // the shop cancelled the order before the bank decided: the goods never left, the statement waits
  // for its money, and the bank gave it, so the statement has it at once with no transfer
  it('shares it for an order the shop cancelled before it was sent: the statement of the cancel takes it', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const returnId = await shopCancelOf(db, admin.id, order.orderId);
      const snapshot = disputeOf(order.paymentId, 'needs_response', {
        transactions: [withdrawal(25)],
      });
      await synced(db, snapshot);
      const lost = await synced(db, { ...snapshot, status: 'lost' });
      const again = await synced(db, { ...snapshot, status: 'lost' });
      return {
        lost,
        again,
        returnId,
        itemIds: (await rowsOf(db, admin.id, returnId)).map((row) => row.id),
        lines: await linesWhere(db, admin.id, '"disputeId" = $1', lost.id),
        covered: await linesWhere(db, admin.id, `"returnId" = $1 and part = 'covered'`, returnId),
        total: await statementOf(db, admin.id, returnId),
      };
    });

    expect(result.lost.shared).toBe(true);
    // the rows the money of the bank paid at once, for the mail of the app
    expect(result.lost.covered).toEqual([{ returnId: result.returnId, itemIds: result.itemIds }]);
    expect(result.lines.map((l) => l.moneyUse)).toEqual(['goods']);
    // the units and the delivery, each naming what the bank took
    expect(result.covered.map((line) => [line.amount, line.coversId, line.transferKey])).toEqual([
      ['20.00', result.lines[0]!.id, null],
      ['5.00', result.lines[0]!.id, null],
    ]);
    expect(result.total).toEqual({ refundedTotal: '25.00', closed: true });
    // a sync again pays nothing twice
    expect(result.again.covered).toEqual([]);
  });

  // the buyer had the money of the cancel back and the bank gave it again: what it was is root's
  it('waits for root for an order cancelled whose money went back already', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const returnId = await shopCancelOf(db, admin.id, order.orderId);
      const transfer = await begun(db, admin.id, returnId);
      await settledOf(db, transfer.key as string, `re_${randomUUID()}`, 'succeeded');
      const back = await statementOf(db, admin.id, returnId);
      const snapshot = disputeOf(order.paymentId, 'needs_response', {
        transactions: [withdrawal(25)],
      });
      await synced(db, snapshot);
      const lost = await synced(db, { ...snapshot, status: 'lost' });
      return { back, lost, lines: await linesWhere(db, admin.id, '"disputeId" = $1', lost.id) };
    });

    expect(result.back).toEqual({ refundedTotal: '25.00', closed: true });
    expect(result.lost.shared).toBe(false);
    expect(result.lines.map((l) => l.moneyUse)).toEqual([null]);
  });

  // the bank gave the buyer 15 of the 25 the order cost: the transfer of the cancel sends the rest
  it('covers the transfer of the cancel with its shares: the provider is asked for the rest only', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const taken = withdrawal(15);
      const snapshot = disputeOf(order.paymentId, 'needs_response', { transactions: [taken] });
      await synced(db, snapshot);
      await synced(db, { ...snapshot, status: 'lost' });
      const returnId = await shopCancelOf(db, admin.id, order.orderId);
      const transfer = await begun(db, admin.id, returnId);
      return {
        transfer,
        source: (await linesWhere(db, admin.id, '"stripeTxId" = $1', taken.id))[0]!,
        covered: await linesWhere(db, admin.id, `"returnId" = $1 and part = 'covered'`, returnId),
      };
    });

    expect(result.transfer).toMatchObject({ amount: '10.00', covered: '15.00', settled: false });
    expect(result.transfer.key).toEqual(expect.any(String));
    // the share of the units and the share of the delivery, each naming what the bank took
    expect(result.covered.map((line) => [line.amount, line.coversId, line.transferKey])).toEqual([
      ['12.00', result.source.id, result.transfer.key],
      ['3.00', result.source.id, result.transfer.key],
    ]);
  });
});

describe('the draft of the evidence', () => {
  it('is marked once with the time of the database, and the sync tells it', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const snapshot = disputeOf(order.paymentId, 'needs_response');
      const before = await synced(db, snapshot);
      const marked = await answerOf(db, SYSTEM, DRAFTED, before.id);
      const again = await answerOf(db, SYSTEM, DRAFTED, before.id);
      return {
        before,
        marked,
        again,
        row: (await disputesOf(db, admin.id, order.paymentId))[0]!,
        after: await synced(db, snapshot),
      };
    });

    expect(result.before.drafted).toBe(false);
    expect(result.marked).toMatchObject({ id: result.before.id, changed: true });
    expect(result.again).toMatchObject({ id: result.before.id, changed: false });
    expect(withinAMinute(result.row.draftedAt, result.row.now)).toBe(true);
    expect(result.after.drafted).toBe(true);
  });

  it('is refused for a dispute that is not there (DISPUTE_NOT_FOUND)', async () => {
    const outcome = await inRolledBackTx((db) => call(db, SYSTEM, DRAFTED, 999_999_999));

    expect(outcome).toMatchObject(refused('DISPUTE_NOT_FOUND'));
  });
});

describe('who follows the disputes', () => {
  it.each([
    ['an admin', (): Actor => ({ role: 'ADMIN', userId: admin.id })],
    ['root', (): Actor => ({ role: 'ROOT', userId: root.id })],
    ['a buyer', (): Actor => ({ role: 'USER', userId: buyer.id })],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])(
    'lets %s neither sync a dispute nor mark its draft (MONEY_FORBIDDEN)',
    async (_who, actorOf) => {
      const result = await inRolledBackTx(async (db) => {
        const order = await paidOrder(db);
        const snapshot = disputeOf(order.paymentId, 'needs_response', {
          transactions: [withdrawal(25)],
        });
        const sync = await syncOf(db, snapshot, actorOf());
        const disputes = await disputesOf(db, admin.id, order.paymentId);
        const known = await synced(db, snapshot);
        const mark = await call(db, actorOf(), DRAFTED, known.id);
        return { sync, disputes, mark, row: (await disputesOf(db, admin.id, order.paymentId))[0]! };
      });

      expect(result.sync).toMatchObject(refused('MONEY_FORBIDDEN'));
      expect(result.disputes).toEqual([]);
      expect(result.mark).toMatchObject(refused('MONEY_FORBIDDEN'));
      expect(result.row.draftedAt).toBeNull();
    },
  );

  it('refuses a snapshot that is not whole (DISPUTE_INVALID)', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const base = disputeOf(order.paymentId, 'needs_response');
      const outcomes = [
        await syncOf(db, { ...base, stripeId: '  ' }),
        await syncOf(db, { ...base, paymentId: '' }),
        await syncOf(db, { ...base, status: null }),
        await syncOf(db, { ...base, openedAt: null }),
        await syncOf(db, { ...base, rawTransactions: '{"id":"txn_one","amount":-5}' }),
        await syncOf(db, { ...base, rawTransactions: '[{"amount":-5}]' }),
        await syncOf(db, { ...base, rawTransactions: '[{"id":" ","amount":-5}]' }),
        await syncOf(db, { ...base, rawTransactions: '[{"id":"txn_much","amount":"much"}]' }),
      ];
      return { outcomes, disputes: await disputesOf(db, admin.id, order.paymentId) };
    });

    for (const outcome of result.outcomes) {
      expect(outcome).toMatchObject(refused('DISPUTE_INVALID'));
    }
    expect(result.disputes).toEqual([]);
  });
});
