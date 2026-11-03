import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';
import {
  deliveryOfPeriodSql,
  deliveryOfStepsSql,
  type DeliveryColumns,
} from '@routes/api/admin/services/helpers/accountingSql.helper.js';

import { cancelPaidOrderIn } from '../../helpers/cancel.js';
import { inCommittedTx, inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { pay, waitingOrderOf, type DeliveryRule } from '../../helpers/dbOrders.js';
import {
  publishContractIn,
  refundReturnIn,
  returnParcelIn,
  withdrawalStatementIn,
} from '../../helpers/returns.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestUser,
} from '../../helpers/factories.js';

// the delivery in the reports of the accounting: what the orders paid in a period paid for it (by
// paidAt, cancelled later or not), told apart what went back with the returns (the delivery share of
// the rows whose money went back, by the time it went back), what the sends cost the shop (by
// shippedAt). The reports run these queries as they are; here they run in one snapshot (repeatable
// read) before and after a step of the test, so the other files that make orders at the same time
// do not matter: the difference is the step alone

const REPEATABLE_READ = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead };
const FROM = new Date('2000-01-01T00:00:00.000Z');
const TO = new Date('2100-01-01T00:00:00.000Z');

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

type Numbers = Record<keyof DeliveryColumns, number>;

// the delivery of the period as one snapshot sees it, read by the admin
async function deliveryOf(db: DbSession, from = FROM, to = TO): Promise<Numbers> {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const sql = deliveryOfPeriodSql(from, to);
  const [row] = await db.rows<Record<string, unknown>>(sql.text, ...sql.values);
  return Object.fromEntries(
    Object.entries(row!).map(([key, value]) => [key, Number(value)]),
  ) as Numbers;
}

const diff = (after: Numbers, before: Numbers): Numbers =>
  Object.fromEntries(
    (Object.keys(after) as (keyof Numbers)[]).map((key) => [
      key,
      Math.round((after[key] - before[key]) * 100) / 100,
    ]),
  ) as Numbers;

// an order of two units at 40 that waits for its payment, its cart made and committed before
async function waitingOrder(rule: DeliveryRule = {}) {
  const product = await createProduct({ stock: 5, price: 40 });
  return inCommittedTx((db) => waitingOrderOf(db, buyer.id, [[product.variantId, 2]], rule));
}

// a send of the order the way an admin records it: the order is shipped, the send has the carrier
async function send(
  db: DbSession,
  orderId: number,
  fields: { cost?: number | null; expense?: boolean } = {},
) {
  await db.as({ role: 'ADMIN', userId: admin.id });
  await db.rows(
    `update cartlify.orders set status = 'shipped'::cartlify."OrderStatus" where id = $1 returning id`,
    orderId,
  );
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.order_shipments ("orderId", carrier, cost)
     values ($1::int, 'DHL', $2::numeric) returning id`,
    orderId,
    fields.cost ?? null,
  );
  if (fields.expense === false) {
    await db.rows(
      `update cartlify.order_shipments set expense = false where id = $1 returning id`,
      row!.id,
    );
  }
}

// the items of an order and the rows of a statement, read by the admin
const itemsOf = async (db: DbSession, orderId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  return db.rows<{ id: number }>(
    `select id from cartlify.order_items where "orderId" = $1 order by id`,
    orderId,
  );
};
const rowsOf = async (db: DbSession, returnId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  return db.rows<{ id: number }>(
    `select id from cartlify.return_items where "returnId" = $1 order by id`,
    returnId,
  );
};

describe('the delivery of a period', () => {
  it('counts what a paid order paid for the delivery as income, with the orders that paid for it', async () => {
    const paid = await waitingOrder({ flat: 6 });
    const free = await waitingOrder();

    const { before, after } = await inRolledBackTx(async (db) => {
      const before = await deliveryOf(db);
      expect(await pay(db, admin.id, paid)).toBe('PAID');
      expect(await pay(db, admin.id, free)).toBe('PAID');
      return { before, after: await deliveryOf(db) };
    }, REPEATABLE_READ);

    // the order with a delivery that cost nothing is paid too, but paid nothing for it
    expect(diff(after, before)).toMatchObject({
      paid_orders: 1,
      paid_revenue: 6,
      refunded_orders: 0,
      refunded_revenue: 0,
    });
  });

  it('counts no delivery of an order that waits for its payment', async () => {
    const waiting = await waitingOrder({ flat: 6 });

    const { before, after } = await inRolledBackTx(async (db) => {
      const before = await deliveryOf(db);
      return { before, after: await deliveryOf(db) };
    }, REPEATABLE_READ);

    expect(waiting).toBeGreaterThan(0);
    expect(diff(after, before).paid_revenue).toBe(0);
  });

  it('keeps the delivery of a paid order in its income when it is cancelled, and tells apart what went back when the money did', async () => {
    const orderId = await waitingOrder({ flat: 6 });

    const { paid, cancelled, refunded } = await inRolledBackTx(async (db) => {
      const before = await deliveryOf(db);
      await pay(db, admin.id, orderId);
      const paid = diff(await deliveryOf(db), before);
      const returnId = await cancelPaidOrderIn(db, admin.id, orderId);
      const cancelled = diff(await deliveryOf(db), before);
      await refundReturnIn(db, admin.id, returnId);
      return { paid, cancelled, refunded: diff(await deliveryOf(db), before) };
    }, REPEATABLE_READ);

    expect(paid).toMatchObject({ paid_revenue: 6, refunded_revenue: 0 });
    // the cancel brings the goods back, the money has not left: the income stays and nothing went back
    expect(cancelled).toMatchObject({
      paid_orders: 1,
      paid_revenue: 6,
      refunded_orders: 0,
      refunded_revenue: 0,
    });
    // the money went back: the income of the period it was paid in is the same, the delivery that
    // went back is told apart
    expect(refunded).toMatchObject({
      paid_orders: 1,
      paid_revenue: 6,
      refunded_orders: 1,
      refunded_revenue: 6,
    });
  });

  it('counts the sends the shop owes the carriers for by their cost, and apart the ones without a cost', async () => {
    const withCost = await waitingOrder();
    const withoutCost = await waitingOrder();

    const { before, after } = await inRolledBackTx(async (db) => {
      await pay(db, admin.id, withCost);
      await pay(db, admin.id, withoutCost);
      const before = await deliveryOf(db);
      await send(db, withCost, { cost: 7.35 });
      await send(db, withoutCost, { cost: null });
      return { before, after: await deliveryOf(db) };
    }, REPEATABLE_READ);

    expect(diff(after, before)).toMatchObject({ sends: 2, ship_cost: 7.35, sends_without_cost: 1 });
  });

  // a send the carrier was not paid for (a mistake, a cancelled order) is no expense of the shop
  // a parcel the shop paid to carry goods back from a buyer is an expense of the period of the time
  // the admin gave, apart from the sends to buyers
  it('counts the parcels back by their time, and apart the ones without a cost', async () => {
    const orderId = await waitingOrder();

    const { before, after, early } = await inRolledBackTx(async (db) => {
      await pay(db, admin.id, orderId);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const [item] = await db.rows<{ id: number }>(
        `select id from cartlify.order_items where "orderId" = $1 order by id`,
        orderId,
      );
      const [made] = await db.rows<{ id: number }>(
        `select cartlify.create_return(
           $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
           'defect'::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null, null, 4,
           'Europe/Madrid'
         ) as id`,
        orderId,
        JSON.stringify([{ orderItemId: item!.id, quantity: 1 }]),
      );
      const before = await deliveryOf(db);
      for (const cost of [4.5, null]) {
        await db.rows(
          `select cartlify.record_return_shipment(
             $1::int, 'DHL', null, null, $2::numeric, (now() at time zone 'UTC')::timestamp(3)
           ) as id`,
          made!.id,
          cost,
        );
      }
      return {
        before,
        after: await deliveryOf(db),
        // a period that ended before the parcels were sent has none of them
        early: await deliveryOf(db, FROM, new Date('2020-01-01T00:00:00.000Z')),
      };
    }, REPEATABLE_READ);

    expect(diff(after, before)).toMatchObject({
      return_sends: 2,
      return_ship_cost: 4.5,
      return_sends_without_cost: 1,
      // the sends to the buyers are not the parcels back
      sends: 0,
      ship_cost: 0,
    });
    expect(early).toMatchObject({
      return_sends: 0,
      return_ship_cost: 0,
      return_sends_without_cost: 0,
    });
  });

  // the way back the buyer owed comes off the transfer and is an income of the delivery; the one
  // root paid back to a buyer is spent, by the day it went
  it('counts the way back the buyers owed and the one paid back to them', async () => {
    const product = await createProduct({ stock: 5, price: 40 });

    const { before, after } = await inRolledBackTx(async (db) => {
      const before = await deliveryOf(db);
      // the buyer pays the way back: the shop paid the carrier, the transfer takes 5 off
      await publishContractIn(db, root.id, 'buyer');
      const owed = await waitingOrderOf(db, buyer.id, [[product.variantId, 1]]);
      await pay(db, admin.id, owed);
      const [item] = await itemsOf(db, owed);
      const statement = await withdrawalStatementIn(db, admin.id, owed, item!.id, 1);
      const [row] = await rowsOf(db, statement);
      await db.rows(
        `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb)`,
        statement,
        JSON.stringify([{ itemId: row!.id, quantity: 1, goods: 'to_stock' }]),
      );
      await returnParcelIn(db, admin.id, statement, 7);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const [begun] = await db.rows<{ done: { key: string } }>(
        `select cartlify.begin_return_refund($1::int, null::int[], null::jsonb, 5) as done`,
        statement,
      );
      await db.rows(
        `select cartlify.finish_return_refund($1::uuid, 'succeeded', 're_test_way', null, null) as done`,
        begun!.done.key,
      );

      // the shop pays the way back: root paid 3.50 back to the buyer
      await publishContractIn(db, root.id, 'shop');
      const paidBack = await waitingOrderOf(db, buyer.id, [[product.variantId, 1]]);
      await pay(db, admin.id, paidBack);
      const [other] = await itemsOf(db, paidBack);
      const second = await withdrawalStatementIn(db, admin.id, paidBack, other!.id, 1);
      await db.as({ role: 'ROOT', userId: root.id });
      await db.rows(
        `select cartlify.record_return_reimbursement(
           $1::int, 3.5, 'cash'::cartlify."ReturnOutsideMethod", 'At the desk.',
           (now() at time zone 'UTC')::timestamp(3)
         ) as done`,
        second,
      );
      return { before, after: await deliveryOf(db) };
    }, REPEATABLE_READ);

    expect(diff(after, before)).toMatchObject({
      return_ship_deducted: 5,
      return_ship_reimbursed: 3.5,
      return_ship_cost: 7,
    });
  });

  it('leaves out a send the shop owes nothing for', async () => {
    const orderId = await waitingOrder();

    const { before, after } = await inRolledBackTx(async (db) => {
      await pay(db, admin.id, orderId);
      const before = await deliveryOf(db);
      await send(db, orderId, { cost: 9, expense: false });
      return { before, after: await deliveryOf(db) };
    }, REPEATABLE_READ);

    expect(diff(after, before)).toMatchObject({ sends: 0, ship_cost: 0, sends_without_cost: 0 });
  });

  it('counts a period by the times, a period that does not hold them counts nothing', async () => {
    const orderId = await waitingOrder({ flat: 6 });

    const { before, after } = await inRolledBackTx(async (db) => {
      await pay(db, admin.id, orderId);
      await send(db, orderId, { cost: 4 });
      const future = new Date('2099-01-01T00:00:00.000Z');
      const before = await deliveryOf(db, future, TO);
      return { before, after: await deliveryOf(db, future, TO) };
    }, REPEATABLE_READ);

    expect(diff(after, before)).toMatchObject({ paid_revenue: 0, sends: 0, ship_cost: 0 });
  });
});

describe('the delivery of the steps of a timeline', () => {
  type StepNumbers = Numbers & { n: number };

  async function stepsOf(db: DbSession): Promise<StepNumbers[]> {
    await db.as({ role: 'ADMIN', userId: admin.id });
    const sql = deliveryOfStepsSql([
      { from: FROM, to: TO },
      { from: new Date('2099-01-01T00:00:00.000Z'), to: TO },
    ]);
    const rows = await db.rows<Record<string, unknown>>(sql.text, ...sql.values);
    return rows.map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [key, Number(value)]),
        ) as StepNumbers,
    );
  }

  it('gives a row for each step with the same counts as the period', async () => {
    const orderId = await waitingOrder({ flat: 6 });

    const { before, after, whole } = await inRolledBackTx(async (db) => {
      const before = await stepsOf(db);
      await pay(db, admin.id, orderId);
      await send(db, orderId, { cost: 4 });
      return { before, after: await stepsOf(db), whole: await deliveryOf(db) };
    }, REPEATABLE_READ);

    expect(after.map((row) => row.n)).toEqual([1, 2]);
    expect(diff(after[0]!, before[0]!)).toMatchObject({
      paid_orders: 1,
      paid_revenue: 6,
      sends: 1,
      ship_cost: 4,
      sends_without_cost: 0,
    });
    // the step after the money was made holds none of it
    expect(diff(after[1]!, before[1]!)).toMatchObject({ paid_revenue: 0, sends: 0, ship_cost: 0 });
    expect(after[0]!.paid_revenue).toBe(whole.paid_revenue);
    expect(after[0]!.ship_cost).toBe(whole.ship_cost);
  });

  it('counts the refund in the step the money went back in', async () => {
    const orderId = await waitingOrder({ flat: 6 });

    const { before, cancelled, after } = await inRolledBackTx(async (db) => {
      await pay(db, admin.id, orderId);
      const before = await stepsOf(db);
      const returnId = await cancelPaidOrderIn(db, admin.id, orderId);
      const cancelled = await stepsOf(db);
      await refundReturnIn(db, admin.id, returnId);
      return { before, cancelled, after: await stepsOf(db) };
    }, REPEATABLE_READ);

    // the cancel alone moves no money
    expect(diff(cancelled[0]!, before[0]!)).toMatchObject({
      refunded_orders: 0,
      refunded_revenue: 0,
    });
    expect(diff(after[0]!, before[0]!)).toMatchObject({ refunded_orders: 1, refunded_revenue: 6 });
  });
});
