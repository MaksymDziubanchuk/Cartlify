import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { paidOrderOf, type DeliveryRule, type Items } from '../../helpers/dbOrders.js';
import {
  SYSTEM,
  begun,
  call,
  itemIdsOf,
  linesWhere,
  rowsOf,
  settledOf,
  statementOf,
} from '../../helpers/dbMoney.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// The money the shop got back outside the app: from the
// buyer for rows of a statement whose money they had (goods paid ahead that never came, more than the
// statement owed), and from a carrier for a parcel of the order. All in transactions that roll back.
//
// cartlify.record_money_received(p_return_id integer, p_items jsonb, p_method OutsideMethod,
//   p_note text, p_at timestamp)
//   Root or an admin with the right of the money, with an account (MONEY_RECEIVED_FORBIDDEN, the
//   system too). The statement is there (MONEY_RECEIVED_NOT_FOUND). p_items, a list of
//   { itemId, amount }: rows of the statement, each once, a sum to the cent above 0
//   (MONEY_RECEIVED_INVALID), rows whose money the buyer has (refunded: MONEY_RECEIVED_NOT_REFUNDED),
//   never more than a row cost less what came back for it already (MONEY_RECEIVED_EXCEEDS). The way
//   and a note of 1 to 500 (MONEY_RECEIVED_NOTE_REQUIRED); the day not before the statement and not
//   of the future (MONEY_RECEIVED_AT_INVALID). One line money.received of the purpose return, the part
//   goods, all of it above 0, the rows in meta ([{ returnItemId, variantId, amount }]), the way, the
//   note and the day, in the name of the actor: the statement has that much less back
//   (refundedTotal), its rows stay as they are. The answer is { id, returnId, orderId, amount }.
//
// cartlify.record_carrier_money(p_shipment_id integer, p_amount numeric, p_method OutsideMethod,
//   p_note text, p_at timestamp)
//   The same people (MONEY_RECEIVED_FORBIDDEN). A parcel of an order, its send or a parcel of a
//   statement (MONEY_RECEIVED_NOT_FOUND); the sum above 0 to the cent (MONEY_RECEIVED_INVALID); the
//   way, the note, the day as above, the day not before the parcel. One line money.received of the
//   purpose shipping, whole, above 0, naming the parcel (and the statement of a parcel back): money
//   of the shop, no statement counts it. The answer is { id, orderId, shipmentId, amount }.

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ price: 10, stock: 400 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const refused = (code: string) => ({ ok: false, message: expect.stringContaining(code) });

const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });
const asAdmin = (db: DbSession) => db.as({ role: 'ADMIN', userId: admin.id });

// two units at 10 and a delivery of 5: an order of 25, sent
const DELIVERY: DeliveryRule = { flat: 5, freeFrom: null, expected: 5 };

async function sentOrder(db: DbSession) {
  const items: Items = [[product.variantId, 2]];
  const orderId = await paidOrderOf(db, buyer.id, admin.id, items, DELIVERY);
  await asAdmin(db);
  await db.rows(
    `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
    orderId,
  );
  const [send] = await db.rows<{ id: number }>(
    `insert into cartlify.order_shipments ("orderId", carrier) values ($1::int, 'DHL') returning id`,
    orderId,
  );
  return { orderId, sendId: send!.id, itemIds: await itemIdsOf(db, admin.id, orderId) };
}

// a statement of an admin for both units, the goods in, its money sent: its row is refunded (20,
// with the delivery of 5)
async function refundedStatement(db: DbSession, orderId: number, itemId: number) {
  await asAdmin(db);
  const [made] = await db.rows<{ id: number }>(
    `select cartlify.create_return(
       $1::int, jsonb_build_array(jsonb_build_object('orderItemId', $2::int, 'quantity', 2)),
       'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
       'defect'::cartlify."ReturnReason", null, 'Test Buyer', 'buyer@example.com', null, null, 4,
       'Europe/Madrid'
     ) as id`,
    orderId,
    itemId,
  );
  const [row] = await rowsOf(db, admin.id, made!.id);
  await asAdmin(db);
  await db.rows(
    `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
    made!.id,
    JSON.stringify([{ itemId: row!.id, quantity: 2, goods: 'to_stock' }]),
  );
  const transfer = await begun(db, admin.id, made!.id);
  await settledOf(db, transfer.key as string, `re_${made!.id}`, 'succeeded');
  return { returnId: made!.id, rowId: row!.id };
}

const RECEIVED = `select cartlify.record_money_received($1::int, $2::jsonb, $3::cartlify."OutsideMethod", $4, $5::timestamp) as result`;
const CARRIER = `select cartlify.record_carrier_money($1::int, $2::numeric, $3::cartlify."OutsideMethod", $4, $5::timestamp) as result`;
const NOW = `(now() at time zone 'UTC')::timestamp(3)`;
const NOTE = 'The buyer paid it back by bank transfer.';

const nowOf = async (db: DbSession) =>
  (await db.rows<{ now: string }>(`select ${NOW}::text as now`))[0]!.now;

const receivedAs = async (
  db: DbSession,
  actor: Actor,
  returnId: number,
  items: unknown,
  opts: { method?: string | null; note?: string | null; at?: string | null } = {},
) =>
  call<{ result: Record<string, unknown> }>(
    db,
    actor,
    RECEIVED,
    returnId,
    JSON.stringify(items),
    opts.method === undefined ? 'bank_transfer' : opts.method,
    opts.note === undefined ? NOTE : opts.note,
    opts.at === undefined ? await nowOf(db) : opts.at,
  );

const carrierAs = async (
  db: DbSession,
  actor: Actor,
  shipmentId: number,
  amount: unknown,
  at?: string,
) =>
  call<{ result: Record<string, unknown> }>(
    db,
    actor,
    CARRIER,
    shipmentId,
    amount,
    'bank_transfer',
    'The carrier paid for the parcel it lost.',
    at ?? (await nowOf(db)),
  );

describe('record_money_received', () => {
  it('writes the money the buyer gave back on the rows, and the statement has that much less back', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, itemIds } = await sentOrder(db);
      const { returnId, rowId } = await refundedStatement(db, orderId, itemIds[0]!);
      const before = await statementOf(db, admin.id, returnId);
      const received = await receivedAs(db, asRoot(), returnId, [{ itemId: rowId, amount: 8 }]);
      return {
        returnId,
        rowId,
        before,
        received,
        after: await statementOf(db, admin.id, returnId),
        rows: await rowsOf(db, admin.id, returnId),
        lines: await linesWhere(
          db,
          admin.id,
          `"returnId" = $1 and event = 'money.received'`,
          returnId,
        ),
      };
    });

    // both units and the delivery that went back with them
    expect(out.before.refundedTotal).toBe('25.00');
    expect(out.received.ok).toBe(true);
    expect(out.received.ok && out.received.rows[0]!.result).toMatchObject({
      returnId: out.returnId,
      amount: '8.00',
    });
    expect(out.after.refundedTotal).toBe('17.00');
    expect(out.rows).toEqual([expect.objectContaining({ money: 'refunded' })]);
    expect(out.lines).toEqual([
      expect.objectContaining({
        purpose: 'return',
        part: 'goods',
        amount: '8.00',
        actorId: root.id,
        meta: [{ returnItemId: out.rowId, variantId: product.variantId, amount: 8 }],
      }),
    ]);
  });

  it('takes no more for a row than it cost, with what came back for it before', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, itemIds } = await sentOrder(db);
      const { returnId, rowId } = await refundedStatement(db, orderId, itemIds[0]!);
      const over = await receivedAs(db, asRoot(), returnId, [{ itemId: rowId, amount: 20.01 }]);
      const part = await receivedAs(db, asRoot(), returnId, [{ itemId: rowId, amount: 15 }]);
      const more = await receivedAs(db, asRoot(), returnId, [{ itemId: rowId, amount: 5.01 }]);
      const rest = await receivedAs(db, asRoot(), returnId, [{ itemId: rowId, amount: 5 }]);
      return { over, part, more, rest };
    });

    expect(out.over).toMatchObject(refused('MONEY_RECEIVED_EXCEEDS'));
    expect(out.part.ok).toBe(true);
    expect(out.more).toMatchObject(refused('MONEY_RECEIVED_EXCEEDS'));
    expect(out.rest.ok).toBe(true);
  });

  it('refuses a row whose money the buyer does not have', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, itemIds } = await sentOrder(db);
      await asAdmin(db);
      const [made] = await db.rows<{ id: number }>(
        `select cartlify.create_return(
           $1::int, jsonb_build_array(jsonb_build_object('orderItemId', $2::int, 'quantity', 1)),
           'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
           'defect'::cartlify."ReturnReason", null, 'Test Buyer', 'buyer@example.com', null, null, 4,
           'Europe/Madrid'
         ) as id`,
        orderId,
        itemIds[0],
      );
      const [row] = await rowsOf(db, admin.id, made!.id);
      return receivedAs(db, asRoot(), made!.id, [{ itemId: row!.id, amount: 5 }]);
    });

    expect(out).toMatchObject(refused('MONEY_RECEIVED_NOT_REFUNDED'));
  });

  it.each([
    ['no rows', []],
    ['a row of another statement', [{ itemId: 2_147_483_000, amount: 5 }]],
    ['a sum of nothing', 'zero'],
    ['a sum below the cent', 'cents'],
    ['a row twice', 'twice'],
  ])('refuses %s', async (_name, shape) => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, itemIds } = await sentOrder(db);
      const { returnId, rowId } = await refundedStatement(db, orderId, itemIds[0]!);
      const items =
        shape === 'zero'
          ? [{ itemId: rowId, amount: 0 }]
          : shape === 'cents'
            ? [{ itemId: rowId, amount: 1.234 }]
            : shape === 'twice'
              ? [
                  { itemId: rowId, amount: 1 },
                  { itemId: rowId, amount: 1 },
                ]
              : shape;
      return receivedAs(db, asRoot(), returnId, items);
    });

    expect(out).toMatchObject(refused('MONEY_RECEIVED_INVALID'));
  });

  it('refuses no way or no note, a day of the future or before the statement, and a statement that is not there', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, itemIds } = await sentOrder(db);
      const { returnId, rowId } = await refundedStatement(db, orderId, itemIds[0]!);
      const items = [{ itemId: rowId, amount: 5 }];
      return {
        noWay: await receivedAs(db, asRoot(), returnId, items, { method: null }),
        blank: await receivedAs(db, asRoot(), returnId, items, { note: '   ' }),
        future: await receivedAs(db, asRoot(), returnId, items, { at: '2999-01-01 00:00:00' }),
        before: await receivedAs(db, asRoot(), returnId, items, { at: '2000-01-01 00:00:00' }),
        none: await receivedAs(db, asRoot(), 2_147_483_000, items),
      };
    });

    expect(out.noWay).toMatchObject(refused('MONEY_RECEIVED_NOTE_REQUIRED'));
    expect(out.blank).toMatchObject(refused('MONEY_RECEIVED_NOTE_REQUIRED'));
    expect(out.future).toMatchObject(refused('MONEY_RECEIVED_AT_INVALID'));
    expect(out.before).toMatchObject(refused('MONEY_RECEIVED_AT_INVALID'));
    expect(out.none).toMatchObject(refused('MONEY_RECEIVED_NOT_FOUND'));
  });

  it('is for root and a money admin: an admin without the right and the system are refused', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, itemIds } = await sentOrder(db);
      const { returnId, rowId } = await refundedStatement(db, orderId, itemIds[0]!);
      const items = [{ itemId: rowId, amount: 5 }];
      const byAdmin = await receivedAs(db, { role: 'ADMIN', userId: admin.id }, returnId, items);
      const bySystem = await receivedAs(db, SYSTEM, returnId, items);
      return { admin: byAdmin, system: bySystem };
    });

    expect(out.admin).toMatchObject(refused('MONEY_RECEIVED_FORBIDDEN'));
    expect(out.system).toMatchObject(refused('MONEY_RECEIVED_FORBIDDEN'));
  });
});

describe('record_carrier_money', () => {
  it('writes what a carrier paid for a parcel of the order as money of the shop', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, sendId } = await sentOrder(db);
      const paid = await carrierAs(db, asRoot(), sendId, 12.5);
      return {
        orderId,
        sendId,
        paid,
        lines: await linesWhere(db, admin.id, `"orderShipmentId" = $1`, sendId),
      };
    });

    expect(out.paid.ok && out.paid.rows[0]!.result).toMatchObject({
      orderId: out.orderId,
      shipmentId: out.sendId,
      amount: '12.50',
    });
    expect(out.lines).toEqual([
      expect.objectContaining({
        event: 'money.received',
        purpose: 'shipping',
        part: 'whole',
        amount: '12.50',
        returnId: null,
        actorId: root.id,
      }),
    ]);
  });

  it('refuses a parcel that is not there, a sum of nothing, a day of the future, and an admin without the right', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { sendId } = await sentOrder(db);
      return {
        none: await carrierAs(db, asRoot(), 2_147_483_000, 5),
        zero: await carrierAs(db, asRoot(), sendId, 0),
        cents: await carrierAs(db, asRoot(), sendId, 1.234),
        future: await carrierAs(db, asRoot(), sendId, 5, '2999-01-01 00:00:00'),
        admin: await carrierAs(db, { role: 'ADMIN', userId: admin.id }, sendId, 5),
      };
    });

    expect(out.none).toMatchObject(refused('MONEY_RECEIVED_NOT_FOUND'));
    expect(out.zero).toMatchObject(refused('MONEY_RECEIVED_INVALID'));
    expect(out.cents).toMatchObject(refused('MONEY_RECEIVED_INVALID'));
    expect(out.future).toMatchObject(refused('MONEY_RECEIVED_AT_INVALID'));
    expect(out.admin).toMatchObject(refused('MONEY_RECEIVED_FORBIDDEN'));
  });
});
