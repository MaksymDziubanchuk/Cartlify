import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import {
  answerOf,
  handRefundOf,
  itemIdsOf,
  linesWhere,
  newDisputeId,
  rowsOf,
  statementOf,
  synced,
  SYSTEM,
  withdrawal,
} from '../../helpers/dbMoney.js';
import { paidOrderOf, type DeliveryRule, type Items } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// A line of money given back by hand or taken by a bank that is all of the payment of its order with
// no other money between the shop and the buyer on the order before it: it is shared among the items and the delivery by
// itself, whatever the order is; the money of the parcels does not count. Any other waits for root.
// All in transactions that roll back.
//
// record_hand_refund
//   The answer tells it: whole (the server shares such a refund by itself, api/payments).
//
// sync_payment_dispute
//   A lost dispute of an order sent shares such a line by itself, and the statements it pays get
//   their money at once (covered).

let buyer: TestUser;
let admin: TestUser;
let lamp: TestProduct;
let book: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  lamp = await createProduct({ price: 10, stock: 400 });
  book = await createProduct({ price: 15, stock: 400 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asAdmin = (db: DbSession) => db.as({ role: 'ADMIN', userId: admin.id });

// two lamps at 10, a book at 15, a delivery of 5: an order of 40, sent with a parcel of a cost
const DELIVERY: DeliveryRule = { flat: 5, freeFrom: null, expected: 5 };

async function sentOrder(db: DbSession, cost: number | null = 6) {
  const items: Items = [
    [lamp.variantId, 2],
    [book.variantId, 1],
  ];
  const orderId = await paidOrderOf(db, buyer.id, admin.id, items, DELIVERY);
  await asAdmin(db);
  await db.rows(
    `update cartlify.orders set status = 'shipped'::cartlify."OrderStatus" where id = $1 returning id`,
    orderId,
  );
  const [send] = await db.rows<{ id: number }>(
    `insert into cartlify.order_shipments ("orderId", carrier) values ($1::int, 'DHL') returning id`,
    orderId,
  );
  if (cost !== null) {
    await db.rows(
      `select cartlify.record_order_shipment_cost($1::int, $2::numeric) as result`,
      send!.id,
      cost,
    );
  }
  const [lampItem, bookItem] = await itemIdsOf(db, admin.id, orderId);
  return { orderId, paymentId: `pi_db_${orderId}`, lampItem: lampItem!, bookItem: bookItem! };
}

const HAND = `select cartlify.record_hand_refund(
  'stripe'::cartlify."PaymentProvider", $1, $2, $3::numeric, $4, 'eur') as result`;

const handAnswer = (db: DbSession, paymentId: string, amount: number) =>
  answerOf(db, SYSTEM, HAND, paymentId, `re_whole_${paymentId}_${amount}`, amount, 'succeeded');

// a statement of an admin for the items named, each whole, its goods in
async function statementIn(db: DbSession, orderId: number, itemIds: number[]) {
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
  return made!.id;
}

const bankLines = (db: DbSession, paymentId: string) =>
  linesWhere(db, admin.id, `"paymentId" = $1 and event = 'money.dispute_withdrawn'`, paymentId);

describe('a refund made by hand of all of the payment', () => {
  it('is whole with nothing before it but the payment and the cost of the parcel', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { paymentId } = await sentOrder(db);
      return handAnswer(db, paymentId, 40);
    });

    expect(out).toMatchObject({ created: true, whole: true });
  });

  it('is not whole for part of the payment, nor after other money of the buyer', async () => {
    const out = await inRolledBackTx(async (db) => {
      const part = await sentOrder(db);
      const after = await sentOrder(db);
      await handRefundOf(db, after.paymentId, 5);
      return {
        part: await handAnswer(db, part.paymentId, 30),
        after: await handAnswer(db, after.paymentId, 35),
      };
    });

    expect(out.part).toMatchObject({ whole: false });
    expect(out.after).toMatchObject({ whole: false });
  });
});

describe('a lost dispute of an order sent that took all of the payment', () => {
  it('is shared by itself among the items and the delivery, by their prices', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { paymentId, lampItem, bookItem } = await sentOrder(db);
      await synced(db, {
        stripeId: newDisputeId(),
        paymentId,
        status: 'lost',
        transactions: [withdrawal(40)],
      });
      return { lampItem, bookItem, lines: await bankLines(db, paymentId) };
    });

    expect(out.lines).toEqual([
      expect.objectContaining({
        moneyUse: 'goods',
        meta: [
          expect.objectContaining({ orderItemId: out.lampItem, quantity: 2, amount: 20 }),
          expect.objectContaining({ orderItemId: out.bookItem, quantity: 1, amount: 15 }),
          { delivery: 5 },
        ],
      }),
    ]);
  });

  it('pays a statement that waits for its money at once', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, bookItem } = await sentOrder(db);
      const returnId = await statementIn(db, orderId, [bookItem]);
      const answer = await synced(db, {
        stripeId: newDisputeId(),
        paymentId,
        status: 'lost',
        transactions: [withdrawal(40)],
      });
      return { returnId, answer, statement: await statementOf(db, admin.id, returnId) };
    });

    expect(out.answer).toMatchObject({
      covered: [expect.objectContaining({ returnId: out.returnId })],
    });
    expect(out.statement).toEqual({ refundedTotal: '15.00', closed: true });
  });

  it('waits for root after other money of the buyer, and for part of the payment', async () => {
    const out = await inRolledBackTx(async (db) => {
      const after = await sentOrder(db);
      await handRefundOf(db, after.paymentId, 5);
      await synced(db, {
        stripeId: newDisputeId(),
        paymentId: after.paymentId,
        status: 'lost',
        transactions: [withdrawal(35)],
      });
      const part = await sentOrder(db);
      await synced(db, {
        stripeId: newDisputeId(),
        paymentId: part.paymentId,
        status: 'lost',
        transactions: [withdrawal(30)],
      });
      return {
        after: await bankLines(db, after.paymentId),
        part: await bankLines(db, part.paymentId),
      };
    });

    expect(out.after.map((line) => line.moneyUse)).toEqual([null]);
    expect(out.part.map((line) => line.moneyUse)).toEqual([null]);
  });

  it('is whole without a cost of the parcel too', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { paymentId } = await sentOrder(db, null);
      await synced(db, {
        stripeId: newDisputeId(),
        paymentId,
        status: 'lost',
        transactions: [withdrawal(40)],
      });
      return bankLines(db, paymentId);
    });

    expect(out.map((line) => line.moneyUse)).toEqual(['goods']);
  });
});
