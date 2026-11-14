import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { paidOrderOf } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { publishContractIn, withdrawalStatementIn } from '../../helpers/returns.js';

// the parcels the shop paid to carry goods back from a buyer: how one is recorded for a statement
// (record_return_shipment), how what it cost is written into the money journal and corrected later
// (set_return_shipment_cost: the first cost a line, each change a line of the difference), who may
// do it, the time it may carry, the rules of the row (db/06) and who reads the table (db/03). All in
// transactions that roll back

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let plain: TestProduct;

beforeAll(async () => {
  buyer = await createUser({ name: 'Anna Koval' });
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  plain = await createProduct({ price: 10, stock: 40 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asAdmin = (db: DbSession) => db.as({ role: 'ADMIN', userId: admin.id });
const asRoot = (db: DbSession) => db.as({ role: 'ROOT', userId: root.id });
const asSystem = (db: DbSession) => db.as({ role: 'ADMIN' });
const asBuyer = (db: DbSession) => db.as({ role: 'USER', userId: buyer.id });

// a statement of an admin for a unit of a paid order; its id
async function statement(db: DbSession): Promise<number> {
  const orderId = await paidOrderOf(db, buyer.id, admin.id, [[plain.variantId, 2]], {});
  await asAdmin(db);
  const [item] = await db.rows<{ id: number }>(
    `select id from cartlify.order_items where "orderId" = $1 order by id`,
    orderId,
  );
  const outcome = await db.attempt<{ id: number }>(
    `select cartlify.create_return(
       $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
       'defect'::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null, null, 4,
       'Europe/Madrid'
     ) as id`,
    orderId,
    JSON.stringify([{ orderItemId: item!.id, quantity: 1 }]),
  );
  if (!outcome.ok) throw new Error(`create_return refused: ${outcome.message}`);
  return outcome.rows[0]!.id;
}

// a statement of the buyer from the account on a paid order that was not sent: its goods are back
// on the shelf at once, they never travel; its id
async function shelfStatement(db: DbSession): Promise<number> {
  const orderId = await paidOrderOf(db, buyer.id, admin.id, [[plain.variantId, 1]], {});
  await asAdmin(db);
  const [item] = await db.rows<{ id: number }>(
    `select id from cartlify.order_items where "orderId" = $1 order by id`,
    orderId,
  );
  await asBuyer(db);
  const outcome = await db.attempt<{ id: number }>(
    `select cartlify.create_return(
       $1::int, $2::jsonb, 'account'::cartlify."ReturnSource", 'withdrawal'::cartlify."ReturnBasis",
       null, null, 'Anna Koval', 'anna@example.com', null, null, 4, 'Europe/Madrid'
     ) as id`,
    orderId,
    JSON.stringify([{ orderItemId: item!.id, quantity: 1 }]),
  );
  if (!outcome.ok) throw new Error(`create_return refused: ${outcome.message}`);
  return outcome.rows[0]!.id;
}

type Fields = {
  carrier?: string | null;
  number?: string | null;
  url?: string | null;
  cost?: number | string | null;
  // sql of the time, utc without a zone; the moment of the transaction unless given
  at?: string;
};

const NOW = `(now() at time zone 'UTC')::timestamp(3)`;

const record = (db: DbSession, returnId: number, fields: Fields = {}) =>
  db.attempt<{ id: number }>(
    `select cartlify.record_return_shipment(
       $1::int, $2::text, $3::text, $4::text, $5::numeric, ${fields.at ?? NOW}
     ) as id`,
    returnId,
    fields.carrier === undefined ? 'DHL' : fields.carrier,
    fields.number === undefined ? 'JD0146000123' : fields.number,
    fields.url === undefined ? 'https://track.example.com/JD0146000123' : fields.url,
    fields.cost === undefined ? 4.5 : fields.cost,
  );

const setCost = (db: DbSession, shipmentId: number, cost: number | null) =>
  db.attempt<{ done: { shipmentId: number; oldCost: number | null } }>(
    `select cartlify.set_return_shipment_cost($1::int, $2::numeric) as done`,
    shipmentId,
    cost,
  );

type ShipmentRow = {
  id: number;
  returnId: number;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string;
  recordedById: number;
};

const rowOf = async (db: DbSession, id: number) => {
  await asAdmin(db);
  const [row] = await db.rows<ShipmentRow>(
    `select id, "returnId", carrier, "trackingNumber", "trackingUrl",
            "shippedAt"::text as "shippedAt", "recordedById"
     from cartlify.order_shipments where id = $1 and "returnId" is not null`,
    id,
  );
  return row;
};

type CostLine = {
  id: number;
  event: string;
  purpose: string;
  part: string;
  amount: string;
  coversId: number | null;
  orderId: number | null;
  userId: number | null;
  returnId: number | null;
  orderShipmentId: number | null;
  actorId: number | null;
};

// the lines of the money journal of a parcel: what the shop paid the carrier for it, oldest first
const costLinesOf = async (db: DbSession, shipmentId: number) => {
  await asAdmin(db);
  return db.rows<CostLine>(
    `select id, event, purpose::text as purpose, part::text as part, amount::text as amount,
            "coversId", "orderId", "userId", "returnId", "orderShipmentId", "actorId"
     from cartlify.money_log where "orderShipmentId" = $1 order by id`,
    shipmentId,
  );
};

const idOf = (outcome: Awaited<ReturnType<typeof record>>) => {
  if (!outcome.ok) throw new Error(`record_return_shipment refused: ${outcome.message}`);
  return outcome.rows[0]!.id;
};

describe('record_return_shipment', () => {
  it('records a parcel for a statement as the admin who gave it, with the carrier, the number and the link, and its cost as a line of the money journal', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const id = idOf(await record(db, returnId));
      await asAdmin(db);
      const [owner] = await db.rows<{ orderId: number; total: string }>(
        `select "orderId", "refundedTotal"::text as total from cartlify.returns where id = $1`,
        returnId,
      );
      return {
        returnId,
        id,
        owner: owner!,
        row: await rowOf(db, id),
        lines: await costLinesOf(db, id),
      };
    });

    expect(out.row).toMatchObject({
      returnId: out.returnId,
      carrier: 'DHL',
      trackingNumber: 'JD0146000123',
      trackingUrl: 'https://track.example.com/JD0146000123',
      recordedById: admin.id,
    });
    expect(out.lines).toEqual([
      expect.objectContaining({
        event: 'money.return_parcel_cost',
        purpose: 'shipping',
        part: 'whole',
        amount: '-4.50',
        coversId: null,
        orderId: out.owner.orderId,
        userId: buyer.id,
        returnId: out.returnId,
        orderShipmentId: out.id,
        actorId: admin.id,
      }),
    ]);
    // what the shop pays a carrier is not money the buyer gets back
    expect(out.owner.total).toBe('0.00');
  });

  it('lets root record one too, and writes no line while the cost is not known', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      await asRoot(db);
      const id = idOf(
        await record(db, returnId, { carrier: null, number: null, url: null, cost: null }),
      );
      return { row: await rowOf(db, id), lines: await costLinesOf(db, id) };
    });

    expect(out.row).toMatchObject({
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      recordedById: root.id,
    });
    expect(out.lines).toEqual([]);
  });

  // a line of the money journal is a movement of money: a parcel the shop paid nothing for has none
  it('records a parcel that cost nothing, with no line', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const id = idOf(await record(db, returnId, { cost: 0 }));
      return costLinesOf(db, id);
    });

    expect(out).toEqual([]);
  });

  it('keeps text of blanks as no text', async () => {
    const row = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const id = idOf(await record(db, returnId, { carrier: '  ', number: ' ', url: '' }));
      return rowOf(db, id);
    });

    expect(row).toMatchObject({ carrier: null, trackingNumber: null, trackingUrl: null });
  });

  it('refuses the system, a buyer and a statement there is not', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      await asSystem(db);
      const system = await record(db, returnId);
      await asBuyer(db);
      const byBuyer = await record(db, returnId);
      await asAdmin(db);
      const missing = await record(db, 2_000_000_000);
      return { system, byBuyer, missing };
    });

    expect(out.system).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
    expect(out.byBuyer).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
    expect(out.missing).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_NOT_FOUND'),
    });
  });

  it('takes the moment of the transaction, and refuses a moment of the future', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const now = await record(db, returnId, { at: NOW, number: null });
      const future = await record(db, returnId, {
        at: `${NOW} + interval '1 millisecond'`,
        number: null,
      });
      return { now, future };
    });

    expect(out.now.ok).toBe(true);
    expect(out.future).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_SHIPMENT_TIME_INVALID'),
    });
  });

  it('refuses a moment before the order was paid, and no moment at all', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      await asAdmin(db);
      const [row] = await db.rows<{ paid: string }>(
        `select o."paidAt"::text as paid from cartlify.orders as o
         join cartlify.returns as r on r."orderId" = o.id where r.id = $1`,
        returnId,
      );
      const paid = row!.paid;
      const same = await record(db, returnId, { at: `'${paid}'::timestamp` });
      const before = await record(db, returnId, {
        at: `'${paid}'::timestamp - interval '1 millisecond'`,
        number: null,
      });
      const none = await record(db, returnId, { at: 'null::timestamp', number: null });
      return { same, before, none };
    });

    expect(out.same.ok).toBe(true);
    for (const outcome of [out.before, out.none]) {
      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_SHIPMENT_TIME_INVALID'),
      });
    }
  });

  it('refuses a number without a carrier, a link that is not https, and a cost below 0 or with more than two decimals', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const noCarrier = await record(db, returnId, { carrier: null });
      const badLink = await record(db, returnId, { url: 'http://track.example.com/1' });
      const negative = await record(db, returnId, { cost: -1 });
      const fraction = await record(db, returnId, { cost: '4.555' });
      await asAdmin(db);
      const [left] = await db.rows<{ parcels: number; lines: number }>(
        `select (select count(*)::int from cartlify.order_shipments where "returnId" = $1) as parcels,
                (select count(*)::int from cartlify.money_log where "returnId" = $1) as lines`,
        returnId,
      );
      return { noCarrier, badLink, negative, fraction, left: left! };
    });

    expect(out.noCarrier).toMatchObject({
      ok: false,
      message: expect.stringContaining('order_shipments_tracking_chk'),
    });
    expect(out.badLink).toMatchObject({
      ok: false,
      message: expect.stringContaining('order_shipments_tracking_chk'),
    });
    for (const outcome of [out.negative, out.fraction]) {
      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_SHIPMENT_COST_INVALID'),
      });
    }
    // a refusal leaves neither a parcel nor a line
    expect(out.left).toEqual({ parcels: 0, lines: 0 });
  });
});

describe('a parcel to the shop for goods that never left it', () => {
  it('is not recorded: the goods of the statement are on the shelf already (RETURN_NOTHING_WAITING)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const returnId = await shelfStatement(db);
      await asAdmin(db);
      return record(db, returnId);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_NOTHING_WAITING'),
    });
  });
});

describe('set_return_shipment_cost', () => {
  // the reports count each line in the period it is written in, so a past period does not change
  // when a cost is written late or corrected
  it('writes the first cost of a parcel recorded without one as its line, then each change as a correction of the difference', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const id = idOf(await record(db, returnId, { cost: null }));
      const before = await rowOf(db, id);
      const written = await setCost(db, id, 6.25);
      const afterWrite = await costLinesOf(db, id);
      const raised = await setCost(db, id, 7);
      const same = await setCost(db, id, 7);
      const afterSame = await costLinesOf(db, id);
      const lowered = await setCost(db, id, 5);
      return {
        returnId,
        id,
        before,
        written,
        afterWrite,
        raised,
        same,
        afterSame,
        lowered,
        lines: await costLinesOf(db, id),
        after: await rowOf(db, id),
      };
    });

    // the cost it had comes back with the id, for the log
    expect(out.written).toMatchObject({ ok: true, rows: [{ done: { oldCost: null } }] });
    expect(out.raised).toMatchObject({ ok: true, rows: [{ done: { oldCost: 6.25 } }] });
    expect(out.same).toMatchObject({ ok: true, rows: [{ done: { oldCost: 7 } }] });
    expect(out.lowered).toMatchObject({ ok: true, rows: [{ done: { oldCost: 7 } }] });

    expect(out.afterWrite.map((line) => [line.event, line.amount, line.coversId])).toEqual([
      ['money.return_parcel_cost', '-6.25', null],
    ]);
    const first = out.afterWrite[0]!.id;
    // the same cost again is no movement: no line
    expect(out.afterSame).toHaveLength(2);
    expect(out.lines.map((line) => [line.event, line.amount, line.coversId])).toEqual([
      ['money.return_parcel_cost', '-6.25', null],
      ['money.correction', '-0.75', first],
      ['money.correction', '2.00', first],
    ]);
    for (const line of out.lines) {
      expect(line).toMatchObject({
        purpose: 'shipping',
        part: 'whole',
        returnId: out.returnId,
        orderShipmentId: out.id,
        actorId: admin.id,
      });
    }
    // what the parcel cost in the end: the sum of its lines
    expect(out.lines.reduce((sum, line) => sum - Number(line.amount), 0)).toBeCloseTo(5);
    expect(out.after!.shippedAt).toBe(out.before!.shippedAt);
  });

  it('refuses a parcel there is not, the system, a buyer and a cost below 0, and writes nothing', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const id = idOf(await record(db, returnId));
      const missing = await setCost(db, 2_000_000_000, 1);
      await asSystem(db);
      const system = await setCost(db, id, 1);
      await asBuyer(db);
      const byBuyer = await setCost(db, id, 1);
      await asAdmin(db);
      const negative = await setCost(db, id, -0.01);
      const none = await setCost(db, id, null);
      return { missing, system, byBuyer, negative, none, lines: await costLinesOf(db, id) };
    });

    expect(out.missing).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_SHIPMENT_NOT_FOUND'),
    });
    for (const outcome of [out.system, out.byBuyer]) {
      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_FORBIDDEN'),
      });
    }
    for (const outcome of [out.negative, out.none]) {
      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_SHIPMENT_COST_INVALID'),
      });
    }
    expect(out.lines.map((line) => line.amount)).toEqual(['-4.50']);
  });

  // a transfer of a withdrawal took the way back off what the buyer got: the parcel cannot then
  // cost less than was taken, or the buyer was left short
  it('refuses a cost below what a transfer of the statement took off for the way back (RETURN_DEDUCTION_EXCEEDS_COST)', async () => {
    const out = await inRolledBackTx(async (db) => {
      await publishContractIn(db, root.id, 'buyer');
      const orderId = await paidOrderOf(db, buyer.id, admin.id, [[plain.variantId, 2]], {});
      await asAdmin(db);
      const [item] = await db.rows<{ id: number }>(
        `select id from cartlify.order_items where "orderId" = $1`,
        orderId,
      );
      const returnId = await withdrawalStatementIn(db, admin.id, orderId, item!.id, 2);
      const id = idOf(await record(db, returnId, { cost: 7 }));
      await asAdmin(db);
      const [row] = await db.rows<{ id: number }>(
        `select id from cartlify.return_items where "returnId" = $1`,
        returnId,
      );
      await db.rows(
        `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
        returnId,
        JSON.stringify([{ itemId: row!.id, quantity: 2, goods: 'to_stock' }]),
      );
      await db.rows(
        `select cartlify.begin_return_refund($1::int, null::int[], null::jsonb, 5::numeric) as done`,
        returnId,
      );
      const below = await setCost(db, id, 4.99);
      const exact = await setCost(db, id, 5);
      return { below, exact, lines: await costLinesOf(db, id) };
    });

    expect(out.below).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_DEDUCTION_EXCEEDS_COST'),
    });
    expect(out.exact.ok).toBe(true);
    expect(out.lines.map((line) => [line.event, line.amount])).toEqual([
      ['money.return_parcel_cost', '-7.00'],
      ['money.correction', '2.00'],
    ]);
  });
});

describe('the table of the parcels back', () => {
  // a parcel of a statement is a parcel of the order: the buyer of the order reads it as the sends of
  // the order (the server gives the buyer what is theirs to see)
  it('is read by admin, root and the buyer of the order', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const made = await record(db, returnId);
      const count = async () =>
        (
          await db.rows<{ n: number }>(
            `select count(*)::int as n from cartlify.order_shipments where "returnId" = $1`,
            returnId,
          )
        )[0]!.n;
      await asAdmin(db);
      const byAdmin = await count();
      await asRoot(db);
      const byRoot = await count();
      await asBuyer(db);
      const byBuyer = await count();
      return { made, byAdmin, byRoot, byBuyer };
    });

    expect(out.made.ok).toBe(true);
    expect(out.byAdmin).toBe(1);
    expect(out.byRoot).toBe(1);
    expect(out.byBuyer).toBe(1);
  });

  it('is written by no statement of the app: an insert, an update and a delete are refused to an admin', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const id = idOf(await record(db, returnId));
      await asAdmin(db);
      const insert = await db.attempt(
        `insert into cartlify.order_shipments ("orderId", "returnId", direction, "shippedAt", "recordedById")
         select r."orderId", r.id, 'to_shop', now() at time zone 'UTC', $2::int
         from cartlify.returns as r where r.id = $1::int`,
        returnId,
        admin.id,
      );
      const update = await db.attempt(
        `update cartlify.order_shipments set carrier = 'UPS' where id = $1 returning id`,
        id,
      );
      const remove = await db.attempt(
        `delete from cartlify.order_shipments where id = $1 returning id`,
        id,
      );
      return { insert, update, remove, after: await rowOf(db, id) };
    });

    expect(out.insert.ok).toBe(false);
    // an update or a delete a policy hides touches no row, or is refused
    for (const outcome of [out.update, out.remove]) {
      expect(outcome.ok === false || outcome.rows.length === 0).toBe(true);
    }
    expect(out.after).toMatchObject({ carrier: 'DHL' });
  });
});
