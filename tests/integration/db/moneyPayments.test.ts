import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { PICKUP, paidOrderOf, pay, waitingOrderOf } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the money journal of the payment side: what a payment writes (its two parts), the payment an
// order could not take and its refund in the steps the app takes (the line before the provider is
// asked, the end by its answer or its event, the failure as new lines), a refund made by hand in
// the dashboard of the provider, and what is left of a payment. Every statement runs the way the
// app runs it: the payment, the refunds and the hand refunds as the system, the webhook and the
// worker (the admin context without a user id)

let buyer: TestUser;
let other: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  other = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ price: 10, stock: 200 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, other.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asSystem = (): Actor => ({ role: 'ADMIN' });
const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });
const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });

// two units at 10 and a delivery of 5: an order of 25
const DELIVERY_RULE = { flat: 5, freeFrom: null, expected: 5 };

type Line = {
  id: number;
  event: string;
  purpose: string;
  part: string;
  amount: string;
  state: string | null;
  refundId: string | null;
  transferKey: string | null;
  coversId: number | null;
  failure: string | null;
  byDashboard: boolean;
  orderId: number | null;
  userId: number | null;
  actorId: number | null;
};

const LINE_COLUMNS = `id, event, purpose::text as purpose, part::text as part, amount::text as amount,
  state::text as state, "refundId", "transferKey", "coversId", failure::text as failure,
  "byDashboard", "orderId", "userId", "actorId"`;

// the lines of a payment, oldest first
async function linesOf(db: DbSession, paymentId: string) {
  await db.as(asAdmin());
  return db.rows<Line>(
    `select ${LINE_COLUMNS} from cartlify.money_log where "paymentId" = $1 order by id`,
    paymentId,
  );
}

async function call<T = Record<string, unknown>>(
  db: DbSession,
  actor: Actor,
  statement: string,
  ...values: unknown[]
) {
  await db.as(actor);
  return db.attempt<T>(statement, ...values);
}

// a refund of a late payment, the way the app asks for it
const BEGIN = `select cartlify.begin_payment_refund($1, $2, $3::numeric, 'eur') as result`;
const SETTLE = `select cartlify.settle_money_refund($1, $2, $3, $4::cartlify."RefundFailure", $5) as result`;
// what is left of the money of a payment, as an admin reads it in the journal: the sum of its lines
const LEFT = `select coalesce(sum(amount), 0)::numeric(12, 2)::text as left
  from cartlify.money_log where "paymentId" = $1`;
const LATE = `select cartlify.record_late_payment(
  'stripe'::cartlify."PaymentProvider", $1, $2::int, $3::int, $4::numeric, 'eur', $5) as result`;
const HAND = `select cartlify.record_hand_refund(
  'stripe'::cartlify."PaymentProvider", $1, $2, $3::numeric, $4, 'eur') as result`;

type Answer = Record<string, unknown>;

async function answerOf(db: DbSession, actor: Actor, statement: string, ...values: unknown[]) {
  const outcome = await call<{ result: Answer }>(db, actor, statement, ...values);
  if (!outcome.ok) throw new Error(`${statement.slice(0, 40)} refused: ${outcome.message}`);
  return outcome.rows[0]!.result;
}

// a payment the order could not take, recorded for the buyer
const lateOf = async (db: DbSession, paymentId: string, amount = '25.00', orderId = 0) =>
  answerOf(db, asSystem(), LATE, paymentId, orderId, buyer.id, amount, 'AMOUNT_MISMATCH');

describe('the payment of an order', () => {
  it('is two lines of one payment, the goods and the delivery, that add up to the order', async () => {
    const lines = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(
        db,
        buyer.id,
        admin.id,
        [[product.variantId, 2]],
        DELIVERY_RULE,
      );
      return { orderId, lines: await linesOf(db, `pi_db_${orderId}`) };
    });

    expect(lines.lines.map((l) => [l.event, l.purpose, l.part, l.amount])).toEqual([
      ['money.payment', 'order', 'goods', '20.00'],
      ['money.payment', 'order', 'delivery', '5.00'],
    ]);
    expect(lines.lines.every((l) => l.orderId === lines.orderId && l.userId === buyer.id)).toBe(
      true,
    );
    // the webhook is the system: no one did it
    expect(lines.lines.every((l) => l.actorId === null)).toBe(true);
  });

  it('is one line of the goods when the delivery costs nothing', async () => {
    const lines = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, buyer.id, [[product.variantId, 2]], {}, PICKUP);
      expect(await pay(db, admin.id, orderId)).toBe('PAID');
      return linesOf(db, `pi_db_${orderId}`);
    });

    expect(lines.map((l) => [l.part, l.amount])).toEqual([['goods', '20.00']]);
  });

  it('writes nothing for a delivery of the same payment again, a second payment or a wrong sum', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(
        db,
        buyer.id,
        admin.id,
        [[product.variantId, 1]],
        DELIVERY_RULE,
      );
      const same = await pay(db, admin.id, orderId);
      const another = await pay(db, admin.id, orderId, { paymentId: 'pi_another' });
      const wrongOrder = await waitingOrderOf(
        db,
        buyer.id,
        [[product.variantId, 1]],
        DELIVERY_RULE,
      );
      const wrong = await pay(db, admin.id, wrongOrder, { amount: '1.00', paymentId: 'pi_wrong' });

      return {
        same,
        another,
        wrong,
        first: (await linesOf(db, `pi_db_${orderId}`)).length,
        second: (await linesOf(db, 'pi_another')).length,
        third: (await linesOf(db, 'pi_wrong')).length,
      };
    });

    expect(result).toEqual({
      same: 'ALREADY_PAID_SAME_PAYMENT',
      another: 'ALREADY_PAID_OTHER_PAYMENT',
      wrong: 'AMOUNT_MISMATCH',
      first: 2,
      second: 0,
      third: 0,
    });
  });
});

describe('a payment the order could not take', () => {
  it('is one line of the shop money, once for the payment', async () => {
    const result = await inRolledBackTx(async (db) => {
      const first = await lateOf(db, 'pi_late_1');
      const again = await lateOf(db, 'pi_late_1');
      return { first, again, lines: await linesOf(db, 'pi_late_1') };
    });

    expect(result.first).toMatchObject({ created: true, userId: buyer.id, orderId: null });
    expect(result.again).toMatchObject({ created: false, id: result.first.id });
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      event: 'money.late_payment',
      purpose: 'late_payment',
      part: 'whole',
      amount: '25.00',
    });
  });

  it('names the order when it is there, and keeps the reason and the number of an order that is gone', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await waitingOrderOf(db, buyer.id, [[product.variantId, 1]], DELIVERY_RULE);
      const known = await lateOf(db, 'pi_late_known', '15.00', orderId);
      const gone = await answerOf(
        db,
        asSystem(),
        LATE,
        'pi_late_gone',
        999_999_999,
        other.id,
        '9.00',
        'ORDER_NOT_FOUND',
      );
      await db.as(asAdmin());
      const meta = await db.rows<{ meta: unknown }>(
        `select meta from cartlify.money_log where "paymentId" = 'pi_late_gone'`,
      );
      return { orderId, known, gone, meta: meta[0]!.meta };
    });

    expect(result.known).toMatchObject({ orderId: result.orderId, userId: buyer.id });
    // the order is gone: the buyer comes from the page of the payment
    expect(result.gone).toMatchObject({ orderId: null, userId: other.id });
    expect(result.meta).toEqual([
      { field: 'reason', new: 'ORDER_NOT_FOUND' },
      { field: 'orderRef', new: 999_999_999 },
    ]);
  });

  it.each([
    ['an admin', asAdmin],
    ['root', asRoot],
    ['a buyer', (): Actor => ({ role: 'USER', userId: buyer.id })],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: '8f4c2f0e-2f7c-4c43-8f64-4f3f9e5b1d2a' })],
  ])('is not recorded by %s: only the system does', async (_who, actorOf) => {
    const outcome = await inRolledBackTx((db) =>
      call(db, actorOf(), LATE, 'pi_late_forbidden', 0, buyer.id, '25.00', 'AMOUNT_MISMATCH'),
    );

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('MONEY_FORBIDDEN'),
    });
  });

  it('refuses a sum of nothing or a payment without an id', async () => {
    const outcomes = await inRolledBackTx(async (db) => [
      await call(db, asSystem(), LATE, 'pi_late_zero', 0, buyer.id, '0', 'AMOUNT_MISMATCH'),
      await call(db, asSystem(), LATE, '  ', 0, buyer.id, '5.00', 'AMOUNT_MISMATCH'),
    ]);

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('MONEY_LINE_INVALID'),
      });
    }
  });
});

describe('the refund of a late payment', () => {
  it('is written in transit with our key before the provider is asked, once for the key', async () => {
    const result = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_r1');
      const first = await answerOf(db, asSystem(), BEGIN, 'pi_r1', 'refund:pi_r1', '25.00');
      const again = await answerOf(db, asSystem(), BEGIN, 'pi_r1', 'refund:pi_r1', '25.00');
      return { first, again, lines: await linesOf(db, 'pi_r1') };
    });

    expect(result.first).toMatchObject({
      created: true,
      state: 'in_transit',
      amount: '25.00',
      userId: buyer.id,
    });
    expect(result.again).toMatchObject({ created: false, id: result.first.id });
    expect(
      result.lines.map((l) => [l.event, l.purpose, l.part, l.amount, l.state, l.transferKey]),
    ).toEqual([
      ['money.late_payment', 'late_payment', 'whole', '25.00', null, null],
      ['money.refund', 'late_payment', 'whole', '-25.00', 'in_transit', 'refund:pi_r1'],
    ]);
  });

  it('is never more than what is left of the payment, and only of a payment recorded as late', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_r2');
      return [
        await call(db, asSystem(), BEGIN, 'pi_r2', 'refund:pi_r2', '25.01'),
        await call(db, asSystem(), BEGIN, 'pi_unknown', 'refund:pi_unknown', '5.00'),
        await call(db, asAdmin(), BEGIN, 'pi_r2', 'refund:pi_r2', '5.00'),
      ];
    });

    expect(outcomes.map((o) => (o.ok ? 'ok' : o.message))).toEqual([
      expect.stringContaining('MONEY_REFUND_EXCEEDS_LEFT'),
      expect.stringContaining('MONEY_PAYMENT_NOT_FOUND'),
      expect.stringContaining('MONEY_FORBIDDEN'),
    ]);
  });

  // an admin settles the transfer of a statement it sent (returnMoney.test.ts); the refund of a late
  // payment is the system's from its start to its end
  it.each([
    ['an admin', asAdmin],
    ['root', asRoot],
  ])('is not settled by %s: only the system does', async (_who, actorOf) => {
    const out = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_r_settle');
      await answerOf(db, asSystem(), BEGIN, 'pi_r_settle', 'refund:pi_r_settle', '25.00');
      const outcome = await call(
        db,
        actorOf(),
        SETTLE,
        'refund:pi_r_settle',
        're_settle',
        'succeeded',
        null,
        null,
      );
      return { outcome, lines: await linesOf(db, 'pi_r_settle') };
    });

    expect(out.outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('MONEY_FORBIDDEN'),
    });
    expect(out.lines.at(-1)).toMatchObject({ state: 'in_transit' });
  });

  it('keeps the id the provider gave while it is pending, and is sent when it succeeds', async () => {
    const result = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_r3');
      await answerOf(db, asSystem(), BEGIN, 'pi_r3', 'refund:pi_r3', '25.00');
      const pending = await answerOf(
        db,
        asSystem(),
        SETTLE,
        'refund:pi_r3',
        're_3',
        'pending',
        null,
        null,
      );
      const afterPending = (await linesOf(db, 'pi_r3'))[1]!;
      const sent = await answerOf(
        db,
        asSystem(),
        SETTLE,
        'refund:pi_r3',
        're_3',
        'succeeded',
        null,
        null,
      );
      const afterSent = (await linesOf(db, 'pi_r3'))[1]!;
      return { pending, afterPending, sent, afterSent };
    });

    expect(result.pending).toMatchObject({ changed: false, status: 'pending' });
    expect(result.afterPending).toMatchObject({ refundId: 're_3', state: 'in_transit' });
    expect(result.sent).toMatchObject({
      changed: true,
      purpose: 'late_payment',
      amount: '25.00',
      sentBack: false,
    });
    expect(result.afterSent).toMatchObject({ refundId: 're_3', state: 'sent', byDashboard: false });
  });

  it('is settled once however often the end comes, by the key or by the id', async () => {
    const result = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_r4');
      await answerOf(db, asSystem(), BEGIN, 'pi_r4', 'refund:pi_r4', '25.00');
      const first = await answerOf(
        db,
        asSystem(),
        SETTLE,
        'refund:pi_r4',
        're_4',
        'succeeded',
        null,
        null,
      );
      const again = await answerOf(
        db,
        asSystem(),
        SETTLE,
        'refund:pi_r4',
        're_4',
        'succeeded',
        null,
        null,
      );
      // the id alone finds it too (an event of the refund without our key)
      const byId = await answerOf(db, asSystem(), SETTLE, null, 're_4', 'succeeded', null, null);
      return { first, again, byId, lines: await linesOf(db, 'pi_r4') };
    });

    expect(result.first.changed).toBe(true);
    expect(result.again.changed).toBe(false);
    expect(result.byId.changed).toBe(false);
    expect(result.lines).toHaveLength(2);
  });

  it('puts a failure as a new line with the opposite sum, and the money is the shop again', async () => {
    const result = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_r5');
      await answerOf(db, asSystem(), BEGIN, 'pi_r5', 'refund:pi_r5', '25.00');
      const failed = await answerOf(
        db,
        asSystem(),
        SETTLE,
        'refund:pi_r5',
        're_5',
        'failed',
        'card_unavailable',
        'the card is closed',
      );
      const again = await answerOf(
        db,
        asSystem(),
        SETTLE,
        'refund:pi_r5',
        're_5',
        'failed',
        'card_unavailable',
        'the card is closed',
      );
      // a refund that failed does not succeed again
      const late = await answerOf(
        db,
        asSystem(),
        SETTLE,
        'refund:pi_r5',
        're_5',
        'succeeded',
        null,
        null,
      );
      await db.as(asAdmin());
      const [left] = await db.rows<{ left: string }>(LEFT, 'pi_r5');
      return { failed, again, late, lines: await linesOf(db, 'pi_r5'), left: left!.left };
    });

    expect(result.failed).toMatchObject({ changed: true, sentBack: false });
    expect(result.again.changed).toBe(false);
    expect(result.late.changed).toBe(false);
    expect(result.lines.map((l) => [l.event, l.amount, l.state, l.failure])).toEqual([
      ['money.late_payment', '25.00', null, null],
      ['money.refund', '-25.00', 'in_transit', null],
      ['money.refund_failed', '25.00', null, 'card_unavailable'],
    ]);
    expect(result.lines[2]).toMatchObject({ coversId: result.lines[1]!.id, refundId: 're_5' });
    // the line of the refund keeps its state; a refund the provider made and that failed at once
    // gets its id there too, so the list of the refunds names it
    expect(result.lines[1]).toMatchObject({ state: 'in_transit', refundId: 're_5' });
    expect(result.left).toBe('25.00');
  });

  it('can fail after it was sent: the bank sent the money back', async () => {
    const result = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_r6');
      await answerOf(db, asSystem(), BEGIN, 'pi_r6', 'refund:pi_r6', '25.00');
      await answerOf(db, asSystem(), SETTLE, 'refund:pi_r6', 're_6', 'succeeded', null, null);
      const back = await answerOf(
        db,
        asSystem(),
        SETTLE,
        'refund:pi_r6',
        're_6',
        'failed',
        'card_unavailable',
        'expired',
      );
      return { back, lines: await linesOf(db, 'pi_r6') };
    });

    expect(result.back).toMatchObject({ changed: true, sentBack: true });
    expect(result.lines[1]).toMatchObject({ state: 'sent' });
    expect(result.lines[2]).toMatchObject({ event: 'money.refund_failed', amount: '25.00' });
  });

  it('is found again for what the provider told, an end of a refund it has no line for is nothing', async () => {
    const result = await inRolledBackTx(async (db) =>
      answerOf(db, asSystem(), SETTLE, null, 're_nothing', 'succeeded', null, null),
    );

    expect(result).toMatchObject({ changed: false });
  });

  it('is refused a status that is none, a failure without a reason, and an actor that is not an admin', async () => {
    const outcomes = await inRolledBackTx(async (db) => [
      await call(db, asSystem(), SETTLE, 'refund:x', 're_x', 'done', null, null),
      await call(db, asSystem(), SETTLE, 'refund:x', 're_x', 'failed', null, null),
      await call(
        db,
        { role: 'USER', userId: buyer.id },
        SETTLE,
        'refund:x',
        're_x',
        'pending',
        null,
        null,
      ),
    ]);

    expect(outcomes.map((o) => (o.ok ? 'ok' : o.message))).toEqual([
      expect.stringContaining('MONEY_REFUND_STATUS_INVALID'),
      expect.stringContaining('MONEY_REFUND_STATUS_INVALID'),
      expect.stringContaining('MONEY_FORBIDDEN'),
    ]);
  });
});

describe('a refund made by hand in the dashboard of the provider', () => {
  it('is a new line of money going out, once for the refund of the provider', async () => {
    const result = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_h1');
      const first = await answerOf(db, asSystem(), HAND, 'pi_h1', 're_h1', '10.00', 'succeeded');
      const again = await answerOf(db, asSystem(), HAND, 'pi_h1', 're_h1', '10.00', 'succeeded');
      return { first, again, lines: await linesOf(db, 'pi_h1') };
    });

    expect(result.first).toMatchObject({
      created: true,
      attached: false,
      purpose: 'hand',
      state: 'sent',
      late: true,
      left: '15.00',
    });
    expect(result.again).toMatchObject({ created: false, id: result.first.id });
    expect(
      result.lines.map((l) => [l.event, l.purpose, l.amount, l.state, l.byDashboard, l.refundId]),
    ).toEqual([
      ['money.late_payment', 'late_payment', '25.00', null, false, null],
      ['money.refund', 'hand', '-10.00', 'sent', true, 're_h1'],
    ]);
  });

  it.each([
    ['an admin', asAdmin],
    ['root', asRoot],
  ])('is not settled by %s: only the system follows it', async (_who, actorOf) => {
    const out = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_h_settle');
      await answerOf(db, asSystem(), HAND, 'pi_h_settle', 're_h_settle', '10.00', 'pending');
      const outcome = await call(
        db,
        actorOf(),
        SETTLE,
        null,
        're_h_settle',
        'succeeded',
        null,
        null,
      );
      return { outcome, lines: await linesOf(db, 'pi_h_settle') };
    });

    expect(out.outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('MONEY_FORBIDDEN'),
    });
    expect(out.lines.at(-1)).toMatchObject({ purpose: 'hand', state: 'in_transit' });
  });

  it('joins our own refund that waits for its id, the line is not doubled', async () => {
    const result = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_h2');
      await answerOf(db, asSystem(), BEGIN, 'pi_h2', 'refund:pi_h2', '25.00');
      const joined = await answerOf(db, asSystem(), HAND, 'pi_h2', 're_h2', '25.00', 'succeeded');
      return { joined, lines: await linesOf(db, 'pi_h2') };
    });

    expect(result.joined).toMatchObject({
      created: false,
      attached: true,
      purpose: 'late_payment',
      state: 'sent',
    });
    expect(result.lines).toHaveLength(2);
    expect(result.lines[1]).toMatchObject({ refundId: 're_h2', state: 'sent', byDashboard: true });
  });

  it('writes nothing for a refund that failed at once, and tells what the order is for a refund of its payment', async () => {
    const result = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_h3');
      const ignored = await answerOf(db, asSystem(), HAND, 'pi_h3', 're_h3', '5.00', 'failed');

      const orderId = await paidOrderOf(
        db,
        buyer.id,
        admin.id,
        [[product.variantId, 2]],
        DELIVERY_RULE,
      );
      const forOrder = await answerOf(
        db,
        asSystem(),
        HAND,
        `pi_db_${orderId}`,
        're_h4',
        '10.00',
        'pending',
      );
      return { ignored, orderId, forOrder, lines: await linesOf(db, 'pi_h3') };
    });

    expect(result.ignored).toMatchObject({ ignored: true, created: false });
    expect(result.lines).toHaveLength(1);
    expect(result.forOrder).toMatchObject({
      created: true,
      purpose: 'hand',
      state: 'in_transit',
      late: false,
      orderId: result.orderId,
      orderStatus: 'paid',
      orderTotal: '25.00',
      userId: buyer.id,
      left: '15.00',
      openReturns: 0,
    });
  });

  it('is ended by its own events like any refund: it is sent, or it fails as a new line', async () => {
    const result = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_h5');
      await answerOf(db, asSystem(), HAND, 'pi_h5', 're_h5', '10.00', 'pending');
      const sent = await answerOf(db, asSystem(), SETTLE, null, 're_h5', 'succeeded', null, null);
      const failed = await answerOf(
        db,
        asSystem(),
        SETTLE,
        null,
        're_h5',
        'failed',
        'card_unavailable',
        'closed',
      );
      return { sent, failed, lines: await linesOf(db, 'pi_h5') };
    });

    expect(result.sent).toMatchObject({ changed: true, purpose: 'hand' });
    expect(result.failed).toMatchObject({ changed: true, sentBack: true });
    expect(result.lines.map((l) => [l.event, l.amount])).toEqual([
      ['money.late_payment', '25.00'],
      ['money.refund', '-10.00'],
      ['money.refund_failed', '10.00'],
    ]);
  });

  it('takes from what a late payment may still send back', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_h6');
      await answerOf(db, asSystem(), HAND, 'pi_h6', 're_h6', '20.00', 'succeeded');
      return call(db, asSystem(), BEGIN, 'pi_h6', 'refund:pi_h6:500', '5.01');
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('MONEY_REFUND_EXCEEDS_LEFT'),
    });
  });

  it('is written by the system only', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_h7');
      return call(db, asRoot(), HAND, 'pi_h7', 're_h7', '5.00', 'succeeded');
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('MONEY_FORBIDDEN'),
    });
  });
});

// root sends the money of a refund that failed another way: a refund of a late payment, or one made
// by hand in the dashboard. The refund is named by its line (the first line of it, the id the list
// of the refunds gives): a refusal of the provider made no refund, so it has no id of the provider
const OUTSIDE = `select cartlify.mark_payment_refund_outside(
  $1::int, $2::cartlify."OutsideMethod", $3, (now() at time zone 'UTC')::timestamp(3) + $4::interval
) as result`;

// a late payment of 25 whose refund the provider refused or failed; the line of the refund
async function failedLateRefundOf(
  db: DbSession,
  paymentId: string,
  failure: 'card_unavailable' | 'already_refunded' = 'card_unavailable',
) {
  await lateOf(db, paymentId);
  const begun = await answerOf(db, asSystem(), BEGIN, paymentId, `refund:${paymentId}`, '25.00');
  await answerOf(db, asSystem(), SETTLE, `refund:${paymentId}`, null, 'failed', failure, 'refused');
  return begun.id as number;
}

describe('money of a failed refund sent another way', () => {
  it('is one line of the whole sum that names the refund, root its actor, once', async () => {
    const result = await inRolledBackTx(async (db) => {
      const refundLine = await failedLateRefundOf(db, 'pi_o1');
      const marked = await answerOf(
        db,
        asRoot(),
        OUTSIDE,
        refundLine,
        'bank_transfer',
        '  Sent to the account the buyer wrote.  ',
        '0 seconds',
      );
      const again = await call(db, asRoot(), OUTSIDE, refundLine, 'cash', 'Again.', '0 seconds');
      await db.as(asAdmin());
      const [outside] = await db.rows<{
        method: string;
        note: string;
        happenedAt: string | null;
      }>(
        `select method::text as method, note, "happenedAt"::text as "happenedAt"
         from cartlify.money_log where id = $1`,
        marked.id,
      );
      const [left] = await db.rows<{ left: string }>(LEFT, 'pi_o1');
      return {
        refundLine,
        marked,
        again,
        outside: outside!,
        left: left!.left,
        lines: await linesOf(db, 'pi_o1'),
      };
    });

    expect(result.marked).toMatchObject({
      refundLineId: result.refundLine,
      id: expect.any(Number),
    });
    expect(result.lines.map((l) => [l.event, l.purpose, l.part, l.amount])).toEqual([
      ['money.late_payment', 'late_payment', 'whole', '25.00'],
      ['money.refund', 'late_payment', 'whole', '-25.00'],
      ['money.refund_failed', 'late_payment', 'whole', '25.00'],
      ['money.outside', 'late_payment', 'whole', '-25.00'],
    ]);
    expect(result.lines[3]).toMatchObject({
      id: result.marked.id,
      coversId: result.refundLine,
      orderId: null,
      userId: buyer.id,
      actorId: root.id,
    });
    expect(result.outside).toMatchObject({
      method: 'bank_transfer',
      note: 'Sent to the account the buyer wrote.',
      happenedAt: expect.any(String),
    });
    // the money is the buyer's again: nothing is left of the payment with the shop
    expect(result.left).toBe('0.00');
    expect(result.again).toMatchObject({
      ok: false,
      message: expect.stringContaining('PAYMENT_REFUND_ALREADY_MARKED'),
    });
  });

  // a refund made by hand that root tied to a statement, which then failed: the money that goes
  // another way is the money of the statement
  it('names the statement a refund made by hand was tied to', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await paidOrderOf(
        db,
        buyer.id,
        admin.id,
        [[product.variantId, 2]],
        DELIVERY_RULE,
      );
      const paymentId = `pi_db_${orderId}`;
      const hand = await answerOf(
        db,
        asSystem(),
        HAND,
        paymentId,
        `re_o2_${orderId}`,
        '5.00',
        'pending',
      );
      await db.as(asAdmin());
      const [made] = await db.rows<{ id: number }>(
        `select cartlify.create_return(
           $1::int,
           (select jsonb_agg(jsonb_build_object('orderItemId', i.id, 'quantity', i.quantity))
            from cartlify.order_items as i where i."orderId" = $1::int),
           'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
           'shop_cancel'::cartlify."ReturnReason", null, 'Test Buyer', 'buyer@example.com',
           null, null, 4, 'Europe/Madrid'
         ) as id`,
        orderId,
      );
      // root says the refund was for the goods of the order
      await answerOf(
        db,
        asRoot(),
        `select cartlify.decide_money_use($1::int, $2::jsonb, 0, 'For the goods.') as result`,
        hand.id,
        JSON.stringify([]),
      );
      await answerOf(
        db,
        asSystem(),
        SETTLE,
        null,
        `re_o2_${orderId}`,
        'failed',
        'card_unavailable',
        'the card is closed',
      );
      const marked = await answerOf(
        db,
        asRoot(),
        OUTSIDE,
        hand.id,
        'cash',
        'Paid at the shop.',
        '0 seconds',
      );
      await db.as(asAdmin());
      const [line] = await db.rows<{ purpose: string; amount: string; returnId: number | null }>(
        `select purpose::text as purpose, amount::text as amount, "returnId"
         from cartlify.money_log where id = $1`,
        marked.id,
      );
      return { returnId: made!.id, line: line! };
    });

    // the money of a refund made by hand is of the order, not of a statement
    expect(result.line).toEqual({ purpose: 'hand', amount: '-5.00', returnId: null });
  });

  it('is refused for a refund whose last word is no failure the money stayed with the shop by', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      // in transit
      await lateOf(db, 'pi_o3');
      const transit = await answerOf(db, asSystem(), BEGIN, 'pi_o3', 'refund:pi_o3', '25.00');
      // sent
      await lateOf(db, 'pi_o4');
      const sent = await answerOf(db, asSystem(), BEGIN, 'pi_o4', 'refund:pi_o4', '25.00');
      await answerOf(db, asSystem(), SETTLE, 'refund:pi_o4', 're_o4', 'succeeded', null, null);
      // the money had gone back already (by hand): the refunds made by hand count it
      const given = await failedLateRefundOf(db, 'pi_o5', 'already_refunded');

      const results = [];
      for (const id of [transit.id as number, sent.id as number, given]) {
        results.push(await call(db, asRoot(), OUTSIDE, id, 'cash', 'A note.', '0 seconds'));
      }
      return results;
    });

    expect(outcomes).toEqual(
      Array(3).fill(
        expect.objectContaining({
          ok: false,
          message: expect.stringContaining('PAYMENT_REFUND_NOT_FAILED'),
        }),
      ),
    );
  });

  it('is refused for a line that is no refund of a late payment or made by hand', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_o6');
      await db.as(asAdmin());
      const [late] = await db.rows<{ id: number }>(
        `select id from cartlify.money_log where "paymentId" = 'pi_o6' and event = 'money.late_payment'`,
      );
      // the payment of an order: no refund at all
      const orderId = await paidOrderOf(
        db,
        buyer.id,
        admin.id,
        [[product.variantId, 1]],
        DELIVERY_RULE,
      );
      await db.as(asAdmin());
      const [payment] = await db.rows<{ id: number }>(
        `select min(id) as id from cartlify.money_log where "orderId" = $1`,
        orderId,
      );

      const results = [];
      for (const id of [late!.id, payment!.id, 2147483647]) {
        results.push(await call(db, asRoot(), OUTSIDE, id, 'cash', 'A note.', '0 seconds'));
      }
      return results;
    });

    expect(outcomes).toEqual(
      Array(3).fill(
        expect.objectContaining({
          ok: false,
          message: expect.stringContaining('PAYMENT_REFUND_NOT_FOUND'),
        }),
      ),
    );
  });

  it('is refused a day of the future or before the refund, and a note of nothing', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const refundLine = await failedLateRefundOf(db, 'pi_o7');
      return {
        future: await call(db, asRoot(), OUTSIDE, refundLine, 'cash', 'A note.', '1 day'),
        before: await call(db, asRoot(), OUTSIDE, refundLine, 'cash', 'A note.', '-1 day'),
        blank: await call(db, asRoot(), OUTSIDE, refundLine, 'cash', '   ', '0 seconds'),
      };
    });

    expect(outcomes.future).toMatchObject({
      ok: false,
      message: expect.stringContaining('PAYMENT_REFUND_OUTSIDE_AT_INVALID'),
    });
    expect(outcomes.before).toMatchObject({
      ok: false,
      message: expect.stringContaining('PAYMENT_REFUND_OUTSIDE_AT_INVALID'),
    });
    expect(outcomes.blank).toMatchObject({
      ok: false,
      message: expect.stringContaining('PAYMENT_REFUND_OUTSIDE_NOTE_REQUIRED'),
    });
  });

  it.each([
    ['an admin', () => asAdmin()],
    ['the system', () => asSystem()],
    ['the buyer', () => ({ role: 'USER', userId: buyer.id }) as Actor],
  ])('is root only: %s is refused', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      const refundLine = await failedLateRefundOf(db, 'pi_o8');
      return call(db, actor(), OUTSIDE, refundLine, 'cash', 'A note.', '0 seconds');
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('PAYMENT_REFUND_FORBIDDEN'),
    });
  });
});

// the number a bank gives to follow a refund (ARN) comes after the refund, in an event of its own
const REFERENCE = `select cartlify.record_refund_bank_reference($1, $2) as result`;

describe('the number of the bank for a refund', () => {
  it('is written once on the lines of the refund, and a second number changes nothing', async () => {
    const result = await inRolledBackTx(async (db) => {
      await lateOf(db, 'pi_arn1');
      const begun = await answerOf(db, asSystem(), BEGIN, 'pi_arn1', 'refund:pi_arn1', '25.00');
      await answerOf(db, asSystem(), SETTLE, 'refund:pi_arn1', 're_arn1', 'succeeded', null, null);
      const first = await answerOf(
        db,
        asSystem(),
        REFERENCE,
        're_arn1',
        '  74567890123456789012345  ',
      );
      const second = await answerOf(
        db,
        asSystem(),
        REFERENCE,
        're_arn1',
        '99999999999999999999999',
      );
      await db.as(asAdmin());
      const [line] = await db.rows<{ bankReference: string | null }>(
        `select "bankReference" from cartlify.money_log where id = $1`,
        begun.id,
      );
      return { first, second, reference: line!.bankReference, id: begun.id };
    });

    expect(result.first).toEqual({ changed: true, lineIds: [result.id] });
    expect(result.second).toEqual({ changed: false, lineIds: [] });
    expect(result.reference).toBe('74567890123456789012345');
  });

  it('changes nothing for a refund nobody wrote', async () => {
    const answer = await inRolledBackTx((db) =>
      answerOf(db, asSystem(), REFERENCE, 're_nobody', '74567890123456789012345'),
    );

    expect(answer).toEqual({ changed: false, lineIds: [] });
  });

  it.each([
    ['an admin', () => asAdmin(), '7456', 'MONEY_FORBIDDEN'],
    ['root', () => asRoot(), '7456', 'MONEY_FORBIDDEN'],
    ['a number of spaces', () => asSystem(), '   ', 'MONEY_LINE_INVALID'],
    [
      'a number of more than 100 characters',
      () => asSystem(),
      '7'.repeat(101),
      'MONEY_LINE_INVALID',
    ],
    ['no number', () => asSystem(), null, 'MONEY_LINE_INVALID'],
  ])('is refused for %s', async (_what, actor, reference, code) => {
    const outcome = await inRolledBackTx((db) => call(db, actor(), REFERENCE, 're_x', reference));

    expect(outcome).toMatchObject({ ok: false, message: expect.stringContaining(code) });
  });
});

// money_paid_left is a step of the functions of the database: the refunds and the transfers above
// hold their limit by it, the app itself has no right to call it
describe('what is left of a payment', () => {
  it.each([
    ['an admin', () => asAdmin()],
    ['root', () => asRoot()],
    ['the system', () => asSystem()],
  ])('is not for %s to ask', async (_who, actor) => {
    const outcome = await inRolledBackTx((db) =>
      call(db, actor(), `select cartlify.money_paid_left('pi_none')::text as left`),
    );

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });
});
