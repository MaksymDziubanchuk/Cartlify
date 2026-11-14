import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';
import {
  paymentsOfPeriodSql,
  paymentsOfStepsSql,
  type PaymentsColumns,
} from '@routes/api/admin/services/helpers/accountingSql.helper.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import {
  DECIDE,
  SYSTEM,
  answerOf,
  begun,
  handRefundOf,
  newDisputeId,
  reinstatement,
  settledOf,
  shopCancelOf,
  statementOf,
  synced,
  withdrawal,
} from '../../helpers/dbMoney.js';
import { paidOrderOf } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the money of the reports of the accounting that moved past the sales and the returns of the
// statements, read from the money journal by the time of its lines: what the bank took for the
// disputes and gave back, the refunds made by hand in the dashboard of the provider (by what root or
// the system decided they were), what the transfers of statements took of both as money the buyer
// had back, and the payments the orders could not take with what of them went back (every movement
// of such a payment, whoever made it). The reports run these queries as they are; here they run in
// one snapshot (repeatable read) before and after a step of the test, so the other files that move
// money at the same time do not matter: the difference is the step alone

const REPEATABLE_READ = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead };
const FROM = new Date('2000-01-01T00:00:00.000Z');
const TO = new Date('2100-01-01T00:00:00.000Z');

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ stock: 50, price: 25 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

type Numbers = Record<keyof PaymentsColumns, number>;

const numbersOf = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));

// the money of the period as one snapshot sees it, read by the admin
async function paymentsOf(db: DbSession, from = FROM, to = TO): Promise<Numbers> {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const sql = paymentsOfPeriodSql(from, to);
  const [row] = await db.rows<Record<string, unknown>>(sql.text, ...sql.values);
  return numbersOf(row!) as Numbers;
}

const diff = (after: Numbers, before: Numbers): Numbers =>
  Object.fromEntries(
    (Object.keys(after) as (keyof Numbers)[]).map((key) => [
      key,
      Math.round((after[key] - before[key]) * 100) / 100,
    ]),
  ) as Numbers;

const NOTHING: Numbers = {
  dispute_withdrawn: 0,
  dispute_reinstated: 0,
  dispute_used: 0,
  dispute_undecided: 0,
  hand_compensations: 0,
  hand_coverage: 0,
  hand_undecided: 0,
  hand_used: 0,
  late_received: 0,
  late_refunded: 0,
  compensations_given: 0,
  received_buyers: 0,
  received_carriers: 0,
  dispute_goods: 0,
  dispute_delivery_used: 0,
  hand_delivery: 0,
  hand_delivery_used: 0,
  shares_moved_goods: 0,
  received_share_delivery: 0,
};

// an order of two units at 25 paid through pay_order, not sent: its payment is pi_db_<id>
const paidOrder = (db: DbSession) => paidOrderOf(db, buyer.id, admin.id, [[product.variantId, 2]]);

const LATE = `select cartlify.record_late_payment(
  'stripe'::cartlify."PaymentProvider", $1, $2::int, $3::int, $4::numeric, 'eur', $5) as result`;
const BEGIN_LATE = `select cartlify.begin_payment_refund($1, $2, $3::numeric, 'eur') as result`;

describe('the disputes of a period', () => {
  it('counts what the bank took and what it gave back', async () => {
    const { opened, won } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      const stripeId = newDisputeId();
      const taken = withdrawal(50);
      const before = await paymentsOf(db);
      await synced(db, {
        stripeId,
        paymentId: `pi_db_${orderId}`,
        status: 'needs_response',
        transactions: [taken],
      });
      const opened = diff(await paymentsOf(db), before);
      await synced(db, {
        stripeId,
        paymentId: `pi_db_${orderId}`,
        status: 'won',
        transactions: [taken, reinstatement(50)],
      });
      return { opened, won: diff(await paymentsOf(db), before) };
    }, REPEATABLE_READ);

    // the fee of the dispute is no money of the order
    expect(opened).toEqual({ ...NOTHING, dispute_withdrawn: 50 });
    expect(won).toEqual({ ...NOTHING, dispute_withdrawn: 50, dispute_reinstated: 50 });
  });

  // the money of a lost dispute of an order the shop cancelled goes at once to the statement that
  // waits for it, as money the buyer has back, so the return counts it and the dispute leaves nothing
  it('takes off what a statement took of a lost dispute', async () => {
    const lost = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      const returnId = await shopCancelOf(db, admin.id, orderId);
      const before = await paymentsOf(db);
      await synced(db, {
        stripeId: newDisputeId(),
        paymentId: `pi_db_${orderId}`,
        status: 'lost',
        transactions: [withdrawal(50)],
      });
      expect(await statementOf(db, admin.id, returnId)).toEqual({
        refundedTotal: '50.00',
        closed: true,
      });
      return diff(await paymentsOf(db), before);
    }, REPEATABLE_READ);

    // the system gave all of it to the goods: the report by product counts it as their return
    expect(lost).toEqual({
      ...NOTHING,
      dispute_withdrawn: 50,
      dispute_used: 50,
      dispute_goods: 50,
    });
  });
});

describe('the refunds made by hand of a period', () => {
  it('counts a refund root has not decided on apart, and as a compensation once root lets the order go', async () => {
    const { undecided, decided } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      const before = await paymentsOf(db);
      await handRefundOf(db, `pi_db_${orderId}`, 20);
      const undecided = diff(await paymentsOf(db), before);
      await answerOf(
        db,
        { role: 'ROOT', userId: root.id },
        DECIDE,
        orderId,
        'hand_refund',
        'ship',
        'A gesture for the late parcel.',
      );
      return { undecided, decided: diff(await paymentsOf(db), before) };
    }, REPEATABLE_READ);

    expect(undecided).toEqual({ ...NOTHING, hand_undecided: 20 });
    expect(decided).toEqual({ ...NOTHING, hand_compensations: 20 });
  });

  it('counts a refund root gave to the goods as coverage, and takes off what a transfer used of it', async () => {
    const { attached, used } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      const hand = await handRefundOf(db, `pi_db_${orderId}`, 20);
      const returnId = await shopCancelOf(db, admin.id, orderId);
      const before = await paymentsOf(db);
      // root shares it among the goods and the delivery of the order by their sums
      await answerOf(
        db,
        { role: 'ROOT', userId: root.id },
        'select cartlify.share_money_line($1::int) as result',
        hand.id,
      );
      const attached = diff(await paymentsOf(db), before);
      const transfer = await begun(db, admin.id, returnId);
      // the provider is asked for the rest only
      expect(transfer).toMatchObject({ amount: '30.00', covered: '20.00' });
      return { attached, used: diff(await paymentsOf(db), before) };
    }, REPEATABLE_READ);

    // the refund was there before: the decision moves it from undecided to coverage
    expect(attached).toEqual({ ...NOTHING, hand_undecided: -20, hand_coverage: 20 });
    expect(used).toEqual({ ...NOTHING, hand_undecided: -20, hand_coverage: 20, hand_used: 20 });
  });

  it('gives the money of a refund by hand back with its failure', async () => {
    const after = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      const before = await paymentsOf(db);
      const hand = await handRefundOf(db, `pi_db_${orderId}`, 20, 'pending');
      await settledOf(db, null, hand.refundId, 'failed');
      return diff(await paymentsOf(db), before);
    }, REPEATABLE_READ);

    expect(after).toEqual(NOTHING);
  });
});

describe('the late payments of a period', () => {
  it('counts what came in and what went back, by hand too, and none of it as a refund by hand', async () => {
    const { received, ours, byHand } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      const before = await paymentsOf(db);

      // a second payment of the paid order: the order cannot take it
      const late = `pi_late_${orderId}`;
      await answerOf(
        db,
        SYSTEM,
        LATE,
        late,
        orderId,
        buyer.id,
        '50.00',
        'ALREADY_PAID_OTHER_PAYMENT',
      );
      const received = diff(await paymentsOf(db), before);
      const key = `refund:${late}`;
      await answerOf(db, SYSTEM, BEGIN_LATE, late, key, '30.00');
      await settledOf(db, key, `re_${late}`, 'succeeded');
      const ours = diff(await paymentsOf(db), before);
      // the rest went back by hand in the dashboard of the provider
      await handRefundOf(db, late, 20);
      return { received, ours, byHand: diff(await paymentsOf(db), before) };
    }, REPEATABLE_READ);

    expect(received).toEqual({ ...NOTHING, late_received: 50 });
    expect(ours).toEqual({ ...NOTHING, late_received: 50, late_refunded: 30 });
    expect(byHand).toEqual({ ...NOTHING, late_received: 50, late_refunded: 50 });
  });

  it('counts the money a dispute of a late payment took as gone back', async () => {
    const after = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      const before = await paymentsOf(db);
      const late = `pi_late_${orderId}`;
      await answerOf(
        db,
        SYSTEM,
        LATE,
        late,
        orderId,
        buyer.id,
        '50.00',
        'ALREADY_PAID_OTHER_PAYMENT',
      );
      await synced(db, {
        stripeId: newDisputeId(),
        paymentId: late,
        status: 'lost',
        transactions: [withdrawal(50)],
      });
      return diff(await paymentsOf(db), before);
    }, REPEATABLE_READ);

    expect(after).toEqual({ ...NOTHING, late_received: 50, late_refunded: 50 });
  });
});

describe('the money of the payments by the periods', () => {
  it('counts nothing in a period that does not hold the lines', async () => {
    const after = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      const future = new Date('2099-01-01T00:00:00.000Z');
      const before = await paymentsOf(db, future, TO);
      await handRefundOf(db, `pi_db_${orderId}`, 20);
      return diff(await paymentsOf(db, future, TO), before);
    }, REPEATABLE_READ);

    expect(after).toEqual(NOTHING);
  });

  it('gives a row for each step of a timeline with the same money as the period', async () => {
    const { before, after, whole } = await inRolledBackTx(async (db) => {
      const stepsOf = async () => {
        await db.as({ role: 'ADMIN', userId: admin.id });
        const sql = paymentsOfStepsSql([
          { from: FROM, to: TO },
          { from: new Date('2099-01-01T00:00:00.000Z'), to: TO },
        ]);
        const rows = await db.rows<Record<string, unknown>>(sql.text, ...sql.values);
        return rows.map((row) => numbersOf(row) as Numbers & { n: number });
      };
      const orderId = await paidOrder(db);
      const before = await stepsOf();
      await handRefundOf(db, `pi_db_${orderId}`, 20);
      return { before, after: await stepsOf(), whole: await paymentsOf(db) };
    }, REPEATABLE_READ);

    expect(after.map((row) => row.n)).toEqual([1, 2]);
    const { n: _first, ...first } = after[0]!;
    const { n: _start, ...start } = before[0]!;
    expect(diff(first as Numbers, start as Numbers)).toEqual({ ...NOTHING, hand_undecided: 20 });
    expect(first).toEqual(whole);
    const { n: _second, ...second } = after[1]!;
    const { n: _again, ...again } = before[1]!;
    expect(diff(second as Numbers, again as Numbers)).toEqual(NOTHING);
  });
});

describe('what the bank took for a dispute lost on an order sent', () => {
  // 30 of the 50: what a bank took of all of a payment with nothing before it is shared by itself
  // (db/moneyWhole.test.ts)
  it('is counted apart until root says what it was for, in the period of its line', async () => {
    const { lost, decided } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await db.rows(
        `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
        orderId,
      );
      const before = await paymentsOf(db);
      const stripeId = newDisputeId();
      const snapshot = {
        stripeId,
        paymentId: `pi_db_${orderId}`,
        status: 'needs_response' as const,
        transactions: [withdrawal(30)],
      };
      await synced(db, snapshot);
      const answer = await synced(db, { ...snapshot, status: 'lost' });
      const lost = diff(await paymentsOf(db), before);
      const [line] = await db.rows<{ id: number }>(
        `select id from cartlify.money_log where "disputeId" = $1 and event = 'money.dispute_withdrawn'`,
        answer.id,
      );
      await answerOf(
        db,
        { role: 'ROOT', userId: root.id },
        `select cartlify.decide_money_use($1::int, '[]'::jsonb, 0, 'Lost.') as result`,
        line!.id,
      );
      return { lost, decided: diff(await paymentsOf(db), before) };
    }, REPEATABLE_READ);

    expect(lost).toEqual({ ...NOTHING, dispute_withdrawn: 30, dispute_undecided: 30 });
    expect(decided).toEqual({ ...NOTHING, dispute_withdrawn: 30 });
  });
});

describe('the compensations and the money that came back', () => {
  it('counts a compensation less its failure, with the money sent another way after it', async () => {
    const { given, failed, outside } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      const before = await paymentsOf(db);
      const asRoot = { role: 'ROOT' as const, userId: root.id };
      const begun = await answerOf(
        db,
        asRoot,
        `select cartlify.begin_compensation($1::int, 'compensation:report', 10, 'eur') as result`,
        orderId,
      );
      const given = diff(await paymentsOf(db), before);
      await settledOf(db, 'compensation:report', 're_comp_report', 'failed');
      const failed = diff(await paymentsOf(db), before);
      await answerOf(
        db,
        asRoot,
        `select cartlify.mark_payment_refund_outside($1::int, 'cash'::cartlify."OutsideMethod", 'Paid at the shop.', (now() at time zone 'UTC')::timestamp(3)) as result`,
        begun.id,
      );
      return { given, failed, outside: diff(await paymentsOf(db), before) };
    }, REPEATABLE_READ);

    expect(given).toEqual({ ...NOTHING, compensations_given: 10 });
    expect(failed).toEqual(NOTHING);
    expect(outside).toEqual({ ...NOTHING, compensations_given: 10 });
  });

  it('counts the money a carrier paid for a send', async () => {
    const paid = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await db.rows(
        `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
        orderId,
      );
      const [send] = await db.rows<{ id: number }>(
        `insert into cartlify.order_shipments ("orderId", carrier) values ($1::int, 'DHL') returning id`,
        orderId,
      );
      const before = await paymentsOf(db);
      await answerOf(
        db,
        { role: 'ROOT', userId: root.id },
        `select cartlify.record_carrier_money($1::int, 12, 'bank_transfer'::cartlify."OutsideMethod", 'The parcel was lost.', (now() at time zone 'UTC')::timestamp(3)) as result`,
        send!.id,
      );
      return diff(await paymentsOf(db), before);
    }, REPEATABLE_READ);

    expect(paid).toEqual({ ...NOTHING, received_carriers: 12 });
  });
});

// the shop did not accept the two units of an order sent, then 25 went back by hand and root gave it
// to one of them: 25 overpaid
async function overpaidOrder(db: DbSession) {
  const orderId = await paidOrder(db);
  await db.as({ role: 'ADMIN', userId: admin.id });
  await db.rows(
    `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
    orderId,
  );
  const [made] = await db.rows<{ id: number }>(
    `select cartlify.create_return(
       $1::int,
       (select jsonb_agg(jsonb_build_object('orderItemId', i.id, 'quantity', i.quantity))
        from cartlify.order_items as i where i."orderId" = $1::int),
       'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
       'defect'::cartlify."ReturnReason", null, 'Test Buyer', 'buyer@example.com', null, null, 4,
       'Europe/Madrid'
     ) as id`,
    orderId,
  );
  const [row] = await db.rows<{ id: number; orderItemId: number }>(
    'select id, "orderItemId" from cartlify.return_items where "returnId" = $1',
    made!.id,
  );
  await db.rows(
    `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
    made!.id,
    JSON.stringify([
      { itemId: row!.id, quantity: 2, goods: 'not_accepted', notAcceptedReason: 'used' },
    ]),
  );
  const hand = await handRefundOf(db, `pi_db_${orderId}`, 25);
  await answerOf(
    db,
    { role: 'ROOT', userId: root.id },
    `select cartlify.decide_money_use($1::int, $2::jsonb, 0, 'For a unit.') as result`,
    hand.id,
    JSON.stringify([{ orderItemId: row!.orderItemId, quantity: 1, amount: 25 }]),
  );
  return orderId;
}

describe('what was overpaid', () => {
  it('counts what the buyer gave back of it among the money of buyers, not as a refund made by hand', async () => {
    const back = await inRolledBackTx(async (db) => {
      const orderId = await overpaidOrder(db);
      const before = await paymentsOf(db);
      await answerOf(
        db,
        { role: 'ROOT', userId: root.id },
        `select cartlify.record_overpaid_received($1::int, 10, 'bank_transfer'::cartlify."OutsideMethod", 'Paid back.', (now() at time zone 'UTC')::timestamp(3)) as result`,
        orderId,
      );
      return diff(await paymentsOf(db), before);
    }, REPEATABLE_READ);

    expect(back).toEqual({ ...NOTHING, received_buyers: 10 });
  });

  it('counts what root gave up of an overpaid share of the goods', async () => {
    const moved = await inRolledBackTx(async (db) => {
      const orderId = await overpaidOrder(db);
      const before = await paymentsOf(db);
      await answerOf(
        db,
        { role: 'ROOT', userId: root.id },
        'select cartlify.lose_overpaid($1::int) as result',
        orderId,
      );
      return diff(await paymentsOf(db), before);
    }, REPEATABLE_READ);

    expect(moved).toEqual({ ...NOTHING, shares_moved_goods: 25 });
  });
});
