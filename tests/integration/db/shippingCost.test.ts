import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession, type Outcome } from '../../helpers/db.js';
import { paidOrderOf } from '../../helpers/dbOrders.js';
import { answerOf, call, linesWhere, stepOf, SYSTEM } from '../../helpers/dbMoney.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// What the shop pays the carrier for a send of an order, in the database:
// one source of the costs of the delivery, the money journal, as for the parcels back of the
// statements. The routes that ship an order and correct a send call the function below instead of
// writing a column. All in transactions that roll back.
//
// The contract the tests hold the function to:
//
// cartlify.record_order_shipment_cost(p_shipment_id integer, p_cost numeric) RETURNS jsonb
//   An admin or root with an account; the system, a buyer and a guest are refused
//   (ORDER_SHIPMENT_FORBIDDEN). Then ORDER_SHIPMENT_NOT_FOUND for no send of that id, and
//   ORDER_SHIPMENT_COST_INVALID for a cost that is null, below 0, above 99999999.99 or of more than
//   two decimals.
//   The cost of a send is the sum of its lines in the money journal (order_shipments.cost is gone).
//   The first cost above 0 is a line money.shipping_cost: the purpose shipping, the part whole, the
//   amount -cost, the send (orderShipmentId), the order, the buyer and the actor. A different cost
//   later is a line money.correction with the difference (the old cost less the new one: a higher
//   cost is below 0, a lower one above 0) that names the first line (coversId), with the same send,
//   order and buyer. The same cost again writes nothing; a cost of 0 while no line names the send
//   writes nothing. A send taken back keeps its lines and may still be corrected; whether the shop
//   owes the carrier (expense) stays the rule of the app (SHIPMENT_COST_NOT_OWED).
//   The answer: { shipmentId, orderId, oldCost, changed }; oldCost: the cost before the call, text
//   with two decimals, null while no line names the send; changed: a line was written.

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ price: 10, stock: 200 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const refused = (code: string) => ({ ok: false, message: expect.stringContaining(code) });

const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });

const COST = `select cartlify.record_order_shipment_cost($1::int, $2::numeric) as result`;

// the admin ships the order and records the send, the way the route does; the id of the send
async function shipped(db: DbSession, orderId: number) {
  const step = await stepOf(db, admin.id, orderId, 'shipped');
  if (!step.ok) throw new Error(`the order was not shipped: ${step.message}`);
  await db.as(asAdmin());
  const [row] = await db.rows<{ id: number }>(
    `insert into cartlify.order_shipments ("orderId", carrier, "trackingNumber")
     values ($1::int, 'DHL', $2) returning id`,
    orderId,
    `TRK${randomUUID().slice(0, 8)}`,
  );
  return row!.id;
}

// a paid order that was sent, and its send
async function sentOrder(db: DbSession) {
  const orderId = await paidOrderOf(db, buyer.id, admin.id, [[product.variantId, 1]]);
  return { orderId, shipmentId: await shipped(db, orderId) };
}

// the admin takes the send back: the order waits to be sent again, the send stays as history, and
// the admin said the shop owes the carrier nothing for it
async function takenBack(db: DbSession, orderId: number, shipmentId: number) {
  await db.as(asAdmin());
  await db.rows(`update cartlify.orders set status = 'paid' where id = $1 returning id`, orderId);
  await db.rows(
    `update cartlify.order_shipments
     set "rolledBackAt" = now() at time zone 'UTC', expense = false
     where id = $1 returning id`,
    shipmentId,
  );
}

const costLinesOf = (db: DbSession, shipmentId: number) =>
  linesWhere(db, admin.id, '"orderShipmentId" = $1', shipmentId);

const sumOf = (lines: { amount: string }[]) =>
  lines.reduce((sum, l) => sum + Math.round(Number(l.amount) * 100), 0) / 100;

describe('the cost of a send', () => {
  it('is written the first time as a line of what the shop pays, in the name of the admin', async () => {
    const result = await inRolledBackTx(async (db) => {
      const sent = await sentOrder(db);
      return {
        sent,
        answer: await answerOf(db, asAdmin(), COST, sent.shipmentId, 7),
        lines: await costLinesOf(db, sent.shipmentId),
      };
    });

    expect(result.answer).toMatchObject({
      shipmentId: result.sent.shipmentId,
      orderId: result.sent.orderId,
      oldCost: null,
      changed: true,
    });
    expect(result.lines).toEqual([
      expect.objectContaining({
        event: 'money.shipping_cost',
        purpose: 'shipping',
        part: 'whole',
        amount: '-7.00',
        orderShipmentId: result.sent.shipmentId,
        orderId: result.sent.orderId,
        userId: buyer.id,
        returnId: null,
        coversId: null,
        actorId: admin.id,
        actorRole: 'ADMIN',
      }),
    ]);
  });

  it('is corrected with the difference, each correction naming the first line: the cost is the sum', async () => {
    const result = await inRolledBackTx(async (db) => {
      const sent = await sentOrder(db);
      const answers = [
        await answerOf(db, asAdmin(), COST, sent.shipmentId, 7),
        await answerOf(db, asAdmin(), COST, sent.shipmentId, 9),
        await answerOf(db, asAdmin(), COST, sent.shipmentId, 4),
      ];
      return { sent, answers, lines: await costLinesOf(db, sent.shipmentId) };
    });

    expect(result.answers.map((a) => [a.oldCost, a.changed])).toEqual([
      [null, true],
      ['7.00', true],
      ['9.00', true],
    ]);
    const firstId = result.lines[0]!.id;
    expect(result.lines.map((l) => [l.event, l.purpose, l.amount, l.coversId])).toEqual([
      ['money.shipping_cost', 'shipping', '-7.00', null],
      ['money.correction', 'shipping', '-2.00', firstId],
      ['money.correction', 'shipping', '5.00', firstId],
    ]);
    for (const line of result.lines) {
      expect(line).toMatchObject({
        orderShipmentId: result.sent.shipmentId,
        orderId: result.sent.orderId,
        userId: buyer.id,
      });
    }
    expect(sumOf(result.lines)).toBe(-4);
  });

  it('writes nothing for the same cost again, nor for a cost of nothing before any', async () => {
    const result = await inRolledBackTx(async (db) => {
      const a = await sentOrder(db);
      await answerOf(db, asAdmin(), COST, a.shipmentId, 7);
      const same = await answerOf(db, asAdmin(), COST, a.shipmentId, 7);
      const b = await sentOrder(db);
      const nothing = await answerOf(db, asAdmin(), COST, b.shipmentId, 0);
      const linesB = await costLinesOf(db, b.shipmentId);
      const firstB = await answerOf(db, asAdmin(), COST, b.shipmentId, 6);
      return {
        same,
        nothing,
        linesB,
        firstB,
        linesA: await costLinesOf(db, a.shipmentId),
        afterB: await costLinesOf(db, b.shipmentId),
      };
    });

    expect(result.same).toMatchObject({ oldCost: '7.00', changed: false });
    expect(result.linesA).toHaveLength(1);
    expect(result.nothing).toMatchObject({ oldCost: null, changed: false });
    expect(result.linesB).toEqual([]);
    expect(result.firstB).toMatchObject({ oldCost: null, changed: true });
    expect(result.afterB.map((l) => [l.event, l.amount])).toEqual([
      ['money.shipping_cost', '-6.00'],
    ]);
  });

  // the step back of the admin: the send was a mistake and cost nothing
  it('stays with a send taken back, and is corrected to nothing when the carrier was not paid', async () => {
    const result = await inRolledBackTx(async (db) => {
      const sent = await sentOrder(db);
      await answerOf(db, asAdmin(), COST, sent.shipmentId, 7);
      await takenBack(db, sent.orderId, sent.shipmentId);
      const kept = await costLinesOf(db, sent.shipmentId);
      const back = await answerOf(db, asAdmin(), COST, sent.shipmentId, 0);
      return { kept, back, lines: await costLinesOf(db, sent.shipmentId) };
    });

    expect(result.kept.map((l) => l.amount)).toEqual(['-7.00']);
    expect(result.back).toMatchObject({ oldCost: '7.00', changed: true });
    expect(result.lines.map((l) => [l.event, l.amount, l.coversId])).toEqual([
      ['money.shipping_cost', '-7.00', null],
      ['money.correction', '7.00', result.lines[0]!.id],
    ]);
    expect(sumOf(result.lines)).toBe(0);
  });

  it('is of its own send: a second send of the order has lines of its own', async () => {
    const result = await inRolledBackTx(async (db) => {
      const sent = await sentOrder(db);
      await answerOf(db, asAdmin(), COST, sent.shipmentId, 7);
      await takenBack(db, sent.orderId, sent.shipmentId);
      const again = await shipped(db, sent.orderId);
      const first = await answerOf(db, asAdmin(), COST, again, 8);
      const corrected = await answerOf(db, asAdmin(), COST, again, 5);
      return {
        first,
        corrected,
        one: await costLinesOf(db, sent.shipmentId),
        two: await costLinesOf(db, again),
      };
    });

    expect(result.first).toMatchObject({ oldCost: null, changed: true });
    expect(result.corrected).toMatchObject({ oldCost: '8.00', changed: true });
    expect(result.one.map((l) => l.amount)).toEqual(['-7.00']);
    expect(result.two.map((l) => [l.event, l.amount, l.coversId])).toEqual([
      ['money.shipping_cost', '-8.00', null],
      ['money.correction', '3.00', result.two[0]!.id],
    ]);
  });

  it('is written by root as well', async () => {
    const lines = await inRolledBackTx(async (db) => {
      const sent = await sentOrder(db);
      await answerOf(db, { role: 'ROOT', userId: root.id }, COST, sent.shipmentId, 7);
      return costLinesOf(db, sent.shipmentId);
    });

    expect(lines).toEqual([expect.objectContaining({ actorId: root.id, actorRole: 'ROOT' })]);
  });

  it.each([
    ['the system', (): Actor => SYSTEM],
    ['a buyer', (): Actor => ({ role: 'USER', userId: buyer.id })],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])('is not written by %s (ORDER_SHIPMENT_FORBIDDEN)', async (_who, actorOf) => {
    const result = await inRolledBackTx(async (db) => {
      const sent = await sentOrder(db);
      return {
        outcome: await call(db, actorOf(), COST, sent.shipmentId, 7),
        lines: await costLinesOf(db, sent.shipmentId),
      };
    });

    expect(result.outcome).toMatchObject(refused('ORDER_SHIPMENT_FORBIDDEN'));
    expect(result.lines).toEqual([]);
  });

  it('is refused for a send that is not there (ORDER_SHIPMENT_NOT_FOUND)', async () => {
    const outcome = await inRolledBackTx((db) => call(db, asAdmin(), COST, 999_999_999, 7));

    expect(outcome).toMatchObject(refused('ORDER_SHIPMENT_NOT_FOUND'));
  });

  it('is refused a cost that is none, below nothing, too large or of more than two decimals (ORDER_SHIPMENT_COST_INVALID)', async () => {
    const result = await inRolledBackTx(async (db) => {
      const sent = await sentOrder(db);
      const outcomes: Outcome[] = [];
      for (const cost of [null, -1, 100_000_000, 1.005]) {
        outcomes.push(await call(db, asAdmin(), COST, sent.shipmentId, cost));
      }
      return { outcomes, lines: await costLinesOf(db, sent.shipmentId) };
    });

    for (const outcome of result.outcomes) {
      expect(outcome).toMatchObject(refused('ORDER_SHIPMENT_COST_INVALID'));
    }
    expect(result.lines).toEqual([]);
  });

  it('is kept nowhere else: the send has no column of its cost', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return db.attempt('select cost from cartlify.order_shipments limit 1');
    });

    // undefined_column
    expect(outcome).toMatchObject({ ok: false, code: '42703' });
  });
});
