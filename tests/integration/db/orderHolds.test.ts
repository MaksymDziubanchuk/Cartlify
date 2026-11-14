import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { paidOrderOf, type DeliveryRule } from '../../helpers/dbOrders.js';
import {
  DECIDE,
  DECIDE_USE,
  SYSTEM,
  answerOf,
  call,
  handRefundOf,
  holdsOf,
  linesWhere,
  newDisputeId,
  orderOf,
  reasonsOf,
  settledOf,
  shopCancelOf,
  stepOf,
  synced,
  withdrawal,
} from '../../helpers/dbMoney.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// What holds an order back from its sending, in the database: the
// review of a payment and the early warning of fraud the provider sends (the system holds the order
// and lets it go), the decision of root on what root holds (a refund made by hand, a warning), and
// the step to shipped of an order something holds. All in transactions that roll back.
//
// The contract the tests hold the functions to:
//
// A hold is an element of orders.holds: { reason, since, ref }. since is the time of the database
// as iso 8601 text in utc with its zone (2026-11-11T10:00:00.000Z); ref names what put it: the id of
// the review or of the warning at the provider (text), the id of the line of a refund by hand, the
// id of the row of a dispute (numbers). The same reason and ref is never twice in the list. Only an
// order whose status is paid is held (orders_holds_chk): every function below leaves an order of
// another status without a hold.
//
// cartlify.hold_payment_review(p_payment_id text, p_review_id text) RETURNS jsonb
//   The system only (ORDER_HOLD_FORBIDDEN); ORDER_HOLD_INVALID for a blank payment or review id.
//   The order of the payment (orders.paymentId), while it is paid, takes the hold payment_review
//   with ref = p_review_id, once for the review. The answer: { found, orderId, userId, status, added,
//   firstCheck }; found false (and nothing else) for a payment of no order; added: the hold was put
//   by this call; firstCheck: this call put the first hold of the order of the reasons fraud_warning
//   or payment_review (the order held neither before it): the buyer is mailed that the payment is
//   checked once, not for every warning or review.
// cartlify.release_payment_review(p_payment_id text, p_review_id text) RETURNS jsonb
//   The system only (ORDER_HOLD_FORBIDDEN); ORDER_HOLD_INVALID as above. Takes away the hold of that
//   review. The answer: { found, orderId, removed, held }; held: something still holds the order.
// cartlify.hold_fraud_warning(p_payment_id text, p_warning_id text) RETURNS jsonb
//   The system only (ORDER_HOLD_FORBIDDEN); ORDER_HOLD_INVALID as above. A paid order takes the hold
//   fraud_warning with ref = p_warning_id, once for the warning. A shipped or delivered order is not
//   held (a hold would keep it from being delivered): fraudWarnedAt is set to the time of the
//   database, once (a later warning keeps the first time). Any other status: nothing. The answer:
//   { found, orderId, userId, status, added, warned, firstCheck }; warned: this call set
//   fraudWarnedAt.
// cartlify.decide_order_hold(p_order_id integer, p_reason text, p_decision text, p_note text)
//     RETURNS jsonb
//   Root with an account only (ORDER_HOLD_FORBIDDEN, the system too). Refusals in this order:
//   ORDER_HOLD_DECISION_INVALID for a reason that is not root's (root decides hand_refund and
//   fraud_warning; a dispute and a review are let go by the system) or a decision that is not ship
//   or cancel; ORDER_HOLD_NOTE_REQUIRED for a note that is blank or longer than 500 (the note goes
//   with the decision into the journal of the admins); ORDER_HOLD_NOT_FOUND for an order that is not
//   there or that the reason does not hold. Every hold of the reason goes, the other reasons stay.
//   hand_refund: the refunds by hand of the order that wait for root (event money.refund, purpose
//   hand, no moneyUse, no line of failure) become compensation on ship (no shares), and on cancel are
//   shared among the items and the delivery by their sums (share_money_line_in), so the transfer of
//   the statement of the cancel takes them first; a refund decided before or one that failed is left
//   as it is. fraud_warning: the hold goes, nothing else (the statement and the transfer of a cancel
//   are the app's). The answer: { orderId, reason, decision, moneyLogIds, held, note }; moneyLogIds:
//   the lines decided by this call, ascending; held: something still holds the order; note: trimmed.
// cartlify.add_order_hold / cartlify.remove_order_hold: internal, the app may not run them
//   (grants.test.ts). The hold of a refund by hand is put by record_hand_refund (handRefunds.test.ts),
//   the hold of a dispute by sync_payment_dispute (disputes.test.ts).
//
// The guard of orders refuses paid -> shipped while the list is not empty (ORDER_ON_HOLD; with a list
// the owner writes, orders.test.ts); here once with a hold a function put. shipped -> delivered never
// meets a hold: a sent order holds none (orders_holds_chk) and each function that holds an order
// leaves a sent one alone (tested with each of them).

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ price: 10, stock: 300 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const refused = (code: string) => ({ ok: false, message: expect.stringContaining(code) });

const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });

// two units at 10 and a delivery of 5: an order of 25
const DELIVERY: DeliveryRule = { flat: 5, freeFrom: null, expected: 5 };

async function paidOrder(db: DbSession) {
  const orderId = await paidOrderOf(db, buyer.id, admin.id, [[product.variantId, 2]], DELIVERY);
  return { orderId, paymentId: `pi_db_${orderId}` };
}

const REVIEW = `select cartlify.hold_payment_review($1, $2) as result`;
const RELEASE = `select cartlify.release_payment_review($1, $2) as result`;
const WARNING = `select cartlify.hold_fraud_warning($1, $2) as result`;

const NOTE = 'The buyer called: the payment is theirs';

// whether each hold of the order is of the time of the database and says its zone is utc
async function sinceOf(db: DbSession, orderId: number) {
  await db.as({ role: 'ADMIN', userId: admin.id });
  return db.rows<{ fresh: boolean; utc: boolean }>(
    `select abs(extract(epoch from (now() - (h.value ->> 'since')::timestamptz))) < 60 as fresh,
            (h.value ->> 'since') ~ '(Z|[+-]00(:?00)?)$' as utc
     from cartlify.orders as o cross join lateral jsonb_array_elements(o.holds) as h
     where o.id = $1`,
    orderId,
  );
}

// an order the admin moved on to the status given
async function sentOrder(db: DbSession, status: 'shipped' | 'delivered') {
  const order = await paidOrder(db);
  const shipped = await stepOf(db, admin.id, order.orderId, 'shipped');
  if (!shipped.ok) throw new Error(`the order was not shipped: ${shipped.message}`);
  if (status === 'delivered') {
    const delivered = await stepOf(db, admin.id, order.orderId, 'delivered');
    if (!delivered.ok) throw new Error(`the order was not delivered: ${delivered.message}`);
  }
  return order;
}

describe('a review of the payment by the provider', () => {
  it('holds a paid order from the time of the database, and lets it go when the review is over', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const held = await answerOf(db, SYSTEM, REVIEW, order.paymentId, 'prv_one');
      const holds = await holdsOf(db, admin.id, order.orderId);
      const since = await sinceOf(db, order.orderId);
      const released = await answerOf(db, SYSTEM, RELEASE, order.paymentId, 'prv_one');
      return {
        order,
        held,
        holds,
        since,
        released,
        after: await holdsOf(db, admin.id, order.orderId),
      };
    });

    expect(result.held).toMatchObject({
      found: true,
      orderId: result.order.orderId,
      userId: buyer.id,
      status: 'paid',
      added: true,
      firstCheck: true,
    });
    expect(reasonsOf(result.holds)).toEqual([['payment_review', 'prv_one']]);
    expect(result.since).toEqual([{ fresh: true, utc: true }]);
    expect(result.released).toMatchObject({
      found: true,
      orderId: result.order.orderId,
      removed: true,
      held: false,
    });
    expect(result.after).toEqual([]);
  });

  it('holds once for a review however often its event comes, and lets go once', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      await answerOf(db, SYSTEM, REVIEW, order.paymentId, 'prv_two');
      const again = await answerOf(db, SYSTEM, REVIEW, order.paymentId, 'prv_two');
      const holds = await holdsOf(db, admin.id, order.orderId);
      await answerOf(db, SYSTEM, RELEASE, order.paymentId, 'prv_two');
      const releasedAgain = await answerOf(db, SYSTEM, RELEASE, order.paymentId, 'prv_two');
      return { again, holds, releasedAgain };
    });

    expect(result.again).toMatchObject({ found: true, added: false, firstCheck: false });
    expect(reasonsOf(result.holds)).toEqual([['payment_review', 'prv_two']]);
    expect(result.releasedAgain).toMatchObject({ found: true, removed: false, held: false });
  });

  it('holds no order that is already sent, and finds no order for a payment of none', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await sentOrder(db, 'shipped');
      return {
        sent: await answerOf(db, SYSTEM, REVIEW, order.paymentId, 'prv_three'),
        holds: await holdsOf(db, admin.id, order.orderId),
        none: await answerOf(db, SYSTEM, REVIEW, `pi_none_${randomUUID()}`, 'prv_four'),
      };
    });

    expect(result.sent).toMatchObject({
      found: true,
      status: 'shipped',
      added: false,
      firstCheck: false,
    });
    expect(result.holds).toEqual([]);
    expect(result.none).toMatchObject({ found: false });
  });
});

describe('an early warning of fraud', () => {
  it('holds a paid order with the warning, and marks nothing', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      return {
        order,
        held: await answerOf(db, SYSTEM, WARNING, order.paymentId, 'issfr_one'),
        holds: await holdsOf(db, admin.id, order.orderId),
        row: await orderOf(db, admin.id, order.orderId),
      };
    });

    expect(result.held).toMatchObject({
      found: true,
      orderId: result.order.orderId,
      userId: buyer.id,
      status: 'paid',
      added: true,
      warned: false,
      firstCheck: true,
    });
    expect(reasonsOf(result.holds)).toEqual([['fraud_warning', 'issfr_one']]);
    expect(result.row.fraudWarnedAt).toBeNull();
  });

  // the buyer is told once that the payment is checked: not again for a review after a warning, nor
  // for a second warning
  it('is the first check of the order only while neither a warning nor a review holds it', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const warning = await answerOf(db, SYSTEM, WARNING, order.paymentId, 'issfr_two');
      const review = await answerOf(db, SYSTEM, REVIEW, order.paymentId, 'prv_five');
      const second = await answerOf(db, SYSTEM, WARNING, order.paymentId, 'issfr_three');
      return { warning, review, second, holds: await holdsOf(db, admin.id, order.orderId) };
    });

    expect(
      [result.warning, result.review, result.second].map((a) => [a.added, a.firstCheck]),
    ).toEqual([
      [true, true],
      [true, false],
      [true, false],
    ]);
    expect(reasonsOf(result.holds)).toEqual([
      ['fraud_warning', 'issfr_two'],
      ['payment_review', 'prv_five'],
      ['fraud_warning', 'issfr_three'],
    ]);
  });

  it.each([['shipped' as const], ['delivered' as const]])(
    'marks an order already %s instead of holding it, once',
    async (status) => {
      const result = await inRolledBackTx(async (db) => {
        const order = await sentOrder(db, status);
        const first = await answerOf(db, SYSTEM, WARNING, order.paymentId, 'issfr_four');
        const second = await answerOf(db, SYSTEM, WARNING, order.paymentId, 'issfr_five');
        return {
          first,
          second,
          row: await orderOf(db, admin.id, order.orderId),
          holds: await holdsOf(db, admin.id, order.orderId),
        };
      });

      expect(result.first).toMatchObject({
        found: true,
        status,
        added: false,
        warned: true,
        firstCheck: false,
      });
      expect(result.second).toMatchObject({ added: false, warned: false });
      expect(result.row.fraudWarnedAt).not.toBeNull();
      expect(
        Math.abs(
          Date.parse(result.row.fraudWarnedAt!.replace(' ', 'T')) -
            Date.parse(result.row.now.replace(' ', 'T')),
        ),
      ).toBeLessThan(60_000);
      expect(result.holds).toEqual([]);
    },
  );

  it('does nothing to an order that is cancelled', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      await shopCancelOf(db, admin.id, order.orderId);
      return {
        answer: await answerOf(db, SYSTEM, WARNING, order.paymentId, 'issfr_six'),
        row: await orderOf(db, admin.id, order.orderId),
        holds: await holdsOf(db, admin.id, order.orderId),
      };
    });

    expect(result.answer).toMatchObject({
      found: true,
      status: 'cancelled',
      added: false,
      warned: false,
    });
    expect(result.row.fraudWarnedAt).toBeNull();
    expect(result.holds).toEqual([]);
  });
});

describe('an order that a function holds', () => {
  it('is not shipped while the provider reviews its payment, and is shipped once the review is over', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      await answerOf(db, SYSTEM, REVIEW, order.paymentId, 'prv_six');
      const held = await stepOf(db, admin.id, order.orderId, 'shipped');
      await answerOf(db, SYSTEM, RELEASE, order.paymentId, 'prv_six');
      const free = await stepOf(db, admin.id, order.orderId, 'shipped');
      return { held, free, row: await orderOf(db, admin.id, order.orderId) };
    });

    expect(result.held).toMatchObject(refused('ORDER_ON_HOLD'));
    expect(result.free.ok).toBe(true);
    expect(result.row.status).toBe('shipped');
  });

  // no money went, so root has nothing to decide on: the hold of that refund goes by itself
  it('is let go by a refund made by hand that fails, and stays held by the one that did not', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const waiting = await handRefundOf(db, order.paymentId, 3);
      const failing = await handRefundOf(db, order.paymentId, 4, 'pending');
      const both = await holdsOf(db, admin.id, order.orderId);
      await settledOf(db, null, failing.refundId, 'failed');
      return { waiting, failing, both, after: await holdsOf(db, admin.id, order.orderId) };
    });

    expect(reasonsOf(result.both)).toEqual([
      ['hand_refund', result.waiting.id],
      ['hand_refund', result.failing.id],
    ]);
    expect(reasonsOf(result.after)).toEqual([['hand_refund', result.waiting.id]]);
  });

  // what came while the order was on its way holds nothing (a sent order is not held back); the admin
  // takes the send back, and the order is held again as it would have been had it waited: an open
  // dispute of the payment, a refund made by hand root has not decided on
  it('is held again when the send is taken back while a dispute is open or a refund made by hand waits', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await sentOrder(db, 'shipped');
      const disputeId = newDisputeId();
      const dispute = await synced(db, {
        stripeId: disputeId,
        paymentId: order.paymentId,
        status: 'needs_response',
        transactions: [withdrawal(25)],
      });
      const hand = await handRefundOf(db, order.paymentId, 5);
      const whileSent = await holdsOf(db, admin.id, order.orderId);
      const back = await stepOf(db, admin.id, order.orderId, 'paid');
      const again = await stepOf(db, admin.id, order.orderId, 'shipped');
      return {
        whileSent,
        back,
        again,
        disputeRowId: dispute.id,
        handId: hand.id,
        holds: reasonsOf(await holdsOf(db, admin.id, order.orderId)),
      };
    });

    expect(result.whileSent).toEqual([]);
    expect(result.back.ok).toBe(true);
    expect(result.again).toMatchObject(refused('ORDER_ON_HOLD'));
    expect(result.holds).toEqual([
      ['dispute', result.disputeRowId],
      ['hand_refund', result.handId],
    ]);
  });

  // a warning of fraud that came while the order was on its way left only its mark; the send taken
  // back, root decides on it as on a warning of an order that waits
  it('is held again for a warning of fraud that came while it was sent', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await sentOrder(db, 'shipped');
      await answerOf(db, SYSTEM, WARNING, order.paymentId, `issfr_${randomUUID()}`);
      const whileSent = await holdsOf(db, admin.id, order.orderId);
      const back = await stepOf(db, admin.id, order.orderId, 'paid');
      const again = await stepOf(db, admin.id, order.orderId, 'shipped');
      return {
        whileSent,
        back,
        again,
        reasons: (await holdsOf(db, admin.id, order.orderId)).map((hold) => hold.reason),
      };
    });

    expect(result.whileSent).toEqual([]);
    expect(result.back.ok).toBe(true);
    expect(result.again).toMatchObject(refused('ORDER_ON_HOLD'));
    expect(result.reasons).toEqual(['fraud_warning']);
  });
});

describe('the decision of root', () => {
  it('lets the order be sent after refunds by hand: each one that waits for root is a compensation', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const a = await handRefundOf(db, order.paymentId, 5);
      const b = await handRefundOf(db, order.paymentId, 3, 'pending');
      const decided = await answerOf(
        db,
        asRoot(),
        DECIDE,
        order.orderId,
        'hand_refund',
        'ship',
        '  A gesture for the late parcel  ',
      );
      return {
        order,
        a,
        b,
        decided,
        lines: await linesWhere(db, admin.id, 'id = any($1::int[])', [a.id, b.id]),
        holds: await holdsOf(db, admin.id, order.orderId),
      };
    });

    expect(result.decided).toMatchObject({
      orderId: result.order.orderId,
      reason: 'hand_refund',
      decision: 'ship',
      moneyLogIds: [result.a.id, result.b.id],
      held: false,
      note: 'A gesture for the late parcel',
    });
    expect(result.lines.map((l) => [l.id, l.moneyUse, l.returnId])).toEqual([
      [result.a.id, 'compensation', null],
      [result.b.id, 'compensation', null],
    ]);
    expect(result.holds).toEqual([]);
  });

  it('cancels: each refund by hand that waits for root is shared among the items and the delivery by their sums', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const hand = await handRefundOf(db, order.paymentId, 10);
      const decided = await answerOf(
        db,
        asRoot(),
        DECIDE,
        order.orderId,
        'hand_refund',
        'cancel',
        'The buyer asked to cancel the rest',
      );
      return {
        hand,
        decided,
        lines: await linesWhere(db, admin.id, 'id = $1', hand.id),
        holds: await holdsOf(db, admin.id, order.orderId),
      };
    });

    expect(result.decided).toMatchObject({
      reason: 'hand_refund',
      decision: 'cancel',
      moneyLogIds: [result.hand.id],
      held: false,
    });
    // 10 of an order of 25: all of it goes to the goods and the delivery
    expect(result.lines.map((l) => [l.moneyUse, l.returnId])).toEqual([['goods', null]]);
    expect(result.holds).toEqual([]);
  });

  it('leaves the refunds decided before, the ones that failed and the other reasons as they are', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      const explained = await handRefundOf(db, order.paymentId, 2);
      await answerOf(db, asRoot(), DECIDE_USE, explained.id, '[]', 0, 'A gesture');
      const waiting = await handRefundOf(db, order.paymentId, 3);
      const failing = await handRefundOf(db, order.paymentId, 4, 'pending');
      await settledOf(db, null, failing.refundId, 'failed');
      await answerOf(db, SYSTEM, REVIEW, order.paymentId, 'prv_seven');
      const decided = await answerOf(
        db,
        asRoot(),
        DECIDE,
        order.orderId,
        'hand_refund',
        'cancel',
        'The buyer asked to cancel the rest',
      );
      return {
        explained,
        waiting,
        failing,
        decided,
        lines: await linesWhere(db, admin.id, 'id = any($1::int[])', [
          explained.id,
          waiting.id,
          failing.id,
        ]),
        holds: await holdsOf(db, admin.id, order.orderId),
      };
    });

    expect(result.decided).toMatchObject({ moneyLogIds: [result.waiting.id], held: true });
    expect(result.lines.map((l) => [l.id, l.moneyUse, l.returnId])).toEqual([
      [result.explained.id, 'compensation', null],
      [result.waiting.id, 'goods', null],
      [result.failing.id, null, null],
    ]);
    expect(reasonsOf(result.holds)).toEqual([['payment_review', 'prv_seven']]);
  });

  it.each([['ship'], ['cancel']])(
    'lets go of a warning of fraud on %s, and touches no money',
    async (decision) => {
      const result = await inRolledBackTx(async (db) => {
        const order = await paidOrder(db);
        await answerOf(db, SYSTEM, WARNING, order.paymentId, 'issfr_seven');
        return {
          decided: await answerOf(
            db,
            asRoot(),
            DECIDE,
            order.orderId,
            'fraud_warning',
            decision,
            NOTE,
          ),
          holds: await holdsOf(db, admin.id, order.orderId),
          lines: await linesWhere(db, admin.id, '"paymentId" = $1', order.paymentId),
        };
      });

      expect(result.decided).toMatchObject({
        reason: 'fraud_warning',
        decision,
        moneyLogIds: [],
        held: false,
        note: NOTE,
      });
      expect(result.holds).toEqual([]);
      // the two parts of the payment, nothing more
      expect(result.lines.map((l) => l.event)).toEqual(['money.payment', 'money.payment']);
    },
  );

  it('is refused a reason root does not decide or a decision that is none (ORDER_HOLD_DECISION_INVALID)', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      await answerOf(db, SYSTEM, REVIEW, order.paymentId, 'prv_eight');
      await answerOf(db, SYSTEM, WARNING, order.paymentId, 'issfr_eight');
      const decide = (reason: string | null, decision: string | null) =>
        call(db, asRoot(), DECIDE, order.orderId, reason, decision, NOTE);
      return {
        outcomes: [
          await decide('payment_review', 'ship'),
          await decide('dispute', 'cancel'),
          await decide('because', 'ship'),
          await decide(null, 'ship'),
          await decide('fraud_warning', 'keep'),
          await decide('fraud_warning', null),
        ],
        holds: await holdsOf(db, admin.id, order.orderId),
      };
    });

    for (const outcome of result.outcomes) {
      expect(outcome).toMatchObject(refused('ORDER_HOLD_DECISION_INVALID'));
    }
    expect(result.holds).toHaveLength(2);
  });

  it('is refused without a note, or with one over 500 (ORDER_HOLD_NOTE_REQUIRED)', async () => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      await answerOf(db, SYSTEM, WARNING, order.paymentId, 'issfr_nine');
      const decide = (note: string | null) =>
        call(db, asRoot(), DECIDE, order.orderId, 'fraud_warning', 'ship', note);
      return {
        refusals: [await decide('   '), await decide(null), await decide('x'.repeat(501))],
        holds: await holdsOf(db, admin.id, order.orderId),
        longest: await decide('x'.repeat(500)),
      };
    });

    for (const outcome of result.refusals) {
      expect(outcome).toMatchObject(refused('ORDER_HOLD_NOTE_REQUIRED'));
    }
    expect(result.holds).toHaveLength(1);
    expect(result.longest.ok).toBe(true);
  });

  it('is refused for an order the reason does not hold, or one that is not there (ORDER_HOLD_NOT_FOUND)', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const reviewed = await paidOrder(db);
      await answerOf(db, SYSTEM, REVIEW, reviewed.paymentId, 'prv_nine');
      const free = await paidOrder(db);
      return [
        await call(db, asRoot(), DECIDE, reviewed.orderId, 'fraud_warning', 'ship', NOTE),
        await call(db, asRoot(), DECIDE, free.orderId, 'hand_refund', 'ship', NOTE),
        await call(db, asRoot(), DECIDE, 999_999_999, 'hand_refund', 'cancel', NOTE),
      ];
    });

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject(refused('ORDER_HOLD_NOT_FOUND'));
    }
  });

  it.each([
    ['an admin', (): Actor => ({ role: 'ADMIN', userId: admin.id })],
    ['the system', (): Actor => SYSTEM],
    ['a buyer', (): Actor => ({ role: 'USER', userId: buyer.id })],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])('is for root only: %s is refused (ORDER_HOLD_FORBIDDEN)', async (_who, actorOf) => {
    const result = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      await answerOf(db, SYSTEM, WARNING, order.paymentId, 'issfr_ten');
      return {
        outcome: await call(db, actorOf(), DECIDE, order.orderId, 'fraud_warning', 'ship', NOTE),
        holds: await holdsOf(db, admin.id, order.orderId),
      };
    });

    expect(result.outcome).toMatchObject(refused('ORDER_HOLD_FORBIDDEN'));
    expect(result.holds).toHaveLength(1);
  });
});

describe('who follows the provider', () => {
  it.each([
    ['an admin', (): Actor => ({ role: 'ADMIN', userId: admin.id })],
    ['root', asRoot],
    ['a buyer', (): Actor => ({ role: 'USER', userId: buyer.id })],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])(
    'lets %s neither hold an order nor let it go (ORDER_HOLD_FORBIDDEN)',
    async (_who, actorOf) => {
      const result = await inRolledBackTx(async (db) => {
        const order = await paidOrder(db);
        await answerOf(db, SYSTEM, REVIEW, order.paymentId, 'prv_ten');
        return {
          outcomes: [
            await call(db, actorOf(), REVIEW, order.paymentId, 'prv_eleven'),
            await call(db, actorOf(), RELEASE, order.paymentId, 'prv_ten'),
            await call(db, actorOf(), WARNING, order.paymentId, 'issfr_eleven'),
          ],
          holds: await holdsOf(db, admin.id, order.orderId),
        };
      });

      for (const outcome of result.outcomes) {
        expect(outcome).toMatchObject(refused('ORDER_HOLD_FORBIDDEN'));
      }
      expect(reasonsOf(result.holds)).toEqual([['payment_review', 'prv_ten']]);
    },
  );

  it('refuses a blank payment, review or warning (ORDER_HOLD_INVALID)', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const order = await paidOrder(db);
      return [
        await call(db, SYSTEM, REVIEW, '  ', 'prv_twelve'),
        await call(db, SYSTEM, REVIEW, order.paymentId, ''),
        await call(db, SYSTEM, RELEASE, order.paymentId, null),
        await call(db, SYSTEM, WARNING, null, 'issfr_twelve'),
        await call(db, SYSTEM, WARNING, order.paymentId, ' '),
      ];
    });

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject(refused('ORDER_HOLD_INVALID'));
    }
  });
});
