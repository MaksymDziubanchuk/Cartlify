import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { paidOrderOf, type DeliveryRule, type Items } from '../../helpers/dbOrders.js';
import { begun, call, handRefundOf, itemIdsOf, rowsOf, settledOf } from '../../helpers/dbMoney.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// What a statement still owes and what money already with the buyer gave more than the shop owed
// (the hints of the card of a statement and the alerts of root). All in
// transactions that roll back.
//
// cartlify.return_money_left(p_return_id integer)
//   Admin and root (RETURN_FORBIDDEN otherwise); null for a statement that is not there. What the
//   statement still owes the buyer: the rows whose money is owed (never sent, or whose transfer
//   failed; a row refused owes nothing), the delivery that goes with them and the way back the shop
//   pays; of it, what is due now (the rows whose goods are in, lost, or on their way with the parcel
//   confirmed, with their delivery), what the money already with the buyer would cover of that
//   (cover_return_rows, counted only), and what is left of the payment at the provider. short: what
//   a transfer of the rows due and the way back would ask the provider is more than is left of the
//   payment. { rows, delivery, wayBack, total, due, covered, paymentLeft } in text with two
//   decimals, short a boolean.
//
// cartlify.order_money_overpaid(p_order_id integer)
//   Admin and root (RETURN_FORBIDDEN). What the shares of money already with the buyer (a refund made
//   by hand, what a bank took, by the decisions on them) have left for the items whose every unit
//   came back in statements that are all over, with the delivery when every item is so: money the
//   buyer had for goods no statement owes any more (a row lowered or refused). 0 when none.

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let lamp: TestProduct;
let book: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  lamp = await createProduct({ price: 10, stock: 400 });
  book = await createProduct({ price: 15, stock: 400 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });
const asAdmin = (db: DbSession) => db.as({ role: 'ADMIN', userId: admin.id });

// two lamps at 10, a book at 15, a delivery of 5: an order of 40, sent
const DELIVERY: DeliveryRule = { flat: 5, freeFrom: null, expected: 5 };

async function sentOrder(db: DbSession) {
  const items: Items = [
    [lamp.variantId, 2],
    [book.variantId, 1],
  ];
  const orderId = await paidOrderOf(db, buyer.id, admin.id, items, DELIVERY);
  await asAdmin(db);
  await db.rows(
    `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
    orderId,
  );
  return {
    orderId,
    paymentId: `pi_db_${orderId}`,
    itemIds: await itemIdsOf(db, admin.id, orderId),
  };
}

// a statement of an admin for the items named, each whole; their goods in when said
async function statementOf(db: DbSession, orderId: number, itemIds: number[], goodsIn = true) {
  await asAdmin(db);
  const [made] = await db.rows<{ id: number }>(
    `select cartlify.create_return(
       $1::int,
       (select jsonb_agg(jsonb_build_object('orderItemId', i.id, 'quantity', i.quantity) order by i.id)
        from cartlify.order_items as i where i.id = any($2::int[])),
       'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
       'defect'::cartlify."ReturnReason", null, 'Test Buyer', 'buyer@example.com', null, null, 4,
       'Europe/Madrid'
     ) as id`,
    orderId,
    itemIds,
  );
  if (goodsIn) {
    const rows = await rowsOf(db, admin.id, made!.id);
    await asAdmin(db);
    const results = [];
    for (const row of rows) {
      const [one] = await db.rows<{ quantity: number }>(
        'select quantity from cartlify.return_items where id = $1',
        row.id,
      );
      results.push({ itemId: row.id, quantity: one!.quantity, goods: 'to_stock' });
    }
    await db.rows(
      `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
      made!.id,
      JSON.stringify(results),
    );
  }
  return made!.id;
}

const LEFT = 'select cartlify.return_money_left($1::int) as result';
const OVERPAID = 'select cartlify.order_money_overpaid($1::int)::text as result';
const DECIDE = `select cartlify.decide_money_use($1::int, $2::jsonb, 0, 'For the goods.') as result`;

const leftOf = async (db: DbSession, returnId: number, actor: Actor = asRoot()) => {
  const outcome = await call<{ result: Record<string, unknown> }>(db, actor, LEFT, returnId);
  if (!outcome.ok) throw new Error(outcome.message ?? 'refused');
  return outcome.rows[0]!.result;
};

const overpaidOf = async (db: DbSession, orderId: number) => {
  const outcome = await call<{ result: string }>(db, asRoot(), OVERPAID, orderId);
  if (!outcome.ok) throw new Error(outcome.message ?? 'refused');
  return outcome.rows[0]!.result;
};

describe('return_money_left', () => {
  it('tells the rows owed with the delivery that goes with them, what is due, and what is left of the payment', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, itemIds } = await sentOrder(db);
      const all = await statementOf(db, orderId, itemIds);
      return leftOf(db, all);
    });

    // the whole order came back: the delivery goes with the last row
    expect(out).toEqual({
      rows: '35.00',
      delivery: '5.00',
      wayBack: '0.00',
      total: '40.00',
      due: '40.00',
      covered: '0.00',
      paymentLeft: '40.00',
      short: false,
    });
  });

  it('counts as due only the rows whose goods are in, and nothing once the money is sent', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, itemIds } = await sentOrder(db);
      const waiting = await statementOf(db, orderId, [itemIds[0]!], false);
      const before = await leftOf(db, waiting);
      const returnId = await statementOf(db, orderId, [itemIds[1]!]);
      const transfer = await begun(db, admin.id, returnId);
      await settledOf(db, transfer.key as string, `re_left_${returnId}`, 'succeeded');
      return { before, after: await leftOf(db, returnId) };
    });

    expect(out.before).toMatchObject({ rows: '20.00', total: '20.00', due: '0.00', short: false });
    expect(out.after).toMatchObject({ rows: '0.00', total: '0.00', due: '0.00', short: false });
  });

  it('counts what the money already with the buyer covers, and tells a transfer the payment cannot hold', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await sentOrder(db);
      // 30 went back by hand: 10 of it for a lamp, the rest a gesture
      const hand = await handRefundOf(db, paymentId, 30);
      await call(
        db,
        asRoot(),
        DECIDE,
        hand.id,
        JSON.stringify([{ orderItemId: itemIds[0], quantity: 1, amount: 10 }]),
      );
      const returnId = await statementOf(db, orderId, [itemIds[0]!, itemIds[1]!]);
      return leftOf(db, returnId);
    });

    // the lamps and the book, 35, with the delivery 40; 10 covered; Stripe would be asked for 30 of
    // the 10 left of the payment
    expect(out).toMatchObject({
      total: '40.00',
      due: '40.00',
      covered: '10.00',
      paymentLeft: '10.00',
      short: true,
    });
  });

  it('is for the admins: a buyer is refused, a statement not there is null', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, itemIds } = await sentOrder(db);
      const returnId = await statementOf(db, orderId, itemIds);
      return {
        buyer: await call(db, { role: 'USER', userId: buyer.id }, LEFT, returnId),
        none: await leftOf(db, 2_147_483_000),
      };
    });

    expect(out.buyer).toMatchObject({
      ok: false,
      message: expect.stringContaining('RETURN_FORBIDDEN'),
    });
    expect(out.none).toBeNull();
  });
});

describe('order_money_overpaid', () => {
  it('is 0 while the money already with the buyer pays the goods that came back', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await sentOrder(db);
      const hand = await handRefundOf(db, paymentId, 15);
      await call(
        db,
        asRoot(),
        DECIDE,
        hand.id,
        JSON.stringify([{ orderItemId: itemIds[1], quantity: 1, amount: 15 }]),
      );
      const before = await overpaidOf(db, orderId);
      // the book came back: the refund pays it at once
      await statementOf(db, orderId, [itemIds[1]!]);
      const transfer = await begun(db, admin.id, (await lastStatement(db, orderId))!);
      return { before, transfer, after: await overpaidOf(db, orderId) };
    });

    expect(out.before).toBe('0.00');
    expect(out.after).toBe('0.00');
  });

  it('tells the share no statement took once every unit of the item came back and its statement is over', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await sentOrder(db);
      // the book came back, but the shop did not accept it: the row owes nothing
      const returnId = await statementOf(db, orderId, [itemIds[1]!], false);
      const [row] = await rowsOf(db, admin.id, returnId);
      await asAdmin(db);
      await db.rows(
        `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
        returnId,
        JSON.stringify([
          { itemId: row!.id, quantity: 1, goods: 'not_accepted', notAcceptedReason: 'used' },
        ]),
      );
      // then 15 went back by hand and root gave it to the book: it stays with the buyer (money
      // already with the buyer is never refused at the parcel: db/moneyOverpaid.test.ts)
      const hand = await handRefundOf(db, paymentId, 15);
      await call(
        db,
        asRoot(),
        DECIDE,
        hand.id,
        JSON.stringify([{ orderItemId: itemIds[1], quantity: 1, amount: 15 }]),
      );
      return overpaidOf(db, orderId);
    });

    expect(out).toBe('15.00');
  });
});

async function lastStatement(db: DbSession, orderId: number) {
  await asAdmin(db);
  const [row] = await db.rows<{ id: number }>(
    'select id from cartlify.returns where "orderId" = $1 order by id desc limit 1',
    orderId,
  );
  return row?.id;
}
