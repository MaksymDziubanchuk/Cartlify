import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';
import { MONEY_LOG_EVENTS } from '@config/journalEvents.js';

import { inCommittedTx, inRolledBackTx, type Actor } from '../../helpers/db.js';
import { paidOrderOf } from '../../helpers/dbOrders.js';
import { inOwnerTx, type OwnerSession } from '../../helpers/ownerDb.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the money journal and the table of the disputes as tables: nobody but the functions of the
// database writes a line, a line is never changed but for the few fields that are written once, only
// admin, root and the buyer of the money read, the checks hold the shape of each event, and an order
// is not sent while something holds it. What the functions write is in moneyPayments.test.ts; here
// the table itself, tried as the owner (the role the functions run as) and as the app

let buyer: TestUser;
let stranger: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  stranger = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ price: 10, stock: 100 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, stranger.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

// a line the way a function writes it, for the system; the fields override the defaults
// a transaction as the owner of the database (rolled back), started as the system: the actor the
// functions of the money run as when the webhook calls them
const withOwner = <T>(fn: (q: OwnerSession) => Promise<T>): Promise<T> =>
  inOwnerTx(async (q) => {
    await q.as({ role: 'ADMIN' });
    return fn(q);
  });

async function writeLine(q: OwnerSession, fields: Record<string, unknown> = {}) {
  const line = {
    event: 'money.late_payment',
    purpose: 'late_payment',
    part: 'whole',
    amount: 25,
    userId: buyer.id,
    provider: 'stripe',
    paymentId: `pi_ml_${randomUUID()}`,
    ...fields,
  };
  const outcome = await q.attempt(
    'select cartlify.log_money_change($1::jsonb) as id',
    JSON.stringify(line),
  );
  return outcome;
}

const idOf = (outcome: Awaited<ReturnType<typeof writeLine>>): number => {
  if (!outcome.ok) throw new Error(`the line was refused: ${outcome.message}`);
  return (outcome.rows[0] as { id: number }).id;
};

describe('the money journal is only added to', () => {
  it.each([
    ['an admin', (): Actor => ({ role: 'ADMIN', userId: admin.id })],
    ['root', (): Actor => ({ role: 'ROOT', userId: root.id })],
    ['the system', (): Actor => ({ role: 'ADMIN' })],
    ['a buyer', (): Actor => ({ role: 'USER', userId: buyer.id })],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])('lets %s neither write a line nor change or delete one', async (_who, actorOf) => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(actorOf());
      return [
        await db.attempt(
          `insert into cartlify.money_log (event, purpose, part, amount, "paymentId", provider)
           values ('money.late_payment', 'late_payment', 'whole', 5, 'pi_app', 'stripe') returning id`,
        ),
        await db.attempt('update cartlify.money_log set amount = 99 returning id'),
        await db.attempt('delete from cartlify.money_log returning id'),
      ];
    });

    // the insert is refused; an update and a delete find no row they may touch
    expect(outcomes[0]).toMatchObject({ ok: false, code: '42501' });
    expect(outcomes[1]).toEqual({ ok: true, rows: [] });
    expect(outcomes[2]).toEqual({ ok: true, rows: [] });
  });

  it('is not written by calling the function of the lines, which only the database steps may', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN' });
      return db.attempt(
        `select cartlify.log_money_change('{"event":"money.late_payment"}'::jsonb)`,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it('names the actor of the context, and none for the system', async () => {
    const lines = await withOwner(async (q) => {
      await q.as({ role: 'ADMIN' });
      const bySystem = idOf(await writeLine(q));
      await q.as({ role: 'ADMIN', userId: admin.id });
      const byAdmin = idOf(await writeLine(q));
      await q.as({ role: 'ROOT', userId: root.id });
      const byRoot = idOf(await writeLine(q));
      return q.rows<{ id: number; actorId: number | null; actorRole: string | null }>(
        `select id, "actorId", "actorRole"::text as "actorRole" from cartlify.money_log
         where id = any($1::int[]) order by id`,
        [bySystem, byAdmin, byRoot],
      );
    });

    expect(lines.map((l) => [l.actorId, l.actorRole])).toEqual([
      [null, null],
      [admin.id, 'ADMIN'],
      [root.id, 'ROOT'],
    ]);
  });

  it('lets its owner write once what a refund takes later, and nothing else', async () => {
    const outcomes = await withOwner(async (q) => {
      const id = idOf(
        await writeLine(q, {
          event: 'money.refund',
          purpose: 'hand',
          amount: -5,
          paymentId: 'pi_guard',
          state: 'in_transit',
        }),
      );
      const update = (set: string, ...values: unknown[]) =>
        q.attempt(`update cartlify.money_log set ${set} where id = ${id} returning id`, ...values);

      return {
        // the id the provider gave: from empty, once
        refundId: await update(`"refundId" = 're_guard'`),
        refundIdAgain: await update(`"refundId" = 're_other'`),
        // the state goes from in_transit to sent with its time, and only that way
        sent: await update(`state = 'sent', "stateAt" = now()`),
        back: await update(`state = 'in_transit'`),
        // the number the bank gives to follow the refund: from empty, once
        bank: await update(`"bankReference" = 'ARN1'`),
        bankAgain: await update(`"bankReference" = 'ARN2'`),
        // the decision on money given back by hand, and its shares: from empty, and again while no
        // line took them (a decision is redone until then)
        use: await update(`"moneyUse" = 'compensation'`),
        useAgain: await update(`"moneyUse" = 'goods'`),
        shares: await update(`meta = '[]'::jsonb`),
        sharesAgain: await update(`meta = '[{"delivery": 1}]'::jsonb`),
        // a part covered of a statement took the shares: the decision stays
        taken: await writeLine(q, {
          event: 'money.refund',
          purpose: 'return',
          part: 'covered',
          amount: 1,
          coversId: id,
          paymentId: 'pi_guard',
          state: 'sent',
        }),
        useTaken: await update(`"moneyUse" = 'compensation'`),
        sharesTaken: await update(`meta = '[]'::jsonb`),
        // never the money
        amount: await update(`amount = -4`),
        event: await update(`event = 'money.outside'`),
        paymentId: await update(`"paymentId" = 'pi_other'`),
        removed: await q.attempt(`delete from cartlify.money_log where id = ${id} returning id`),
      };
    });

    expect(outcomes.refundId.ok).toBe(true);
    expect(outcomes.sent.ok).toBe(true);
    expect(outcomes.bank.ok).toBe(true);
    expect(outcomes.use.ok).toBe(true);
    expect(outcomes.shares.ok).toBe(true);
    expect(outcomes.useAgain.ok).toBe(true);
    expect(outcomes.sharesAgain.ok).toBe(true);
    expect(outcomes.taken.ok).toBe(true);

    for (const refused of [
      outcomes.refundIdAgain,
      outcomes.back,
      outcomes.bankAgain,
      outcomes.useTaken,
      outcomes.sharesTaken,
      outcomes.amount,
      outcomes.event,
      outcomes.paymentId,
    ]) {
      expect(refused).toMatchObject({
        ok: false,
        code: '42501',
        message: expect.stringContaining('MONEY_LOG_APPEND_ONLY'),
      });
    }

    // a delete finds no row to touch: the policy denies it, as for the stock log
    expect(outcomes.removed).toEqual({ ok: true, rows: [] });
  });

  it('lets the cleanup of the retention terms empty the address, the browser, the words and the note, and only make-believe text', async () => {
    const outcomes = await withOwner(async (q) => {
      const id = idOf(
        await writeLine(q, {
          event: 'money.refund_failed',
          purpose: 'hand',
          amount: 5,
          paymentId: 'pi_g4',
          coversId: idOf(
            await writeLine(q, {
              event: 'money.refund',
              purpose: 'hand',
              amount: -5,
              paymentId: 'pi_g4',
              state: 'in_transit',
            }),
          ),
          failure: 'unknown',
          failureText: 'the words of the provider',
        }),
      );
      const update = (set: string) =>
        q.attempt(`update cartlify.money_log set ${set} where id = ${id} returning id`);

      return {
        words: await update(`"failureText" = null`),
        address: await update(`ip = null, "userAgent" = null`),
        wordsBack: await update(`"failureText" = 'new words'`),
      };
    });

    expect(outcomes.words.ok).toBe(true);
    expect(outcomes.address.ok).toBe(true);
    expect(outcomes.wordsBack).toMatchObject({ ok: false, code: '42501' });
  });

  // the guards run before a change; the trigger that counts the sum of a statement runs after a line
  it('has a guard on the table that refuses an update and a delete besides the policies', async () => {
    const guards = await inRolledBackTx((db) =>
      db.rows<{ name: string; events: string }>(
        `select t.tgname as name,
                concat_ws(',',
                  case when t.tgtype & 16 <> 0 then 'update' end,
                  case when t.tgtype & 8 <> 0 then 'delete' end) as events
         from pg_trigger t
         where t.tgrelid = 'cartlify.money_log'::regclass and not t.tgisinternal and t.tgenabled = 'O'
           and t.tgtype & 2 <> 0`,
      ),
    );

    expect(guards).toEqual([{ name: 'trg_money_log_append_only', events: 'update,delete' }]);
  });
});

describe('who reads the money journal', () => {
  it('shows every line to admin and root and a buyer only the lines of their own money', async () => {
    const counts = await withOwner(async (q) => {
      const paymentOf = (userId: number) => `pi_read_${userId}_${randomUUID()}`;
      const own = paymentOf(buyer.id);
      const foreign = paymentOf(stranger.id);
      await writeLine(q, { userId: buyer.id, paymentId: own });
      await writeLine(q, { userId: stranger.id, paymentId: foreign });
      await writeLine(q, { userId: null, paymentId: paymentOf(0) });

      const countAs = async (role: string, userId: number | null) => {
        await q.as({ role, userId } as Actor);
        const [row] = await q.rows<{ n: number }>(
          `select count(*)::int as n from cartlify.money_log where "paymentId" like 'pi_read_%'`,
        );
        return row!.n;
      };

      return {
        admin: await countAs('ADMIN', admin.id),
        root: await countAs('ROOT', root.id),
        system: await countAs('ADMIN', null),
        buyer: await countAs('USER', buyer.id),
        stranger: await countAs('USER', stranger.id),
        guest: await countAs('GUEST', null),
      };
    });

    expect(counts).toEqual({ admin: 3, root: 3, system: 3, buyer: 1, stranger: 1, guest: 0 });
  });
});

describe('the shape of a line', () => {
  it('refuses a movement of nothing, a half actor and a meta that is not a list', async () => {
    const outcomes = await withOwner(async (q) => ({
      zero: await writeLine(q, { amount: 0 }),
      meta: await writeLine(q, { meta: { not: 'a list' } }),
      halfActor: await q.attempt(
        `insert into cartlify.money_log (event, purpose, part, amount, "actorId", "paymentId", provider)
         values ('money.late_payment', 'late_payment', 'whole', 5, ${admin.id}, 'pi_shape', 'stripe')`,
      ),
    }));

    for (const refused of Object.values(outcomes)) {
      expect(refused).toMatchObject({ ok: false });
    }
  });

  it.each([
    ['a payment below 0', { event: 'money.payment', purpose: 'order', part: 'goods', amount: -5 }],
    [
      'a payment without an order',
      { event: 'money.payment', purpose: 'order', part: 'goods', amount: 5 },
    ],
    ['a late payment of the goods', { part: 'goods' }],
    [
      'a refund above 0 in goods',
      { event: 'money.refund', purpose: 'return', part: 'goods', amount: 5, state: 'in_transit' },
    ],
    [
      'a refund of a late payment in parts',
      {
        event: 'money.refund',
        purpose: 'late_payment',
        part: 'goods',
        amount: -5,
        state: 'in_transit',
      },
    ],
    ['a state on a payment', { state: 'in_transit' }],
    ['a failure without its reason', { event: 'money.refund_failed', purpose: 'hand', amount: 5 }],
    [
      'money outside the app without its day',
      {
        event: 'money.outside',
        purpose: 'return',
        part: 'goods',
        amount: -5,
        method: 'cash',
        note: 'by hand',
      },
    ],
    [
      'a note without its way',
      {
        event: 'money.outside',
        purpose: 'return',
        part: 'goods',
        amount: -5,
        happenedAt: '2026-01-01T00:00:00',
        note: 'by hand',
      },
    ],
    [
      'a dispute above 0 taken',
      {
        event: 'money.dispute_withdrawn',
        purpose: 'dispute',
        amount: 5,
        disputeId: 1,
        stripeTxId: 'txn_x',
      },
    ],
    [
      'a parcel cost above 0',
      { event: 'money.return_parcel_cost', purpose: 'shipping', amount: 5 },
    ],
    ['a decision on a payment', { moneyUse: 'goods' }],
    [
      'a correction that corrects nothing',
      { event: 'money.correction', purpose: 'order', part: 'whole', amount: 1 },
    ],
  ])('refuses %s', async (_what, fields) => {
    const outcome = await withOwner((q) => writeLine(q, fields));

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it('refuses a refund written without its state, which the function of the lines always gives', async () => {
    const outcome = await withOwner((q) =>
      q.attempt(
        `insert into cartlify.money_log (event, purpose, part, amount, provider, "paymentId")
         values ('money.refund', 'hand', 'whole', -5, 'stripe', 'pi_no_state')`,
      ),
    );

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });

  it('has a shape for every event of the list of events, and the events are written domain.name', async () => {
    const [row] = await inRolledBackTx((db) =>
      db.rows<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'money_log_shape_chk'`,
      ),
    );

    for (const event of MONEY_LOG_EVENTS) {
      expect(row!.def).toContain(`'${event}'`);
      expect(event).toMatch(/^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*$/);
    }
  });

  it('writes a late payment once for a payment, and a failure once for a part of a refund', async () => {
    const outcomes = await withOwner(async (q) => {
      const first = await writeLine(q, { paymentId: 'pi_once' });
      const second = await writeLine(q, { paymentId: 'pi_once' });
      return { first, second };
    });

    expect(outcomes.first.ok).toBe(true);
    expect(outcomes.second).toMatchObject({ ok: false, code: '23505' });
  });
});

describe('the disputes of the payments', () => {
  const insertDispute = (q: OwnerSession, fields: Record<string, unknown> = {}) =>
    q.attempt(
      `insert into cartlify.payment_disputes (provider, "stripeId", "paymentId", status, "openedAt", "closedAt")
       values ('stripe', $1, $2, $3::cartlify."DisputeStatus", now(), $4) returning id`,
      fields.stripeId ?? `dp_${randomUUID()}`,
      fields.paymentId ?? 'pi_dispute',
      fields.status ?? 'needs_response',
      fields.closedAt ?? null,
    );

  it('is written by the system only, and read by admin and root', async () => {
    const result = await withOwner(async (q) => {
      await q.as({ role: 'ADMIN', userId: admin.id });
      const byAdmin = await insertDispute(q);
      await q.as({ role: 'USER', userId: buyer.id });
      const byBuyer = await insertDispute(q);
      await q.as({ role: 'ADMIN' });
      const bySystem = await insertDispute(q, { stripeId: 'dp_read' });

      const countAs = async (role: string, userId: number | null) => {
        await q.as({ role, userId } as Actor);
        const [row] = await q.rows<{ n: number }>(
          `select count(*)::int as n from cartlify.payment_disputes where "stripeId" = 'dp_read'`,
        );
        return row!.n;
      };

      return {
        byAdmin,
        byBuyer,
        bySystem,
        admin: await countAs('ADMIN', admin.id),
        root: await countAs('ROOT', root.id),
        buyer: await countAs('USER', buyer.id),
        guest: await countAs('GUEST', null),
      };
    });

    expect(result.byAdmin).toMatchObject({ ok: false, code: '42501' });
    expect(result.byBuyer).toMatchObject({ ok: false, code: '42501' });
    expect(result.bySystem.ok).toBe(true);
    expect([result.admin, result.root, result.buyer, result.guest]).toEqual([1, 1, 0, 0]);
  });

  it('is changed by the system in what describes it, never in what identifies it, and never removed', async () => {
    const outcomes = await withOwner(async (q) => {
      const created = await insertDispute(q, { stripeId: 'dp_change' });
      if (!created.ok) throw new Error(`the dispute was refused: ${created.message}`);
      const id = Number(created.rows[0]!.id);
      const update = (set: string) =>
        q.attempt(`update cartlify.payment_disputes set ${set} where id = ${id} returning id`);

      return {
        status: await update(
          `status = 'under_review', "hasEvidence" = true, "submissionCount" = 1, "syncedAt" = now()`,
        ),
        ended: await update(`status = 'won', "closedAt" = now()`),
        stripeId: await update(`"stripeId" = 'dp_other'`),
        paymentId: await update(`"paymentId" = 'pi_other'`),
        openedAt: await update(`"openedAt" = now() - interval '1 day'`),
        removed: await q.attempt(
          `delete from cartlify.payment_disputes where id = ${id} returning id`,
        ),
      };
    });

    expect(outcomes.status.ok).toBe(true);
    expect(outcomes.ended.ok).toBe(true);
    for (const refused of [outcomes.stripeId, outcomes.paymentId, outcomes.openedAt]) {
      expect(refused).toMatchObject({
        ok: false,
        code: '42501',
        message: expect.stringContaining('PAYMENT_DISPUTE_UPDATE_FORBIDDEN'),
      });
    }
    expect(outcomes.removed).toEqual({ ok: true, rows: [] });
  });

  it('is closed with its time, and the same dispute is one row', async () => {
    const outcomes = await withOwner(async (q) => ({
      endedWithoutTime: await insertDispute(q, { status: 'lost' }),
      once: await insertDispute(q, { stripeId: 'dp_once' }),
      twice: await insertDispute(q, { stripeId: 'dp_once' }),
    }));

    expect(outcomes.endedWithoutTime).toMatchObject({ ok: false, code: '23514' });
    expect(outcomes.once.ok).toBe(true);
    expect(outcomes.twice).toMatchObject({ ok: false, code: '23505' });
  });
});

describe('an order that something holds is not sent', () => {
  // the holds are written by the functions of the database that follow the provider and decide for
  // root (a later step of the money work); here the guard and the check of the order, with the list
  // written as the owner writes it. The order is one the payment left (committed: the owner is
  // another connection), every change the test makes is rolled back
  let orderId: number;

  beforeAll(async () => {
    orderId = await inCommittedTx((db) =>
      paidOrderOf(db, buyer.id, admin.id, [[product.variantId, 1]]),
    );
  });

  const hold = (reason: string) =>
    JSON.stringify([{ reason, since: '2026-01-01T00:00:00Z', ref: 1 }]);

  it('is not sent while the list of holds is not empty, and is sent once it is empty', async () => {
    const outcomes = await withOwner(async (q) => {
      const set = (holds: string) =>
        q.attempt(
          `update cartlify.orders set holds = $2::jsonb where id = $1 returning id`,
          orderId,
          holds,
        );
      const ship = () =>
        q.attempt(
          `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
          orderId,
        );

      const held = await set(hold('dispute'));
      await q.as({ role: 'ADMIN', userId: admin.id });
      const sentWhileHeld = await ship();
      await q.as({ role: 'ADMIN' });
      const released = await set('[]');
      await q.as({ role: 'ADMIN', userId: admin.id });
      const sent = await ship();
      return { held, sentWhileHeld, released, sent };
    });

    expect(outcomes.held.ok).toBe(true);
    expect(outcomes.sentWhileHeld).toMatchObject({
      ok: false,
      message: expect.stringContaining('ORDER_ON_HOLD'),
    });
    expect(outcomes.released.ok).toBe(true);
    expect(outcomes.sent.ok).toBe(true);
  });

  it('is changed in its holds by the owner only, never by an admin by a statement of their own', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: admin.id });
      return db.attempt(
        `update cartlify.orders set holds = $2::jsonb where id = $1 returning id`,
        orderId,
        hold('dispute'),
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it('holds only the four reasons, as a list, and only while the order waits to be sent', async () => {
    const outcomes = await withOwner(async (q) => {
      const set = (holds: string) =>
        q.attempt(
          `update cartlify.orders set holds = $2::jsonb where id = $1 returning id`,
          orderId,
          holds,
        );

      const each: boolean[] = [];
      for (const reason of ['dispute', 'hand_refund', 'fraud_warning', 'payment_review']) {
        each.push((await set(hold(reason))).ok);
      }

      // a held order that goes on to be sent is refused by the check too, when the guard is skipped
      const shipped = await q.attempt(
        `update cartlify.orders set status = 'shipped', holds = $2::jsonb where id = $1 returning id`,
        orderId,
        hold('dispute'),
      );

      return {
        unknown: await set(hold('because')),
        notAList: await set('{"reason":"dispute"}'),
        each,
        shipped,
      };
    });

    expect(outcomes.unknown).toMatchObject({ ok: false, code: '23514' });
    expect(outcomes.notAList).toMatchObject({ ok: false, code: '23514' });
    expect(outcomes.each).toEqual([true, true, true, true]);
    expect(outcomes.shipped).toMatchObject({ ok: false });
  });

  it('does not touch fraudWarnedAt by a statement of an admin either', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: admin.id });
      return db.attempt(
        `update cartlify.orders set "fraudWarnedAt" = now() where id = $1 returning id`,
        orderId,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });
});
