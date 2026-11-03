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

// the parcels the shop paid to carry goods back from a buyer: how one is recorded for a statement
// (record_return_shipment), how its cost is written later (set_return_shipment_cost), who may do
// it, the time it may carry, the rules of the row (db/06) and who reads the table (db/03). All in
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

type Fields = {
  carrier?: string | null;
  number?: string | null;
  url?: string | null;
  cost?: number | null;
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
  cost: number | null;
  shippedAt: string;
  recordedById: number;
};

const rowOf = async (db: DbSession, id: number) => {
  await asAdmin(db);
  const [row] = await db.rows<ShipmentRow>(
    `select id, "returnId", carrier, "trackingNumber", "trackingUrl", cost::float8 as cost,
            "shippedAt"::text as "shippedAt", "recordedById"
     from cartlify.return_shipments where id = $1`,
    id,
  );
  return row;
};

describe('record_return_shipment', () => {
  it('records a parcel for a statement as the admin who gave it, with the carrier, the number, the link and the cost', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const outcome = await record(db, returnId);
      return { returnId, outcome, row: outcome.ok ? await rowOf(db, outcome.rows[0]!.id) : null };
    });

    expect(out.outcome.ok).toBe(true);
    expect(out.row).toMatchObject({
      returnId: out.returnId,
      carrier: 'DHL',
      trackingNumber: 'JD0146000123',
      trackingUrl: 'https://track.example.com/JD0146000123',
      cost: 4.5,
      recordedById: admin.id,
    });
  });

  it('lets root record one too, and leaves the carrier, the number, the link and the cost empty when none is given', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      await asRoot(db);
      const outcome = await record(db, returnId, {
        carrier: null,
        number: null,
        url: null,
        cost: null,
      });
      return { outcome, row: outcome.ok ? await rowOf(db, outcome.rows[0]!.id) : null };
    });

    expect(out.outcome.ok).toBe(true);
    expect(out.row).toMatchObject({
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      cost: null,
      recordedById: root.id,
    });
  });

  it('keeps text of blanks as no text', async () => {
    const row = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const outcome = await record(db, returnId, { carrier: '  ', number: ' ', url: '' });
      return outcome.ok ? rowOf(db, outcome.rows[0]!.id) : null;
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
      const now = await record(db, returnId, { at: NOW });
      const future = await record(db, returnId, { at: `${NOW} + interval '1 millisecond'` });
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
      });
      const none = await record(db, returnId, { at: 'null::timestamp' });
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

  it('refuses a number without a carrier, a link that is not https and a cost below 0', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const noCarrier = await record(db, returnId, { carrier: null });
      const badLink = await record(db, returnId, { url: 'http://track.example.com/1' });
      const negative = await record(db, returnId, { cost: -1 });
      const zero = await record(db, returnId, { cost: 0 });
      return { noCarrier, badLink, negative, zero };
    });

    expect(out.noCarrier).toMatchObject({
      ok: false,
      message: expect.stringContaining('return_shipments_tracking_chk'),
    });
    expect(out.badLink).toMatchObject({
      ok: false,
      message: expect.stringContaining('return_shipments_tracking_chk'),
    });
    expect(out.negative).toMatchObject({
      ok: false,
      message: expect.stringContaining('return_shipments_cost_non_negative'),
    });
    expect(out.zero.ok).toBe(true);
  });
});

describe('set_return_shipment_cost', () => {
  it('writes the cost of a parcel recorded without one, and corrects it, with its time unchanged', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const made = await record(db, returnId, { cost: null });
      const id = made.ok ? made.rows[0]!.id : 0;
      const before = await rowOf(db, id);
      const written = await setCost(db, id, 6.25);
      const afterWrite = await rowOf(db, id);
      const corrected = await setCost(db, id, 7);
      const afterCorrect = await rowOf(db, id);
      return { before, written, corrected, afterWrite, afterCorrect };
    });

    expect(out.before!.cost).toBeNull();
    expect(out.written.ok).toBe(true);
    // the cost it had comes back with the id, for the log
    expect(out.written.ok && out.written.rows[0]!.done).toMatchObject({ oldCost: null });
    expect(out.corrected.ok && out.corrected.rows[0]!.done).toMatchObject({ oldCost: 6.25 });
    expect(out.afterWrite!.cost).toBe(6.25);
    expect(out.afterCorrect!.cost).toBe(7);
    expect(out.afterCorrect!.shippedAt).toBe(out.before!.shippedAt);
  });

  it('refuses a parcel there is not, the system, a buyer and a cost below 0', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const made = await record(db, returnId);
      const id = made.ok ? made.rows[0]!.id : 0;
      const missing = await setCost(db, 2_000_000_000, 1);
      await asSystem(db);
      const system = await setCost(db, id, 1);
      await asBuyer(db);
      const byBuyer = await setCost(db, id, 1);
      await asAdmin(db);
      const negative = await setCost(db, id, -0.01);
      return { missing, system, byBuyer, negative, after: await rowOf(db, id) };
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
    expect(out.negative).toMatchObject({
      ok: false,
      message: expect.stringContaining('return_shipments_cost_non_negative'),
    });
    expect(out.after!.cost).toBe(4.5);
  });
});

describe('the table of the parcels back', () => {
  it('is read by admin and root, not by the buyer of the order', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const made = await record(db, returnId);
      const count = async () =>
        (
          await db.rows<{ n: number }>(
            `select count(*)::int as n from cartlify.return_shipments where "returnId" = $1`,
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
    expect(out.byBuyer).toBe(0);
  });

  it('is written by no statement of the app: an insert, an update and a delete are refused to an admin', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db);
      const made = await record(db, returnId);
      const id = made.ok ? made.rows[0]!.id : 0;
      await asAdmin(db);
      const insert = await db.attempt(
        `insert into cartlify.return_shipments ("returnId", "shippedAt", "recordedById")
         values ($1::int, now() at time zone 'UTC', $2::int)`,
        returnId,
        admin.id,
      );
      const update = await db.attempt(
        `update cartlify.return_shipments set cost = 1 where id = $1 returning id`,
        id,
      );
      const remove = await db.attempt(
        `delete from cartlify.return_shipments where id = $1 returning id`,
        id,
      );
      return { insert, update, remove, after: await rowOf(db, id) };
    });

    expect(out.insert.ok).toBe(false);
    // an update or a delete a policy hides touches no row, or is refused
    for (const outcome of [out.update, out.remove]) {
      expect(outcome.ok === false || outcome.rows.length === 0).toBe(true);
    }
    expect(out.after).toMatchObject({ cost: 4.5 });
  });
});
