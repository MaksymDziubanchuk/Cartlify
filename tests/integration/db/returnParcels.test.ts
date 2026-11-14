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
import { publishContractIn } from '../../helpers/returns.js';

// The parcel the goods of a statement go back to the shop in and who paid the carrier for it: the
// buyer tells of the parcel with what they paid (a hint), the admin confirms the parcel saying who
// paid it (the cost the shop paid, or the sum of the receipt of the buyer, required when the shop pays
// the way back and did not pay the carrier), and the goods have a result only with the parcel
// confirmed, which the admin confirms in the same step when it is not. All in transactions that roll
// back

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
const asBuyer = (db: DbSession) => db.as({ role: 'USER', userId: buyer.id });

// a sent order of one unit, and the statement on it: of the buyer from the account (a withdrawal),
// or of an admin outside the withdrawal (the shop pays the way back); its id
async function statement(
  db: DbSession,
  kind: 'account' | 'shop',
  payer?: 'buyer' | 'shop',
): Promise<number> {
  if (payer) await publishContractIn(db, root.id, payer);
  const orderId = await paidOrderOf(db, buyer.id, admin.id, [[plain.variantId, 1]], {});
  await asAdmin(db);
  await db.rows(
    `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
    orderId,
  );
  const [item] = await db.rows<{ id: number }>(
    `select id from cartlify.order_items where "orderId" = $1 order by id`,
    orderId,
  );
  if (kind === 'account') await asBuyer(db);
  const outcome = await db.attempt<{ id: number }>(
    `select cartlify.create_return(
       $1::int, $2::jsonb, $3::cartlify."ReturnSource", $4::cartlify."ReturnBasis",
       $5::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null, null, 4,
       'Europe/Madrid'
     ) as id`,
    orderId,
    JSON.stringify([{ orderItemId: item!.id, quantity: 1 }]),
    kind === 'account' ? 'account' : 'admin',
    kind === 'account' ? 'withdrawal' : 'other',
    kind === 'account' ? null : 'defect',
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

const provide = (db: DbSession, returnId: number, buyerPaid: number | string | null) =>
  db.attempt(
    `select 1 as done from cartlify.provide_return_proof($1::int, 'DHL', 'JD0146000123', null, $2::numeric)`,
    returnId,
    buyerPaid,
  );

const confirm = (
  db: DbSession,
  returnId: number,
  sums: { buyerPaid?: number | string | null; cost?: number | string | null } = {},
) =>
  db.attempt(
    `select 1 as done from cartlify.confirm_return_proof($1::int, $2::numeric, $3::numeric)`,
    returnId,
    sums.buyerPaid ?? null,
    sums.cost ?? null,
  );

// the result of the one row of a statement, with its id
async function receiveRow(db: DbSession, returnId: number, goods: string, parcel: unknown = null) {
  await asAdmin(db);
  const [row] = await db.rows<{ id: number }>(
    `select id from cartlify.return_items where "returnId" = $1 order by id`,
    returnId,
  );
  return db.attempt(
    `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, $3::jsonb)`,
    returnId,
    JSON.stringify([{ itemId: row!.id, quantity: 1, goods }]),
    parcel === null ? null : JSON.stringify(parcel),
  );
}

type Parcel = {
  direction: string;
  carrier: string | null;
  recordedById: number | null;
  confirmedById: number | null;
  confirmed: boolean;
  buyerPaid: string | null;
  cost: string;
};

// the parcel to the shop of a statement, with what the shop paid for it in the money journal
async function parcelOf(db: DbSession, returnId: number): Promise<Parcel | null> {
  await asAdmin(db);
  const [row] = await db.rows<Parcel>(
    `select p.direction::text as direction, p.carrier, p."recordedById", p."confirmedById",
            p."confirmedAt" is not null as confirmed, p."buyerPaid"::text as "buyerPaid",
            coalesce(-(select sum(l.amount) from cartlify.money_log as l
                       where l."orderShipmentId" = p.id and l.purpose = 'shipping'), 0)::text as cost
     from cartlify.order_shipments as p
     where p."returnId" = $1 and p.direction = 'to_shop'`,
    returnId,
  );
  return row ?? null;
}

const goodsOf = async (db: DbSession, returnId: number) => {
  await asAdmin(db);
  return (
    await db.rows<{ goods: string }>(
      `select goods::text as goods from cartlify.return_items where "returnId" = $1 order by id`,
      returnId,
    )
  ).map((row) => row.goods);
};

describe('the buyer tells of the parcel with what they paid the carrier', () => {
  it('keeps the sum on the parcel as a hint, and the buyer corrects it until the shop confirms', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db, 'account', 'shop');
      await asBuyer(db);
      const first = await provide(db, returnId, 6.5);
      const told = await parcelOf(db, returnId);
      await asBuyer(db);
      const second = await provide(db, returnId, 7);
      return { first, told, second, after: await parcelOf(db, returnId) };
    });

    expect(out.first.ok).toBe(true);
    expect(out.told).toMatchObject({
      direction: 'to_shop',
      carrier: 'DHL',
      recordedById: buyer.id,
      confirmed: false,
      buyerPaid: '6.50',
    });
    expect(out.second.ok).toBe(true);
    expect(out.after).toMatchObject({ buyerPaid: '7.00' });
  });

  // the shop wrote the parcel (its label, what it cost): what the buyer tells does not take its place
  it('leaves the parcel the shop recorded as it is (RETURN_PARCEL_EXISTS)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db, 'account', 'shop');
      await asAdmin(db);
      const recorded = await db.attempt(
        `select cartlify.record_return_shipment(
           $1::int, 'GLS', 'SHOP-0001', null, 4::numeric, (now() at time zone 'UTC')::timestamp(3)
         ) as id`,
        returnId,
      );
      await asBuyer(db);
      const told = await provide(db, returnId, 6.5);
      return { recorded, told, parcel: await parcelOf(db, returnId) };
    });

    expect(out.recorded.ok).toBe(true);
    expect(out.told).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_PARCEL_EXISTS'),
    });
    expect(out.parcel).toMatchObject({
      carrier: 'GLS',
      recordedById: admin.id,
      buyerPaid: null,
      cost: '4.00',
    });
  });

  it.each([-1, '1.234'])(
    'refuses a sum that is not money (%s) with RETURN_PARCEL_SUM_INVALID',
    async (sum) => {
      const out = await inRolledBackTx(async (db) => {
        const returnId = await statement(db, 'account', 'shop');
        await asBuyer(db);
        return { outcome: await provide(db, returnId, sum), parcel: await parcelOf(db, returnId) };
      });

      expect(out.outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_PARCEL_SUM_INVALID'),
      });
      expect(out.parcel).toBeNull();
    },
  );
});

describe('the admin confirms the parcel with who paid the carrier', () => {
  it('asks the sum of the buyer when the shop pays the way back and did not pay the carrier', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db, 'account', 'shop');
      await asBuyer(db);
      await provide(db, returnId, 9);
      await asAdmin(db);
      const without = await confirm(db, returnId);
      const notYet = await parcelOf(db, returnId);
      const withSum = await confirm(db, returnId, { buyerPaid: 7.5 });
      return { without, notYet, withSum, after: await parcelOf(db, returnId) };
    });

    expect(out.without).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_PARCEL_SUM_REQUIRED'),
    });
    expect(out.notYet).toMatchObject({ confirmed: false, buyerPaid: '9.00' });
    // the sum of the receipt replaces the hint of the buyer
    expect(out.withSum.ok).toBe(true);
    expect(out.after).toMatchObject({
      confirmed: true,
      confirmedById: admin.id,
      buyerPaid: '7.50',
      cost: '0',
    });
  });

  it('takes 0 when the buyer gave no receipt: nothing is given back for the way back', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db, 'shop');
      await asAdmin(db);
      return {
        outcome: await confirm(db, returnId, { buyerPaid: 0 }),
        parcel: await parcelOf(db, returnId),
      };
    });

    expect(out.outcome.ok).toBe(true);
    // confirmed from a letter: the parcel is written by the admin, without a carrier
    expect(out.parcel).toMatchObject({
      carrier: null,
      recordedById: admin.id,
      confirmed: true,
      buyerPaid: '0.00',
    });
  });

  it('writes the cost the shop paid the carrier on the parcel, and keeps no sum of the buyer then', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db, 'account', 'shop');
      await asBuyer(db);
      await provide(db, returnId, 5);
      await asAdmin(db);
      return {
        outcome: await confirm(db, returnId, { cost: 4.2 }),
        parcel: await parcelOf(db, returnId),
      };
    });

    expect(out.outcome.ok).toBe(true);
    expect(out.parcel).toMatchObject({ confirmed: true, buyerPaid: null, cost: '4.20' });
  });

  it('needs no sum when the buyer pays the way back, and keeps the hint of the buyer', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db, 'account', 'buyer');
      await asBuyer(db);
      await provide(db, returnId, 3);
      await asAdmin(db);
      return { outcome: await confirm(db, returnId), parcel: await parcelOf(db, returnId) };
    });

    expect(out.outcome.ok).toBe(true);
    expect(out.parcel).toMatchObject({ confirmed: true, buyerPaid: '3.00' });
  });

  it.each([
    ['both sums', { buyerPaid: 2, cost: 3 }],
    ['a sum below 0', { buyerPaid: -1 }],
    ['a cost with more than two decimals', { cost: '1.005' }],
  ])('refuses %s with RETURN_PARCEL_SUM_INVALID', async (_label, sums) => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db, 'shop');
      await asAdmin(db);
      return { outcome: await confirm(db, returnId, sums), parcel: await parcelOf(db, returnId) };
    });

    expect(out.outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_PARCEL_SUM_INVALID'),
    });
    expect(out.parcel).toBeNull();
  });

  it('confirms no parcel for goods that never left the shop (RETURN_NOTHING_WAITING)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await shelfStatement(db);
      await asAdmin(db);
      return {
        confirmed: await confirm(db, returnId, { buyerPaid: 0 }),
        parcel: await parcelOf(db, returnId),
      };
    });

    expect(out.confirmed).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_NOTHING_WAITING'),
    });
    expect(out.parcel).toBeNull();
  });
});

describe('the goods have a result only with the parcel confirmed', () => {
  it.each(['to_stock', 'written_off', 'lost'])(
    'refuses %s without a confirmed parcel (RETURN_PARCEL_REQUIRED), and nothing changes',
    async (goods) => {
      const out = await inRolledBackTx(async (db) => {
        const returnId = await statement(db, 'shop');
        return {
          outcome: await receiveRow(db, returnId, goods),
          goods: await goodsOf(db, returnId),
        };
      });

      expect(out.outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('RETURN_PARCEL_REQUIRED'),
      });
      expect(out.goods).toEqual(['expected']);
    },
  );

  it('confirms in the same step the parcel the admin writes with the goods in hand', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db, 'shop');
      const outcome = await receiveRow(db, returnId, 'to_stock', {
        buyerPaid: 0,
        carrier: 'DHL',
        trackingNumber: 'JD0146000999',
      });
      return { outcome, goods: await goodsOf(db, returnId), parcel: await parcelOf(db, returnId) };
    });

    expect(out.outcome.ok).toBe(true);
    expect(out.goods).toEqual(['to_stock']);
    expect(out.parcel).toMatchObject({
      carrier: 'DHL',
      recordedById: admin.id,
      confirmed: true,
      buyerPaid: '0.00',
    });
  });

  it('confirms in the same step the parcel the buyer told of, with the sum of the receipt', async () => {
    const out = await inRolledBackTx(async (db) => {
      const returnId = await statement(db, 'account', 'shop');
      await asBuyer(db);
      await provide(db, returnId, 8);
      const without = await receiveRow(db, returnId, 'not_accepted');
      const outcome = await receiveRow(db, returnId, 'to_stock', { buyerPaid: 6 });
      return { without, outcome, parcel: await parcelOf(db, returnId) };
    });

    expect(out.without).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_PARCEL_REQUIRED'),
    });
    expect(out.outcome.ok).toBe(true);
    expect(out.parcel).toMatchObject({
      recordedById: buyer.id,
      confirmed: true,
      buyerPaid: '6.00',
    });
  });

  it('asks no parcel again once it is confirmed, and none for goods that did not arrive', async () => {
    const out = await inRolledBackTx(async (db) => {
      const confirmedOne = await statement(db, 'shop');
      await asAdmin(db);
      await confirm(db, confirmedOne, { buyerPaid: 0 });
      const afterConfirm = await receiveRow(db, confirmedOne, 'to_stock');
      const neverCame = await statement(db, 'shop');
      const notArrived = await receiveRow(db, neverCame, 'not_arrived');
      return {
        afterConfirm,
        notArrived,
        parcel: await parcelOf(db, neverCame),
        goods: await goodsOf(db, neverCame),
      };
    });

    expect(out.afterConfirm.ok).toBe(true);
    expect(out.notArrived.ok).toBe(true);
    expect(out.parcel).toBeNull();
    expect(out.goods).toEqual(['not_arrived']);
  });
});
