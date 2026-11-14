import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import {
  answerOf,
  begun,
  call,
  DECIDE_USE,
  handRefundOf,
  itemIdsOf,
  linesWhere,
  newDisputeId,
  rowsOf,
  settledOf,
  statementOf,
  synced,
  SYSTEM,
  withdrawal,
} from '../../helpers/dbMoney.js';
import { paidOrderOf, stockOf, type DeliveryRule, type Items } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { giveMoneyRight } from '../../helpers/moneyManager.js';

// Money already with the buyer for goods no statement takes. All in transactions that roll back.
//
// receive_return_items
//   A row whose item money already with the buyer pays (a share of a refund made by hand or of what
//   a bank took, money_share_left above 0) is as a row whose money went ahead of the goods: it is
//   not refused (RETURN_ITEM_MONEY_SETTLED); the shop takes the goods in or writes them off, and the
//   money already there pays the row at the transfer.
//
// cartlify.record_overpaid_received(p_order_id, p_amount, p_method, p_note, p_at)
//   Root or an admin with the right of the money (MONEY_RECEIVED_FORBIDDEN otherwise, the system
//   too) records money the buyer gave back outside the app of what is overpaid
//   (order_money_overpaid): a sum to the cent above 0 (MONEY_RECEIVED_INVALID), never more than is
//   overpaid (MONEY_RECEIVED_EXCEEDS), the way and a note (MONEY_RECEIVED_NOTE_REQUIRED), the day it
//   came (MONEY_RECEIVED_AT_INVALID), an order that is there (MONEY_RECEIVED_NOT_FOUND). One line
//   money.received a share it pays back: the purpose of the line of the share, whole, naming it
//   (coversId), the item or the delivery in meta; the shares of the items first, by their ids, the
//   earliest line first, then the delivery. The answer is { orderId, amount, overpaid }.
//
// cartlify.lose_overpaid(p_order_id)
//   The same people (MONEY_OVERPAID_FORBIDDEN) give what is overpaid up: a line money.share_moved a
//   share, of 0, naming it, the item or the delivery and the sum in meta, moneyUse compensation for
//   money given back by hand, loss for what a bank took. MONEY_OVERPAID_NONE when nothing is
//   overpaid, MONEY_OVERPAID_NOT_FOUND for an order that is not there. { orderId, moved }.
//
// cartlify.keep_return_goods(p_return_id, p_items)
//   The same people (RETURN_FORBIDDEN) keep goods the shop did not accept that are still in the shop
//   when money already with the buyer is on their item: p_items, a list of { itemId, goods } with
//   goods to_stock or written_off (RETURN_KEEP_INVALID); each a row not accepted, not sent back, of
//   an item with a share left (RETURN_KEEP_NOT_ALLOWED). The goods come back as at the parcel, the
//   row owes its money again (the statement opens again), and the shares pay the rows they cover all
//   of at once; what they do not cover goes by the usual transfer. RETURN_NOT_FOUND for a statement
//   that is not there. { returnId, orderId, covered: [{ returnId, itemIds }] }.

let buyer: TestUser;
let admin: TestUser;
let cashier: TestUser;
let root: TestUser;
let lamp: TestProduct;
let book: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  cashier = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  await giveMoneyRight(root.id, cashier.id);
  lamp = await createProduct({ price: 10, stock: 400 });
  book = await createProduct({ price: 15, stock: 400 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, cashier.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });
const asCashier = (): Actor => ({ role: 'ADMIN', userId: cashier.id });
const asAdmin = (db: DbSession) => db.as({ role: 'ADMIN', userId: admin.id });

const refused = (code: string) => ({ ok: false, message: expect.stringContaining(code) });

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
  const [lampItem, bookItem] = await itemIdsOf(db, admin.id, orderId);
  return { orderId, paymentId: `pi_db_${orderId}`, lampItem: lampItem!, bookItem: bookItem! };
}

// a statement of an admin for the items named, each whole, its goods not in yet
async function statementFor(db: DbSession, orderId: number, itemIds: number[]) {
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
  return made!.id;
}

// the goods of every row of a statement come in with the result given
async function receiveAll(db: DbSession, returnId: number, goods: string) {
  const rows = await rowsOf(db, admin.id, returnId);
  await asAdmin(db);
  const results = [];
  for (const row of rows) {
    const [one] = await db.rows<{ quantity: number }>(
      'select quantity from cartlify.return_items where id = $1',
      row.id,
    );
    results.push({
      itemId: row.id,
      quantity: one!.quantity,
      goods,
      ...(goods === 'not_accepted' ? { notAcceptedReason: 'used' } : {}),
    });
  }
  return db.attempt(
    `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
    returnId,
    JSON.stringify(results),
  );
}

async function received(db: DbSession, returnId: number, goods: string) {
  const outcome = await receiveAll(db, returnId, goods);
  if (!outcome.ok) throw new Error(`receive_return_items refused: ${outcome.message}`);
}

// root says what a line was for
async function decided(db: DbSession, lineId: number, items: unknown[], delivery = 0) {
  await answerOf(
    db,
    asRoot(),
    DECIDE_USE,
    lineId,
    JSON.stringify(items),
    delivery,
    'For the goods.',
  );
}

const OVERPAID = 'select cartlify.order_money_overpaid($1::int)::text as result';
const overpaidOf = async (db: DbSession, orderId: number) =>
  (await answerOf(db, asRoot(), OVERPAID, orderId)) as unknown as string;

const RECEIVED = `select cartlify.record_overpaid_received(
  $1::int, $2::numeric, $3::cartlify."OutsideMethod", $4,
  coalesce($5::timestamp, (now() at time zone 'UTC')::timestamp(3))
) as result`;
const receivedOf = (
  db: DbSession,
  orderId: number,
  amount: number,
  actor: Actor = asCashier(),
  fields: { method?: string | null; note?: string; at?: string | null } = {},
) =>
  call<{ result: Record<string, unknown> }>(
    db,
    actor,
    RECEIVED,
    orderId,
    amount,
    fields.method === undefined ? 'bank_transfer' : fields.method,
    fields.note ?? 'The buyer paid it back by a bank transfer.',
    fields.at ?? null,
  );

const LOSE = 'select cartlify.lose_overpaid($1::int) as result';
const loseOf = (db: DbSession, orderId: number, actor: Actor = asCashier()) =>
  call<{ result: Record<string, unknown> }>(db, actor, LOSE, orderId);

const KEEP = 'select cartlify.keep_return_goods($1::int, $2::jsonb) as result';
const keepOf = (db: DbSession, returnId: number, items: unknown, actor: Actor = asCashier()) =>
  call<{ result: Record<string, unknown> }>(db, actor, KEEP, returnId, JSON.stringify(items));

const resultOf = (outcome: Awaited<ReturnType<typeof keepOf>>) => {
  if (!outcome.ok) throw new Error(`refused: ${outcome.message}`);
  return outcome.rows[0]!.result;
};

// the book came back used and the shop did not accept it; then 15 went back by hand and root gave
// it to the book: 15 overpaid
async function overpaidBook(db: DbSession) {
  const order = await sentOrder(db);
  const returnId = await statementFor(db, order.orderId, [order.bookItem]);
  await received(db, returnId, 'not_accepted');
  const hand = await handRefundOf(db, order.paymentId, 15);
  await decided(db, hand.id, [{ orderItemId: order.bookItem, quantity: 1, amount: 15 }]);
  const [row] = await rowsOf(db, admin.id, returnId);
  return { ...order, returnId, hand, rowId: row!.id };
}

describe('a row money already with the buyer pays, at its parcel', () => {
  it('is not refused: the shop writes the goods off, and the money already there pays the row', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, lampItem } = await sentOrder(db);
      const hand = await handRefundOf(db, paymentId, 20);
      await decided(db, hand.id, [{ orderItemId: lampItem, quantity: 2, amount: 20 }]);
      const returnId = await statementFor(db, orderId, [lampItem]);
      const refusal = await receiveAll(db, returnId, 'not_accepted');
      const before = await stockOf(db, admin.id, lamp.variantId);
      await received(db, returnId, 'written_off');
      const after = await stockOf(db, admin.id, lamp.variantId);
      await begun(db, admin.id, returnId);
      return { refusal, before, after, statement: await statementOf(db, admin.id, returnId) };
    });

    expect(out.refusal).toMatchObject(refused('RETURN_ITEM_MONEY_SETTLED'));
    // written off: in and out at once
    expect(out.after).toEqual(out.before);
    expect(out.statement).toEqual({ refundedTotal: '20.00', closed: true });
  });

  it('is not refused while the money there pays part of it either', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, lampItem } = await sentOrder(db);
      const hand = await handRefundOf(db, paymentId, 7);
      await decided(db, hand.id, [{ orderItemId: lampItem, quantity: 1, amount: 7 }]);
      const returnId = await statementFor(db, orderId, [lampItem]);
      return receiveAll(db, returnId, 'not_accepted');
    });

    expect(out).toMatchObject(refused('RETURN_ITEM_MONEY_SETTLED'));
  });

  it('is refused as before when no money of the buyer is on its item', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, lampItem, bookItem } = await sentOrder(db);
      const hand = await handRefundOf(db, paymentId, 15);
      await decided(db, hand.id, [{ orderItemId: bookItem, quantity: 1, amount: 15 }]);
      const returnId = await statementFor(db, orderId, [lampItem]);
      const outcome = await receiveAll(db, returnId, 'not_accepted');
      return { outcome, rows: await rowsOf(db, admin.id, returnId) };
    });

    expect(out.outcome.ok).toBe(true);
    expect(out.rows.map((row) => row.money)).toEqual(['refused']);
  });
});

describe('record_overpaid_received', () => {
  it('takes money the buyer gave back of what no statement took: a line that names the share, less overpaid', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, hand, bookItem } = await overpaidBook(db);
      const before = await overpaidOf(db, orderId);
      const answer = resultOf(await receivedOf(db, orderId, 10));
      return {
        hand,
        bookItem,
        before,
        answer,
        orderId,
        after: await overpaidOf(db, orderId),
        lines: await linesWhere(
          db,
          admin.id,
          `"orderId" = $1 and event = 'money.received'`,
          orderId,
        ),
      };
    });

    expect(out.before).toBe('15.00');
    expect(out.answer).toEqual({ orderId: out.orderId, amount: '10.00', overpaid: '5.00' });
    expect(out.after).toBe('5.00');
    expect(out.lines).toEqual([
      expect.objectContaining({
        purpose: 'hand',
        part: 'whole',
        amount: '10.00',
        coversId: out.hand.id,
        returnId: null,
        actorId: cashier.id,
        meta: [{ orderItemId: out.bookItem, variantId: book.variantId, amount: 10 }],
      }),
    ]);
  });

  it('never more than is overpaid (MONEY_RECEIVED_EXCEEDS)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId } = await overpaidBook(db);
      return {
        more: await receivedOf(db, orderId, 15.01),
        all: await receivedOf(db, orderId, 15),
        again: await receivedOf(db, orderId, 0.01),
        left: await overpaidOf(db, orderId),
      };
    });

    expect(out.more).toMatchObject(refused('MONEY_RECEIVED_EXCEEDS'));
    expect(out.all.ok).toBe(true);
    expect(out.again).toMatchObject(refused('MONEY_RECEIVED_EXCEEDS'));
    expect(out.left).toBe('0.00');
  });

  it('pays back the shares of the items first, then the delivery, a line each', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, lampItem, bookItem } = await sentOrder(db);
      const returnId = await statementFor(db, orderId, [lampItem, bookItem]);
      await received(db, returnId, 'not_accepted');
      const hand = await handRefundOf(db, paymentId, 20);
      await decided(db, hand.id, [{ orderItemId: bookItem, quantity: 1, amount: 15 }], 5);
      const before = await overpaidOf(db, orderId);
      await receivedOf(db, orderId, 20);
      return {
        bookItem,
        before,
        after: await overpaidOf(db, orderId),
        lines: await linesWhere(
          db,
          admin.id,
          `"orderId" = $1 and event = 'money.received'`,
          orderId,
        ),
      };
    });

    expect(out.before).toBe('20.00');
    expect(out.after).toBe('0.00');
    expect(out.lines.map((line) => [line.amount, line.meta])).toEqual([
      ['15.00', [{ orderItemId: out.bookItem, variantId: book.variantId, amount: 15 }]],
      ['5.00', [{ delivery: 5 }]],
    ]);
  });

  it('refuses a sum not to the cent or not above 0, no way or note, a day to come, an order that is not there', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId } = await overpaidBook(db);
      return {
        zero: await receivedOf(db, orderId, 0),
        below: await receivedOf(db, orderId, -1),
        cents: await receivedOf(db, orderId, 1.234),
        noWay: await receivedOf(db, orderId, 1, asCashier(), { method: null }),
        noNote: await receivedOf(db, orderId, 1, asCashier(), { note: '  ' }),
        later: await receivedOf(db, orderId, 1, asCashier(), { at: '2999-01-01 00:00:00' }),
        none: await receivedOf(db, 2_147_483_000, 1),
      };
    });

    expect(out.zero).toMatchObject(refused('MONEY_RECEIVED_INVALID'));
    expect(out.below).toMatchObject(refused('MONEY_RECEIVED_INVALID'));
    expect(out.cents).toMatchObject(refused('MONEY_RECEIVED_INVALID'));
    expect(out.noWay).toMatchObject(refused('MONEY_RECEIVED_NOTE_REQUIRED'));
    expect(out.noNote).toMatchObject(refused('MONEY_RECEIVED_NOTE_REQUIRED'));
    expect(out.later).toMatchObject(refused('MONEY_RECEIVED_AT_INVALID'));
    expect(out.none).toMatchObject(refused('MONEY_RECEIVED_NOT_FOUND'));
  });

  it('is for root and an admin with the right of the money', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId } = await overpaidBook(db);
      return {
        admin: await receivedOf(db, orderId, 1, { role: 'ADMIN', userId: admin.id }),
        buyer: await receivedOf(db, orderId, 1, { role: 'USER', userId: buyer.id }),
        system: await receivedOf(db, orderId, 1, SYSTEM),
        root: await receivedOf(db, orderId, 1, asRoot()),
      };
    });

    expect(out.admin).toMatchObject(refused('MONEY_RECEIVED_FORBIDDEN'));
    expect(out.buyer).toMatchObject(refused('MONEY_RECEIVED_FORBIDDEN'));
    expect(out.system).toMatchObject(refused('MONEY_RECEIVED_FORBIDDEN'));
    expect(out.root.ok).toBe(true);
  });
});

describe('lose_overpaid', () => {
  it('gives what no statement took of a refund made by hand up as a compensation: nothing overpaid', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, hand, bookItem } = await overpaidBook(db);
      const answer = resultOf(await loseOf(db, orderId));
      return {
        orderId,
        hand,
        bookItem,
        answer,
        after: await overpaidOf(db, orderId),
        lines: await linesWhere(
          db,
          admin.id,
          `"orderId" = $1 and event = 'money.share_moved'`,
          orderId,
        ),
      };
    });

    expect(out.answer).toEqual({ orderId: out.orderId, moved: '15.00' });
    expect(out.after).toBe('0.00');
    expect(out.lines).toEqual([
      expect.objectContaining({
        purpose: 'hand',
        part: 'whole',
        amount: '0.00',
        moneyUse: 'compensation',
        coversId: out.hand.id,
        returnId: null,
        actorId: cashier.id,
        meta: [{ orderItemId: out.bookItem, variantId: book.variantId, amount: 15 }],
      }),
    ]);
  });

  it('gives up only what is left once the buyer gave part of it back', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId } = await overpaidBook(db);
      await receivedOf(db, orderId, 10);
      return resultOf(await loseOf(db, orderId));
    });

    expect(out).toMatchObject({ moved: '5.00' });
  });

  it('gives what a bank took up as a loss', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, bookItem } = await sentOrder(db);
      const returnId = await statementFor(db, orderId, [bookItem]);
      await received(db, returnId, 'not_accepted');
      await synced(db, {
        stripeId: newDisputeId(),
        paymentId,
        status: 'lost',
        transactions: [withdrawal(15)],
      });
      const [bank] = await linesWhere(
        db,
        admin.id,
        `"paymentId" = $1 and event = 'money.dispute_withdrawn'`,
        paymentId,
      );
      await decided(db, bank!.id, [{ orderItemId: bookItem, quantity: 1, amount: 15 }]);
      await loseOf(db, orderId);
      return linesWhere(db, admin.id, `"orderId" = $1 and event = 'money.share_moved'`, orderId);
    });

    expect(out).toEqual([
      expect.objectContaining({ purpose: 'dispute', moneyUse: 'loss', amount: '0.00' }),
    ]);
  });

  it('refuses when nothing is overpaid, an order that is not there, and anyone but root and an admin with the right', async () => {
    const out = await inRolledBackTx(async (db) => {
      const fresh = await sentOrder(db);
      const { orderId } = await overpaidBook(db);
      return {
        none: await loseOf(db, fresh.orderId),
        missing: await loseOf(db, 2_147_483_000),
        admin: await loseOf(db, orderId, { role: 'ADMIN', userId: admin.id }),
        system: await loseOf(db, orderId, SYSTEM),
        root: await loseOf(db, orderId, asRoot()),
      };
    });

    expect(out.none).toMatchObject(refused('MONEY_OVERPAID_NONE'));
    expect(out.missing).toMatchObject(refused('MONEY_OVERPAID_NOT_FOUND'));
    expect(out.admin).toMatchObject(refused('MONEY_OVERPAID_FORBIDDEN'));
    expect(out.system).toMatchObject(refused('MONEY_OVERPAID_FORBIDDEN'));
    expect(out.root.ok).toBe(true);
  });
});

describe('keep_return_goods', () => {
  it('takes goods not accepted back on the shelf: the money already there pays the row, the statement is over again', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, returnId, rowId } = await overpaidBook(db);
      const before = await stockOf(db, admin.id, book.variantId);
      const answer = resultOf(await keepOf(db, returnId, [{ itemId: rowId, goods: 'to_stock' }]));
      return {
        orderId,
        returnId,
        answer,
        before,
        after: await stockOf(db, admin.id, book.variantId),
        rows: await rowsOf(db, admin.id, returnId),
        statement: await statementOf(db, admin.id, returnId),
        overpaid: await overpaidOf(db, orderId),
      };
    });

    expect(out.answer).toEqual({
      returnId: out.returnId,
      orderId: out.orderId,
      covered: [{ returnId: out.returnId, itemIds: [out.rows[0]!.id] }],
    });
    expect(out.after!.stock).toBe(out.before!.stock + 1);
    expect(out.rows.map((row) => row.money)).toEqual(['refunded']);
    expect(out.statement).toEqual({ refundedTotal: '15.00', closed: true });
    expect(out.overpaid).toBe('0.00');
  });

  it('writes the goods off: in and out at once, the money there pays the row', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rowId } = await overpaidBook(db);
      const before = await stockOf(db, admin.id, book.variantId);
      await keepOf(db, returnId, [{ itemId: rowId, goods: 'written_off' }]);
      return {
        before,
        after: await stockOf(db, admin.id, book.variantId),
        statement: await statementOf(db, admin.id, returnId),
      };
    });

    expect(out.after).toEqual(out.before);
    expect(out.statement).toEqual({ refundedTotal: '15.00', closed: true });
  });

  it('with part of the price there, the statement waits for the rest, which goes by the usual transfer', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, bookItem } = await sentOrder(db);
      const returnId = await statementFor(db, orderId, [bookItem]);
      await received(db, returnId, 'not_accepted');
      const hand = await handRefundOf(db, paymentId, 10);
      await decided(db, hand.id, [{ orderItemId: bookItem, quantity: 1, amount: 10 }]);
      const [row] = await rowsOf(db, admin.id, returnId);
      const answer = resultOf(
        await keepOf(db, returnId, [{ itemId: row!.id, goods: 'written_off' }]),
      );
      const waiting = await statementOf(db, admin.id, returnId);
      const transfer = await begun(db, admin.id, returnId);
      await settledOf(db, transfer.key as string, `re_keep_${returnId}`, 'succeeded');
      return { answer, waiting, after: await statementOf(db, admin.id, returnId) };
    });

    expect(out.answer).toMatchObject({ covered: [] });
    expect(out.waiting).toEqual({ refundedTotal: '0.00', closed: false });
    expect(out.after).toEqual({ refundedTotal: '15.00', closed: true });
  });

  it('refuses a row that was not refused, goods sent back, an item no money of the buyer is on, and other goods', async () => {
    const out = await inRolledBackTx(async (db) => {
      const kept = await overpaidBook(db);
      const stocked = await sentOrder(db);
      const stockedReturn = await statementFor(db, stocked.orderId, [stocked.lampItem]);
      await received(db, stockedReturn, 'to_stock');
      const [stockedRow] = await rowsOf(db, admin.id, stockedReturn);

      const plain = await sentOrder(db);
      const plainReturn = await statementFor(db, plain.orderId, [plain.lampItem]);
      await received(db, plainReturn, 'not_accepted');
      const [plainRow] = await rowsOf(db, admin.id, plainReturn);

      const sent = await overpaidBook(db);
      await asAdmin(db);
      const back = await db.attempt(
        `select cartlify.send_return_goods_back(
           $1::int, $2::jsonb, 'DHL', 'JD0146000999', null, null,
           (now() at time zone 'UTC')::timestamp(3)
         ) as id`,
        sent.returnId,
        JSON.stringify([{ itemId: sent.rowId, quantity: 1 }]),
      );
      if (!back.ok) throw new Error(`send_return_goods_back refused: ${back.message}`);

      return {
        notRefused: await keepOf(db, stockedReturn, [
          { itemId: stockedRow!.id, goods: 'written_off' },
        ]),
        noShare: await keepOf(db, plainReturn, [{ itemId: plainRow!.id, goods: 'to_stock' }]),
        sentBack: await keepOf(db, sent.returnId, [{ itemId: sent.rowId, goods: 'to_stock' }]),
        lost: await keepOf(db, kept.returnId, [{ itemId: kept.rowId, goods: 'lost' }]),
        empty: await keepOf(db, kept.returnId, []),
        missing: await keepOf(db, 2_147_483_000, [{ itemId: kept.rowId, goods: 'to_stock' }]),
      };
    });

    expect(out.notRefused).toMatchObject(refused('RETURN_KEEP_NOT_ALLOWED'));
    expect(out.noShare).toMatchObject(refused('RETURN_KEEP_NOT_ALLOWED'));
    expect(out.sentBack).toMatchObject(refused('RETURN_KEEP_NOT_ALLOWED'));
    expect(out.lost).toMatchObject(refused('RETURN_KEEP_INVALID'));
    expect(out.empty).toMatchObject(refused('RETURN_KEEP_INVALID'));
    expect(out.missing).toMatchObject(refused('RETURN_NOT_FOUND'));
  });

  it('is for root and an admin with the right of the money', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { returnId, rowId } = await overpaidBook(db);
      const items = [{ itemId: rowId, goods: 'to_stock' }];
      return {
        admin: await keepOf(db, returnId, items, { role: 'ADMIN', userId: admin.id }),
        system: await keepOf(db, returnId, items, SYSTEM),
        root: await keepOf(db, returnId, items, asRoot()),
      };
    });

    expect(out.admin).toMatchObject(refused('RETURN_FORBIDDEN'));
    expect(out.system).toMatchObject(refused('RETURN_FORBIDDEN'));
    expect(out.root.ok).toBe(true);
  });
});
