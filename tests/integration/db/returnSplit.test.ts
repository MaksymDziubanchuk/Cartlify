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

// A statement splits when its goods go back in more than one parcel: the units the buyer's parcel
// does not carry, or the units an admin names, leave it for a new statement of the same order
// (split_return): the same moment, person, source, basis and reason, the next number, and the
// statement it came from. Only units that wait for their goods and whose money did not move leave,
// and the statement keeps something. All in transactions that roll back

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let plain: TestProduct;
let other: TestProduct;

beforeAll(async () => {
  buyer = await createUser({ name: 'Anna Koval' });
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  plain = await createProduct({ price: 10, stock: 40 });
  other = await createProduct({ price: 15, stock: 40 });
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

type Row = { id: number; quantity: number; goods: string; money: string; amount: string };

const rowsOf = async (db: DbSession, returnId: number) => {
  await asAdmin(db);
  return db.rows<Row>(
    `select id, quantity, goods::text as goods, money::text as money, amount::text as amount
     from cartlify.return_items where "returnId" = $1 order by id`,
    returnId,
  );
};

type Head = {
  orderId: number;
  number: number;
  statedAt: string;
  source: string;
  basis: string;
  reason: string | null;
  description: string | null;
  contactName: string;
  contactEmail: string;
  createdById: number | null;
  splitFromId: number | null;
  closedAt: string | null;
};

const headOf = async (db: DbSession, returnId: number) => {
  await asAdmin(db);
  const [row] = await db.rows<Head>(
    `select "orderId", number, "statedAt"::text as "statedAt", source::text as source,
            basis::text as basis, reason::text as reason, description, "contactName", "contactEmail",
            "createdById", "splitFromId", "closedAt"::text as "closedAt"
     from cartlify.returns where id = $1`,
    returnId,
  );
  return row!;
};

// a sent order of the buyer and a statement on it, of the buyer from the account (a withdrawal) or of
// an admin outside the withdrawal; the lines of the order are [variant, units]
async function statement(
  db: DbSession,
  kind: 'account' | 'admin',
  lines: [number, number][] = [[plain.variantId, 3]],
) {
  const orderId = await paidOrderOf(db, buyer.id, admin.id, lines, {});
  await asAdmin(db);
  await db.rows(
    `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
    orderId,
  );
  const items = await db.rows<{ id: number; quantity: number }>(
    `select id, quantity from cartlify.order_items where "orderId" = $1 order by id`,
    orderId,
  );
  if (kind === 'account') await asBuyer(db);
  const outcome = await db.attempt<{ id: number }>(
    `select cartlify.create_return(
       $1::int, $2::jsonb, $3::cartlify."ReturnSource", $4::cartlify."ReturnBasis",
       $5::cartlify."ReturnReason", 'It does not fit.', 'Anna Koval', 'anna@example.com', null, null,
       4, 'Europe/Madrid'
     ) as id`,
    orderId,
    JSON.stringify(items.map((item) => ({ orderItemId: item.id, quantity: item.quantity }))),
    kind,
    kind === 'account' ? 'withdrawal' : 'other',
    kind === 'account' ? null : 'defect',
  );
  if (!outcome.ok) throw new Error(`create_return refused: ${outcome.message}`);
  const returnId = outcome.rows[0]!.id;
  return { orderId, returnId, rows: await rowsOf(db, returnId) };
}

const split = (db: DbSession, returnId: number, items: unknown) =>
  db.attempt<{ id: number }>(
    `select cartlify.split_return($1::int, $2::jsonb) as id`,
    returnId,
    JSON.stringify(items),
  );

const idOf = (outcome: Awaited<ReturnType<typeof split>>) => {
  if (!outcome.ok) throw new Error(`split_return refused: ${outcome.message}`);
  return outcome.rows[0]!.id;
};

// the buyer tells of the parcel, naming the units it carries (none named: all of them)
const provide = (db: DbSession, returnId: number, items: unknown) =>
  db.attempt(
    `select 1 as done from cartlify.provide_return_proof(
       $1::int, 'DHL', 'JD0146000123', null, null, $2::jsonb
     )`,
    returnId,
    items === null ? null : JSON.stringify(items),
  );

const splitsOf = async (db: DbSession, returnId: number) => {
  await asAdmin(db);
  return db.rows<{ id: number }>(
    `select id from cartlify.returns where "splitFromId" = $1 order by id`,
    returnId,
  );
};

const refusedWith = (code: string) => ({ ok: false, message: expect.stringContaining(code) });

describe('split_return', () => {
  it('takes the units an admin names into a new statement of the order, with the same moment, person, source, basis and reason, the next number', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rows } = await statement(db, 'admin');
      const splitId = idOf(await split(db, returnId, [{ itemId: rows[0]!.id, quantity: 1 }]));
      return {
        returnId,
        splitId,
        first: await headOf(db, returnId),
        second: await headOf(db, splitId),
        firstRows: await rowsOf(db, returnId),
        secondRows: await rowsOf(db, splitId),
      };
    });

    const { number, splitFromId, ...same } = out.first;
    expect(out.second).toEqual({ ...same, number: number + 1, splitFromId: out.returnId });
    expect(splitFromId).toBeNull();
    expect(out.firstRows).toEqual([
      expect.objectContaining({ quantity: 2, goods: 'expected', amount: '20.00' }),
    ]);
    expect(out.secondRows).toEqual([
      expect.objectContaining({
        quantity: 1,
        goods: 'expected',
        money: 'not_refunded',
        amount: '10.00',
      }),
    ]);
  });

  it('moves a row whose units all leave, and the statement of the account keeps its account', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rows } = await statement(db, 'account', [
        [plain.variantId, 1],
        [other.variantId, 2],
      ]);
      await asAdmin(db);
      const splitId = idOf(await split(db, returnId, [{ itemId: rows[1]!.id, quantity: 2 }]));
      return {
        moved: rows[1]!.id,
        second: await headOf(db, splitId),
        firstRows: await rowsOf(db, returnId),
        secondRows: await rowsOf(db, splitId),
      };
    });

    expect(out.second).toMatchObject({
      source: 'account',
      basis: 'withdrawal',
      createdById: buyer.id,
    });
    expect(out.firstRows.map((row) => row.quantity)).toEqual([1]);
    expect(out.secondRows).toEqual([
      expect.objectContaining({ id: out.moved, quantity: 2, amount: '30.00' }),
    ]);
  });

  it('takes only units that wait for their goods and whose money did not move (RETURN_ITEM_NOT_EXPECTED, RETURN_ITEM_MONEY_SETTLED)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rows } = await statement(db, 'admin', [
        [plain.variantId, 2],
        [other.variantId, 1],
      ]);
      await asAdmin(db);
      // the first row is in; the money of the second goes ahead of its goods
      await db.rows(
        `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
        returnId,
        JSON.stringify([{ itemId: rows[0]!.id, quantity: 2, goods: 'to_stock' }]),
      );
      await db.rows(
        `select cartlify.begin_return_refund($1::int, $2::int[], null::jsonb, null::numeric) as done`,
        returnId,
        [rows[1]!.id],
      );
      return {
        came: await split(db, returnId, [{ itemId: rows[0]!.id, quantity: 1 }]),
        paid: await split(db, returnId, [{ itemId: rows[1]!.id, quantity: 1 }]),
      };
    });

    expect(out.came).toMatchObject(refusedWith('RETURN_ITEM_NOT_EXPECTED'));
    expect(out.paid).toMatchObject(refusedWith('RETURN_ITEM_MONEY_SETTLED'));
  });

  it('leaves the statement something to wait for (RETURN_SPLIT_INVALID)', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { returnId, rows } = await statement(db, 'admin');
      return split(db, returnId, [{ itemId: rows[0]!.id, quantity: 3 }]);
    });

    expect(outcome).toMatchObject(refusedWith('RETURN_SPLIT_INVALID'));
  });

  it('refuses more units than a row holds, a row of another statement and a list of nothing, and makes no statement', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rows } = await statement(db, 'admin', [
        [plain.variantId, 2],
        [other.variantId, 1],
      ]);
      const another = await statement(db, 'admin');
      await asAdmin(db);
      return {
        exceeded: await split(db, returnId, [{ itemId: rows[0]!.id, quantity: 3 }]),
        foreign: await split(db, returnId, [{ itemId: another.rows[0]!.id, quantity: 1 }]),
        empty: await split(db, returnId, []),
        none: await split(db, returnId, null),
        shape: await split(db, returnId, [{ itemId: rows[0]!.id }]),
        splits: await splitsOf(db, returnId),
      };
    });

    expect(out.exceeded).toMatchObject(refusedWith('RETURN_QUANTITY_EXCEEDED'));
    expect(out.foreign).toMatchObject(refusedWith('RETURN_ITEM_NOT_FOUND'));
    expect(out.empty).toMatchObject(refusedWith('RETURN_ITEMS_REQUIRED'));
    expect(out.none).toMatchObject(refusedWith('RETURN_ITEMS_REQUIRED'));
    expect(out.shape).toMatchObject(refusedWith('RETURN_QUANTITY_INVALID'));
    expect(out.splits).toEqual([]);
  });

  it('is of an admin or root, never of the system or the buyer (RETURN_FORBIDDEN)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rows } = await statement(db, 'admin');
      const items = [{ itemId: rows[0]!.id, quantity: 1 }];
      await asSystem(db);
      const system = await split(db, returnId, items);
      await asBuyer(db);
      const byBuyer = await split(db, returnId, items);
      await asRoot(db);
      const byRoot = await split(db, returnId, items);
      await asAdmin(db);
      const missing = await split(db, 2_000_000_000, items);
      return { system, byBuyer, byRoot, missing };
    });

    expect(out.system).toMatchObject(refusedWith('RETURN_FORBIDDEN'));
    expect(out.byBuyer).toMatchObject(refusedWith('RETURN_FORBIDDEN'));
    expect(out.byRoot.ok).toBe(true);
    expect(out.missing).toMatchObject(refusedWith('RETURN_NOT_FOUND'));
  });
});

describe('the parcel of the buyer names the units it carries', () => {
  it('splits the units it does not carry off into a new statement, the parcel stays with the first', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rows } = await statement(db, 'account');
      await asBuyer(db);
      const told = await provide(db, returnId, [{ itemId: rows[0]!.id, quantity: 1 }]);
      const [second] = await splitsOf(db, returnId);
      await asAdmin(db);
      const parcels = await db.rows<{ returnId: number }>(
        `select "returnId" from cartlify.order_shipments where "returnId" in ($1, $2)`,
        returnId,
        second?.id ?? 0,
      );
      return {
        told,
        returnId,
        firstRows: await rowsOf(db, returnId),
        secondRows: second ? await rowsOf(db, second.id) : [],
        parcels,
      };
    });

    expect(out.told.ok).toBe(true);
    expect(out.firstRows.map((row) => row.quantity)).toEqual([1]);
    expect(out.secondRows.map((row) => row.quantity)).toEqual([2]);
    expect(out.parcels).toEqual([{ returnId: out.returnId }]);
  });

  it('splits nothing when it carries every unit, or names none', async () => {
    const out = await inRolledBackTx(async (db) => {
      const all = await statement(db, 'account');
      const none = await statement(db, 'account');
      await asBuyer(db);
      await provide(db, all.returnId, [{ itemId: all.rows[0]!.id, quantity: 3 }]);
      await provide(db, none.returnId, null);
      return {
        all: await splitsOf(db, all.returnId),
        none: await splitsOf(db, none.returnId),
      };
    });

    expect(out.all).toEqual([]);
    expect(out.none).toEqual([]);
  });

  it('names only units of the statement that wait for their goods (RETURN_ITEM_NOT_FOUND, RETURN_QUANTITY_EXCEEDED)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rows } = await statement(db, 'account');
      const another = await statement(db, 'account');
      await asBuyer(db);
      return {
        foreign: await provide(db, returnId, [{ itemId: another.rows[0]!.id, quantity: 1 }]),
        exceeded: await provide(db, returnId, [{ itemId: rows[0]!.id, quantity: 4 }]),
        splits: await splitsOf(db, returnId),
      };
    });

    expect(out.foreign).toMatchObject(refusedWith('RETURN_ITEM_NOT_FOUND'));
    expect(out.exceeded).toMatchObject(refusedWith('RETURN_QUANTITY_EXCEEDED'));
    expect(out.splits).toEqual([]);
  });
});
