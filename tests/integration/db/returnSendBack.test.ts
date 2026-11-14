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
import { publishContractIn, returnParcelIn, withdrawalStatementIn } from '../../helpers/returns.js';

// The goods the shop did not accept go back to the buyer in parcels of the statement
// (send_return_goods_back): each parcel names the rows and the units it carries, a row splits when
// a parcel carries some of its units, a unit goes back once, and what the shop paid the carrier is a
// line of the money journal. All in transactions that roll back

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

type Row = {
  id: number;
  quantity: number;
  goods: string;
  money: string;
  amount: string;
  notAcceptedReason: string | null;
  backShipmentId: number | null;
};

const rowsOf = async (db: DbSession, returnId: number) => {
  await asAdmin(db);
  return db.rows<Row>(
    `select id, quantity, goods::text as goods, money::text as money, amount::text as amount,
            "notAcceptedReason"::text as "notAcceptedReason", "backShipmentId"
     from cartlify.return_items where "returnId" = $1 order by id`,
    returnId,
  );
};

// a sent order of three units at 10 and a statement of an admin for all of them; its id and the id
// of its row
async function statement(db: DbSession) {
  const orderId = await paidOrderOf(db, buyer.id, admin.id, [[plain.variantId, 3]], {});
  await asAdmin(db);
  await db.rows(
    `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
    orderId,
  );
  const [item] = await db.rows<{ id: number }>(
    `select id from cartlify.order_items where "orderId" = $1`,
    orderId,
  );
  const outcome = await db.attempt<{ id: number }>(
    `select cartlify.create_return(
       $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
       'defect'::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null, null, 4,
       'Europe/Madrid'
     ) as id`,
    orderId,
    JSON.stringify([{ orderItemId: item!.id, quantity: 3 }]),
  );
  if (!outcome.ok) throw new Error(`create_return refused: ${outcome.message}`);
  const returnId = outcome.rows[0]!.id;
  const [row] = await rowsOf(db, returnId);
  return { orderId, returnId, rowId: row!.id };
}

// the goods of a row came in: so many units of it not accepted, the rest on the shelf
async function refuse(db: DbSession, returnId: number, rowId: number, units: number) {
  await asAdmin(db);
  const results = [
    { itemId: rowId, quantity: units, goods: 'not_accepted', notAcceptedReason: 'used' },
  ];
  const outcome = await db.attempt(
    `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
    returnId,
    JSON.stringify(results),
  );
  if (!outcome.ok) throw new Error(`receive_return_items refused: ${outcome.message}`);
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

const sendBack = (db: DbSession, returnId: number, items: unknown, fields: Fields = {}) =>
  db.attempt<{ id: number }>(
    `select cartlify.send_return_goods_back(
       $1::int, $2::jsonb, $3::text, $4::text, $5::text, $6::numeric, ${fields.at ?? NOW}
     ) as id`,
    returnId,
    JSON.stringify(items),
    fields.carrier === undefined ? 'DHL' : fields.carrier,
    fields.number === undefined ? 'JD0146000900' : fields.number,
    fields.url === undefined ? null : fields.url,
    fields.cost === undefined ? null : fields.cost,
  );

const idOf = (outcome: Awaited<ReturnType<typeof sendBack>>) => {
  if (!outcome.ok) throw new Error(`send_return_goods_back refused: ${outcome.message}`);
  return outcome.rows[0]!.id;
};

const parcelOf = async (db: DbSession, id: number) => {
  await asAdmin(db);
  const [row] = await db.rows<{
    returnId: number;
    direction: string;
    carrier: string | null;
    trackingNumber: string | null;
    recordedById: number | null;
    confirmedAt: string | null;
    expense: boolean;
  }>(
    `select "returnId", direction::text as direction, carrier, "trackingNumber", "recordedById",
            "confirmedAt"::text as "confirmedAt", expense
     from cartlify.order_shipments where id = $1`,
    id,
  );
  return row;
};

const costLinesOf = async (db: DbSession, shipmentId: number) => {
  await asAdmin(db);
  return db.rows<{ event: string; purpose: string; amount: string; returnId: number | null }>(
    `select event, purpose::text as purpose, amount::text as amount, "returnId"
     from cartlify.money_log where "orderShipmentId" = $1 order by id`,
    shipmentId,
  );
};

const refusedWith = (code: string) => ({ ok: false, message: expect.stringContaining(code) });

describe('send_return_goods_back', () => {
  it('sends the units not accepted back to the buyer in a parcel of the statement that names their row', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rowId } = await statement(db);
      await refuse(db, returnId, rowId, 3);
      const id = idOf(await sendBack(db, returnId, [{ itemId: rowId, quantity: 3 }]));
      return { returnId, id, parcel: await parcelOf(db, id), rows: await rowsOf(db, returnId) };
    });

    expect(out.parcel).toEqual({
      returnId: out.returnId,
      direction: 'to_buyer',
      carrier: 'DHL',
      trackingNumber: 'JD0146000900',
      recordedById: admin.id,
      confirmedAt: null,
      expense: true,
    });
    expect(out.rows).toEqual([
      expect.objectContaining({ quantity: 3, goods: 'not_accepted', backShipmentId: out.id }),
    ]);
  });

  it('splits a row whose units go back in two parcels, the money of the row by its units', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rowId } = await statement(db);
      await refuse(db, returnId, rowId, 3);
      const first = idOf(await sendBack(db, returnId, [{ itemId: rowId, quantity: 2 }]));
      const split = await rowsOf(db, returnId);
      const waiting = split.find((row) => row.backShipmentId === null)!;
      const second = idOf(
        await sendBack(db, returnId, [{ itemId: waiting.id, quantity: 1 }], { number: 'JD2' }),
      );
      return { first, second, split, rows: await rowsOf(db, returnId) };
    });

    expect(out.split).toEqual([
      expect.objectContaining({ quantity: 1, amount: '10.00', backShipmentId: null }),
      expect.objectContaining({
        quantity: 2,
        amount: '20.00',
        goods: 'not_accepted',
        money: 'refused',
        notAcceptedReason: 'used',
        backShipmentId: out.first,
      }),
    ]);
    expect(out.rows.map((row) => [row.quantity, row.backShipmentId])).toEqual([
      [1, out.second],
      [2, out.first],
    ]);
  });

  it('sends a unit back once, and only a unit not accepted (RETURN_NOTHING_TO_SEND_BACK)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rowId } = await statement(db);
      // a unit on the shelf, a unit not accepted, a unit still expected
      await asAdmin(db);
      await db.rows(
        `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
        returnId,
        JSON.stringify([{ itemId: rowId, quantity: 1, goods: 'to_stock' }]),
      );
      const [, stocked] = await rowsOf(db, returnId);
      await db.rows(
        `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb)`,
        returnId,
        JSON.stringify([
          { itemId: rowId, quantity: 1, goods: 'not_accepted', notAcceptedReason: 'damaged' },
        ]),
      );
      const refused = (await rowsOf(db, returnId)).find((row) => row.goods === 'not_accepted')!;
      const sent = await sendBack(db, returnId, [{ itemId: refused.id, quantity: 1 }]);
      return {
        expected: await sendBack(db, returnId, [{ itemId: rowId, quantity: 1 }], { number: 'A' }),
        stocked: await sendBack(db, returnId, [{ itemId: stocked!.id, quantity: 1 }], {
          number: 'B',
        }),
        sent,
        again: await sendBack(db, returnId, [{ itemId: refused.id, quantity: 1 }], { number: 'C' }),
      };
    });

    expect(out.sent.ok).toBe(true);
    expect(out.expected).toMatchObject(refusedWith('RETURN_NOTHING_TO_SEND_BACK'));
    expect(out.stocked).toMatchObject(refusedWith('RETURN_NOTHING_TO_SEND_BACK'));
    expect(out.again).toMatchObject(refusedWith('RETURN_NOTHING_TO_SEND_BACK'));
  });

  it('refuses more units than the row holds, a row of another statement and a list of nothing, and writes no parcel', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rowId } = await statement(db);
      await refuse(db, returnId, rowId, 3);
      const other = await statement(db);
      await refuse(db, other.returnId, other.rowId, 3);
      const outcomes = {
        exceeded: await sendBack(db, returnId, [{ itemId: rowId, quantity: 4 }]),
        foreign: await sendBack(db, returnId, [{ itemId: other.rowId, quantity: 1 }]),
        empty: await sendBack(db, returnId, []),
        none: await sendBack(db, returnId, null),
        shape: await sendBack(db, returnId, [{ itemId: 'one', quantity: 1 }]),
        quantity: await sendBack(db, returnId, [{ itemId: rowId, quantity: 0 }]),
      };
      await asAdmin(db);
      const parcels = await db.rows(
        `select id from cartlify.order_shipments where "returnId" = $1 and direction = 'to_buyer'`,
        returnId,
      );
      return { outcomes, parcels };
    });

    expect(out.outcomes.exceeded).toMatchObject(refusedWith('RETURN_QUANTITY_EXCEEDED'));
    expect(out.outcomes.foreign).toMatchObject(refusedWith('RETURN_ITEM_NOT_FOUND'));
    expect(out.outcomes.empty).toMatchObject(refusedWith('RETURN_ITEMS_REQUIRED'));
    expect(out.outcomes.none).toMatchObject(refusedWith('RETURN_ITEMS_REQUIRED'));
    expect(out.outcomes.shape).toMatchObject(refusedWith('RETURN_ITEMS_INVALID'));
    expect(out.outcomes.quantity).toMatchObject(refusedWith('RETURN_QUANTITY_INVALID'));
    expect(out.parcels).toEqual([]);
  });

  it('writes what the shop paid the carrier as a line of the money journal, none for a cost of nothing', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rowId } = await statement(db);
      await refuse(db, returnId, rowId, 3);
      const paid = idOf(
        await sendBack(db, returnId, [{ itemId: rowId, quantity: 1 }], { cost: 6 }),
      );
      const [waiting] = (await rowsOf(db, returnId)).filter((row) => row.backShipmentId === null);
      const free = idOf(
        await sendBack(db, returnId, [{ itemId: waiting!.id, quantity: 1 }], {
          cost: 0,
          number: 'JD2',
        }),
      );
      return {
        returnId,
        paid: await costLinesOf(db, paid),
        free: await costLinesOf(db, free),
      };
    });

    expect(out.paid).toEqual([
      {
        event: 'money.return_parcel_cost',
        purpose: 'shipping',
        amount: '-6.00',
        returnId: out.returnId,
      },
    ]);
    expect(out.free).toEqual([]);
  });

  it('is of an admin or root, never of the system or the buyer (RETURN_FORBIDDEN)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rowId } = await statement(db);
      await refuse(db, returnId, rowId, 3);
      const items = [{ itemId: rowId, quantity: 1 }];
      await asSystem(db);
      const system = await sendBack(db, returnId, items);
      await asBuyer(db);
      const byBuyer = await sendBack(db, returnId, items);
      await asRoot(db);
      const byRoot = await sendBack(db, returnId, items);
      await asAdmin(db);
      const missing = await sendBack(db, 2_000_000_000, items, { number: 'X' });
      return { system, byBuyer, byRoot, missing };
    });

    expect(out.system).toMatchObject(refusedWith('RETURN_FORBIDDEN'));
    expect(out.byBuyer).toMatchObject(refusedWith('RETURN_FORBIDDEN'));
    expect(out.byRoot.ok).toBe(true);
    expect(out.missing).toMatchObject(refusedWith('RETURN_NOT_FOUND'));
  });

  it('takes the time and the sums of a parcel the way a parcel back to the shop does', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rowId } = await statement(db);
      await refuse(db, returnId, rowId, 3);
      const items = [{ itemId: rowId, quantity: 1 }];
      return {
        future: await sendBack(db, returnId, items, { at: `${NOW} + interval '1 hour'` }),
        beforePaid: await sendBack(db, returnId, items, { at: `${NOW} - interval '30 days'` }),
        cost: await sendBack(db, returnId, items, { cost: 1.005 }),
        first: await sendBack(db, returnId, items, { number: 'JD 77' }),
        twice: await sendBack(db, returnId, [{ itemId: rowId, quantity: 1 }], { number: 'jd77' }),
      };
    });

    expect(out.future).toMatchObject(refusedWith('RETURN_SHIPMENT_TIME_INVALID'));
    expect(out.beforePaid).toMatchObject(refusedWith('RETURN_SHIPMENT_TIME_INVALID'));
    expect(out.cost).toMatchObject(refusedWith('RETURN_SHIPMENT_COST_INVALID'));
    expect(out.first.ok).toBe(true);
    // one parcel, one number in a statement
    expect(out.twice).toMatchObject(refusedWith('RETURN_SHIPMENT_EXISTS'));
  });
});

describe('the parcel a row went back in', () => {
  it('is set by the functions of the statement only: an admin cannot set it by hand', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rowId } = await statement(db);
      await refuse(db, returnId, rowId, 3);
      const id = idOf(await sendBack(db, returnId, [{ itemId: rowId, quantity: 1 }]));
      const [waiting] = (await rowsOf(db, returnId)).filter((row) => row.backShipmentId === null);
      await asAdmin(db);
      const update = await db.attempt(
        `update cartlify.return_items set "backShipmentId" = $1 where id = $2 returning id`,
        id,
        waiting!.id,
      );
      return { update, waitingId: waiting!.id, rows: await rowsOf(db, returnId) };
    });

    // an update a policy hides touches no row, or is refused
    expect(out.update.ok === false || out.update.rows.length === 0).toBe(true);
    expect(out.rows.find((row) => row.id === out.waitingId)).toMatchObject({
      backShipmentId: null,
    });
  });
});

describe('the parcel to the buyer and the way back', () => {
  // a withdrawal of three units of a sent order whose contract makes the buyer pay the way back: one
  // unit on the shelf, two not accepted; the parcel back to the shop cost what it is given (none
  // when not given), and the two units went back to the buyer in a parcel that cost the shop 6
  async function withdrawal(db: DbSession, wayBack: number | null) {
    await publishContractIn(db, root.id, 'buyer');
    const orderId = await paidOrderOf(db, buyer.id, admin.id, [[plain.variantId, 3]], {});
    await asAdmin(db);
    await db.rows(
      `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
      orderId,
    );
    const [item] = await db.rows<{ id: number }>(
      `select id from cartlify.order_items where "orderId" = $1`,
      orderId,
    );
    const returnId = await withdrawalStatementIn(db, admin.id, orderId, item!.id, 3);
    if (wayBack !== null) await returnParcelIn(db, admin.id, returnId, wayBack);
    const [row] = await rowsOf(db, returnId);
    await asAdmin(db);
    await db.rows(
      `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{}'::jsonb)`,
      returnId,
      JSON.stringify([
        { itemId: row!.id, quantity: 1, goods: 'to_stock' },
        { itemId: row!.id, quantity: 2, goods: 'not_accepted', notAcceptedReason: 'used' },
      ]),
    );
    const refused = (await rowsOf(db, returnId)).find((one) => one.goods === 'not_accepted')!;
    const sentBack = idOf(
      await sendBack(db, returnId, [{ itemId: refused.id, quantity: 2 }], { cost: 6 }),
    );
    await asAdmin(db);
    return { returnId, sentBack };
  }

  const begin = (db: DbSession, returnId: number, deduction: number) =>
    db.attempt(
      `select cartlify.begin_return_refund($1::int, null::int[], null::jsonb, $2::numeric) as done`,
      returnId,
      deduction,
    );

  it('is not the way back: a transfer takes none of its cost off (RETURN_DEDUCTION_EXCEEDS_COST)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const none = await withdrawal(db, null);
      const paid = await withdrawal(db, 7);
      return {
        none: await begin(db, none.returnId, 5),
        above: await begin(db, paid.returnId, 7.01),
        all: await begin(db, paid.returnId, 7),
      };
    });

    expect(out.none).toMatchObject(refusedWith('RETURN_DEDUCTION_EXCEEDS_COST'));
    expect(out.above).toMatchObject(refusedWith('RETURN_DEDUCTION_EXCEEDS_COST'));
    expect(out.all.ok).toBe(true);
  });

  it('may cost less whatever a transfer took off for the way back', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, sentBack } = await withdrawal(db, 7);
      const begun = await begin(db, returnId, 7);
      return {
        begun,
        lowered: await db.attempt(
          `select cartlify.set_return_shipment_cost($1::int, 0) as done`,
          sentBack,
        ),
      };
    });

    expect(out.begun.ok).toBe(true);
    expect(out.lowered.ok).toBe(true);
  });
});
