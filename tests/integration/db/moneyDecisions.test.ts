import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { paidOrderOf, type DeliveryRule, type Items } from '../../helpers/dbOrders.js';
import {
  DECIDE,
  SYSTEM,
  beginOf,
  begun,
  call,
  handRefundOf,
  holdsOf,
  itemIdsOf,
  lineOf,
  linesWhere,
  newDisputeId,
  reasonsOf,
  rowsOf,
  settledOf,
  statementOf,
  synced,
  withdrawal,
} from '../../helpers/dbMoney.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// What the money given back by hand in the dashboard of the provider, or taken by the bank for a
// dispute, was for: root or a money admin decides on the line itself,
// and decides again while no statement took its shares. All in transactions that roll back.
//
// cartlify.decide_money_use(p_money_log_id integer, p_items jsonb, p_delivery numeric, p_note text)
//   Root or an admin with the right of the money, with an account (MONEY_DECISION_FORBIDDEN, the
//   system too). The line is a refund made by hand (money.refund, purpose hand) or what a bank took
//   (money.dispute_withdrawn) of an order (MONEY_DECISION_NOT_FOUND otherwise), not failed and not
//   decided with shares a line took already (MONEY_DECISION_DONE); a note of 1 to 500 (MONEY_DECISION_NOTE_REQUIRED). p_items, a
//   list of { orderItemId, quantity, amount }: items of the order, units of it, a sum to the cent
//   above 0 (MONEY_DECISION_INVALID), never more than the units cost, the decisions of the order
//   together (MONEY_DECISION_EXCEEDS); p_delivery, 0 or more, not above the delivery the order paid
//   with the other decisions (the old shares of the line not counted); the items and the delivery
//   together never more than the line (MONEY_DECISION_EXCEEDS). The line keeps it in its meta: each item with the copy
//   of its price ({ orderItemId, productId, variantId, quantity, unitPrice, amount }) and the
//   delivery ({ delivery }); moneyUse says what it was: goods when all of it went to the items and
//   the delivery, else what the rest was, compensation (by hand) or loss (the bank). A hold of the
//   refund goes. The rows of the open statements of the order that wait for their money and whose
//   items the decision covers get it at once, nothing asked of the provider: a movement of the
//   parts covered (money.refund, sent, no key). The answer is { moneyLogId, orderId, use,
//   distributed, rest, covered: [{ returnId, itemIds }], previous }, previous the split it took the
//   place of ({ use, items, delivery }), null the first time.
//
// The money a statement takes as covered (begin_return_refund, mark_return_refunded_outside): for
// each row, what the decisions of the order gave its item less what the parts covered of the
// statements already used of it (a failure gives a part back); the delivery the same. Each part
// covered names its source (coversId) and the item. returns.refundedTotal is what the parts of the
// statement other than covered gave back: all the buyer has back for it.
//
// The transfers of an order wait while a refund made by hand of its payment is not decided
// (RETURN_HAND_REFUND_PENDING), and while what the bank took for a lost dispute of it is not
// (RETURN_BANK_MONEY_PENDING).

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let first: TestProduct;
let second: TestProduct;
// three items whose sums round up past a small line (33.50, 33.50, 32.99)
let rounded: TestProduct[];

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  first = await createProduct({ price: 10, stock: 400 });
  second = await createProduct({ price: 15, stock: 400 });
  rounded = [
    await createProduct({ price: 33.5, stock: 20 }),
    await createProduct({ price: 33.5, stock: 20 }),
    await createProduct({ price: 32.99, stock: 20 }),
  ];
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

// two units of the first product at 10, one of the second at 15, a delivery of 5: an order of 40
const DELIVERY: DeliveryRule = { flat: 5, freeFrom: null, expected: 5 };

type Sold = { orderId: number; paymentId: string; itemIds: number[] };

async function soldOrder(db: DbSession, shipped = true): Promise<Sold> {
  const items: Items = [
    [first.variantId, 2],
    [second.variantId, 1],
  ];
  const orderId = await paidOrderOf(db, buyer.id, admin.id, items, DELIVERY);
  if (shipped) {
    await asAdmin(db);
    await db.rows(
      `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
      orderId,
    );
  }
  return {
    orderId,
    paymentId: `pi_db_${orderId}`,
    itemIds: await itemIdsOf(db, admin.id, orderId),
  };
}

const DECIDE_USE = `select cartlify.decide_money_use($1::int, $2::jsonb, $3::numeric, $4) as result`;
const NOTE = 'The bank gave the money for the lamps';

const decideAs = (
  db: DbSession,
  actor: Actor,
  lineId: number,
  items: unknown,
  delivery: number | null = 0,
  note: string | null = NOTE,
) =>
  call<{ result: Record<string, unknown> }>(
    db,
    actor,
    DECIDE_USE,
    lineId,
    JSON.stringify(items),
    delivery,
    note,
  );

const decided = async (
  db: DbSession,
  lineId: number,
  items: unknown,
  delivery = 0,
): Promise<Record<string, unknown>> => {
  const outcome = await decideAs(db, asRoot(), lineId, items, delivery);
  if (!outcome.ok) throw new Error(`decide_money_use refused: ${outcome.message}`);
  return outcome.rows[0]!.result;
};

// a statement of an admin for the items of the order named, each whole, the goods in
async function cameBack(db: DbSession, orderId: number, itemIds: number[]): Promise<number> {
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
  await db.rows(
    `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
    made!.id,
    JSON.stringify(
      await Promise.all(
        rows.map(async (row) => {
          const [one] = await db.rows<{ quantity: number }>(
            'select quantity from cartlify.return_items where id = $1',
            row.id,
          );
          return { itemId: row.id, quantity: one!.quantity, goods: 'to_stock' };
        }),
      ),
    ),
  );
  return made!.id;
}

describe('decide_money_use', () => {
  it('shares a refund made by hand among items of the order with a copy of their price, the rest a compensation', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await soldOrder(db);
      const hand = await handRefundOf(db, paymentId, 12);
      const answer = await decided(db, hand.id, [
        { orderItemId: itemIds[0], quantity: 1, amount: 10 },
      ]);
      return { orderId, itemIds, answer, line: await lineOf(db, admin.id, hand.id) };
    });

    expect(out.answer).toMatchObject({ use: 'compensation', distributed: '10.00', rest: '2.00' });
    expect(out.line).toMatchObject({ moneyUse: 'compensation' });
    expect(out.line.meta).toEqual([
      {
        orderItemId: out.itemIds[0],
        productId: first.id,
        variantId: first.variantId,
        quantity: 1,
        unitPrice: 10,
        amount: 10,
      },
    ]);
  });

  it('is all goods when the items and the delivery take all of the line; the bank leaves a loss', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { paymentId, itemIds } = await soldOrder(db);
      const hand = await handRefundOf(db, paymentId, 20);
      const all = await decided(
        db,
        hand.id,
        [{ orderItemId: itemIds[1], quantity: 1, amount: 15 }],
        5,
      );
      await synced(db, {
        stripeId: newDisputeId(),
        paymentId,
        status: 'lost',
        transactions: [withdrawal(20)],
      });
      const [bank] = await linesWhere(
        db,
        admin.id,
        `"paymentId" = $1 and event = 'money.dispute_withdrawn'`,
        paymentId,
      );
      const loss = await decided(db, bank!.id, [
        { orderItemId: itemIds[0], quantity: 1, amount: 10 },
      ]);
      return { all, loss, bank: await lineOf(db, admin.id, bank!.id) };
    });

    expect(out.all).toMatchObject({ use: 'goods', rest: '0.00' });
    expect(out.loss).toMatchObject({ use: 'loss', distributed: '10.00', rest: '10.00' });
    expect(out.bank.meta).toEqual([
      expect.objectContaining({ quantity: 1, unitPrice: 10, amount: 10 }),
    ]);
  });

  it('lets the hold of the refund go', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await soldOrder(db, false);
      const hand = await handRefundOf(db, paymentId, 10);
      const before = reasonsOf(await holdsOf(db, admin.id, orderId));
      await decided(db, hand.id, [{ orderItemId: itemIds[0], quantity: 1, amount: 10 }]);
      return { hand, before, after: reasonsOf(await holdsOf(db, admin.id, orderId)) };
    });

    expect(out.before).toEqual([['hand_refund', out.hand.id]]);
    expect(out.after).toEqual([]);
  });

  it('is of root or a money admin, for a line of money of an order not failed', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { paymentId, itemIds } = await soldOrder(db);
      const hand = await handRefundOf(db, paymentId, 10);
      const items = [{ orderItemId: itemIds[0], quantity: 1, amount: 10 }];
      const byAdmin = await decideAs(db, { role: 'ADMIN', userId: admin.id }, hand.id, items);
      const bySystem = await decideAs(db, SYSTEM, hand.id, items);
      const [payment] = await linesWhere(
        db,
        admin.id,
        `"paymentId" = $1 and event = 'money.payment'`,
        paymentId,
      );
      const notMoney = await decideAs(db, asRoot(), payment!.id, items);
      const failing = await handRefundOf(db, paymentId, 5);
      await settledOf(db, null, failing.refundId, 'failed');
      const failed = await decideAs(db, asRoot(), failing.id, items);
      return { byAdmin, bySystem, notMoney, failed };
    });

    expect(out.byAdmin).toMatchObject(refused('MONEY_DECISION_FORBIDDEN'));
    expect(out.bySystem).toMatchObject(refused('MONEY_DECISION_FORBIDDEN'));
    expect(out.notMoney).toMatchObject(refused('MONEY_DECISION_NOT_FOUND'));
    expect(out.failed).toMatchObject(refused('MONEY_DECISION_DONE'));
  });

  it('takes no more than the line, than the units cost with the other decisions, nor items of another order', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { paymentId, itemIds } = await soldOrder(db);
      const other = await soldOrder(db);
      const a = await handRefundOf(db, paymentId, 15);
      const b = await handRefundOf(db, paymentId, 15);
      const overLine = await decideAs(
        db,
        asRoot(),
        a.id,
        [{ orderItemId: itemIds[1], quantity: 1, amount: 15 }],
        5,
      );
      const overUnits = await decideAs(db, asRoot(), a.id, [
        { orderItemId: itemIds[0], quantity: 1, amount: 10.01 },
      ]);
      const foreign = await decideAs(db, asRoot(), a.id, [
        { orderItemId: other.itemIds[0], quantity: 1, amount: 10 },
      ]);
      const shape = await decideAs(db, asRoot(), a.id, [
        { orderItemId: itemIds[0], quantity: 0, amount: 10 },
      ]);
      const noNote = await decideAs(db, asRoot(), a.id, [], 0, '  ');
      await decided(db, a.id, [{ orderItemId: itemIds[0], quantity: 1, amount: 10 }]);
      // the first item cost 20 in all: 10 are given, 10 are left
      const overTogether = await decideAs(db, asRoot(), b.id, [
        { orderItemId: itemIds[0], quantity: 2, amount: 15 },
      ]);
      return { overLine, overUnits, foreign, shape, noNote, overTogether };
    });

    expect(out.overLine).toMatchObject(refused('MONEY_DECISION_EXCEEDS'));
    expect(out.overUnits).toMatchObject(refused('MONEY_DECISION_EXCEEDS'));
    expect(out.foreign).toMatchObject(refused('MONEY_DECISION_INVALID'));
    expect(out.shape).toMatchObject(refused('MONEY_DECISION_INVALID'));
    expect(out.noNote).toMatchObject(refused('MONEY_DECISION_NOTE_REQUIRED'));
    expect(out.overTogether).toMatchObject(refused('MONEY_DECISION_EXCEEDS'));
  });

  // the bank holds the money while the dispute goes on and gives it back when the shop wins: only
  // what a lost dispute took is money the buyer has
  it('waits for the dispute to be lost before what the bank took is decided (MONEY_DECISION_DISPUTE_NOT_LOST)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { paymentId, itemIds } = await soldOrder(db);
      const stripeId = newDisputeId();
      const taken = withdrawal(10);
      await synced(db, { stripeId, paymentId, status: 'needs_response', transactions: [taken] });
      const [bank] = await linesWhere(
        db,
        admin.id,
        `"paymentId" = $1 and event = 'money.dispute_withdrawn'`,
        paymentId,
      );
      const share = [{ orderItemId: itemIds[0], quantity: 1, amount: 10 }];
      const open = await decideAs(db, asRoot(), bank!.id, share);
      await synced(db, { stripeId, paymentId, status: 'lost', transactions: [taken] });
      return { open, lost: await decideAs(db, asRoot(), bank!.id, share) };
    });

    expect(out.open).toMatchObject(refused('MONEY_DECISION_DISPUTE_NOT_LOST'));
    expect(out.lost.ok).toBe(true);
  });
});

// a decision is redone while no statement took its shares:
// the new split takes the place of the old one, which the answer gives back for the journal of the
// admins
describe('a decision redone', () => {
  it('takes the place of the old split while no statement took its shares, its own shares counted out', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { paymentId, itemIds } = await soldOrder(db);
      const hand = await handRefundOf(db, paymentId, 15);
      const once = await decided(db, hand.id, [
        { orderItemId: itemIds[1], quantity: 1, amount: 15 },
      ]);
      // the same item at its full price again: the old shares of this line are not the others'
      const same = await decided(db, hand.id, [
        { orderItemId: itemIds[1], quantity: 1, amount: 15 },
      ]);
      const redone = await decided(db, hand.id, [
        { orderItemId: itemIds[0], quantity: 1, amount: 10 },
      ]);
      return { itemIds, once, same, redone, line: await lineOf(db, admin.id, hand.id) };
    });

    expect(out.once).toMatchObject({ use: 'goods', previous: null });
    expect(out.same).toMatchObject({
      use: 'goods',
      previous: {
        use: 'goods',
        items: [{ orderItemId: out.itemIds[1], quantity: 1, amount: 15 }],
        delivery: 0,
      },
    });
    expect(out.redone).toMatchObject({ use: 'compensation', distributed: '10.00', rest: '5.00' });
    expect(out.line).toMatchObject({ moneyUse: 'compensation' });
    expect(out.line.meta).toEqual([
      expect.objectContaining({ orderItemId: out.itemIds[0], quantity: 1, amount: 10 }),
    ]);
  });

  it('gives the shares of the old split back to the other decisions of the order', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { paymentId, itemIds } = await soldOrder(db);
      const a = await handRefundOf(db, paymentId, 15);
      const b = await handRefundOf(db, paymentId, 15);
      const toSecond = [{ orderItemId: itemIds[1], quantity: 1, amount: 15 }];
      await decided(db, a.id, toSecond);
      const taken = await decideAs(db, asRoot(), b.id, toSecond);
      await decided(db, a.id, [{ orderItemId: itemIds[0], quantity: 1, amount: 10 }]);
      return { taken, freed: await decideAs(db, asRoot(), b.id, toSecond) };
    });

    expect(out.taken).toMatchObject(refused('MONEY_DECISION_EXCEEDS'));
    expect(out.freed.ok).toBe(true);
  });

  it('is refused once a statement took its shares (MONEY_DECISION_DONE)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await soldOrder(db);
      await cameBack(db, orderId, [itemIds[1]!]);
      const hand = await handRefundOf(db, paymentId, 15);
      await decided(db, hand.id, [{ orderItemId: itemIds[1], quantity: 1, amount: 15 }]);
      return {
        again: await decideAs(db, asRoot(), hand.id, [
          { orderItemId: itemIds[0], quantity: 1, amount: 10 },
        ]),
        line: await lineOf(db, admin.id, hand.id),
      };
    });

    expect(out.again).toMatchObject(refused('MONEY_DECISION_DONE'));
    expect(out.line.meta).toEqual([expect.objectContaining({ quantity: 1, amount: 15 })]);
  });
});

describe('the money a decision gave the items of an order', () => {
  it('gives the rows of an open statement on them their money at once, the provider asked for nothing', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await soldOrder(db);
      const returnId = await cameBack(db, orderId, [itemIds[1]!]);
      const hand = await handRefundOf(db, paymentId, 15);
      const answer = await decided(db, hand.id, [
        { orderItemId: itemIds[1], quantity: 1, amount: 15 },
      ]);
      return {
        returnId,
        hand,
        answer,
        rows: await rowsOf(db, admin.id, returnId),
        statement: await statementOf(db, admin.id, returnId),
        parts: await linesWhere(
          db,
          admin.id,
          `"returnId" = $1 and event = 'money.refund'`,
          returnId,
        ),
      };
    });

    expect(out.answer.covered).toEqual([{ returnId: out.returnId, itemIds: [out.rows[0]!.id] }]);
    expect(out.rows).toEqual([expect.objectContaining({ money: 'refunded' })]);
    expect(out.parts.map((line) => [line.part, line.amount, line.state, line.transferKey])).toEqual(
      [
        ['goods', '-15.00', 'sent', null],
        ['covered', '15.00', 'sent', null],
      ],
    );
    expect(out.parts[1]).toMatchObject({ coversId: out.hand.id });
    // the buyer has the 15 back for the statement
    expect(out.statement).toEqual({ refundedTotal: '15.00', closed: true });
  });

  it('covers a later statement when its money is sent: the provider is asked for the rest only, and never twice', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await soldOrder(db);
      const hand = await handRefundOf(db, paymentId, 10);
      await decided(db, hand.id, [{ orderItemId: itemIds[0], quantity: 1, amount: 10 }]);
      // the two units of the first item come back: the bank of the decision covers one of them
      const firstBack = await cameBack(db, orderId, [itemIds[0]!]);
      const sent = await begun(db, admin.id, firstBack);
      // the second item comes back: nothing covers it
      const secondBack = await cameBack(db, orderId, [itemIds[1]!]);
      const alone = await begun(db, admin.id, secondBack);
      return {
        sent,
        alone,
        total: await statementOf(db, admin.id, firstBack),
      };
    });

    expect(out.sent).toMatchObject({ amount: '10.00', covered: '10.00' });
    expect(out.alone).toMatchObject({ covered: '0.00' });
    expect(out.total.refundedTotal).toBe('20.00');
  });
});

describe('money given back by hand that fails after a statement took it', () => {
  const OUTSIDE = `select cartlify.mark_payment_refund_outside($1::int, $2::cartlify."OutsideMethod", $3, (now() at time zone 'UTC')::timestamp(3)) as result`;

  it('leaves the rows refunded and the statement owing it again; sent another way, the statement has it back', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await soldOrder(db);
      const returnId = await cameBack(db, orderId, [itemIds[1]!]);
      const hand = await handRefundOf(db, paymentId, 15, 'pending');
      await decided(db, hand.id, [{ orderItemId: itemIds[1], quantity: 1, amount: 15 }]);
      const covered = await statementOf(db, admin.id, returnId);
      // the bank of the card sends the refund made by hand back
      await settledOf(db, null, hand.refundId, 'failed');
      const failed = await statementOf(db, admin.id, returnId);
      const rows = await rowsOf(db, admin.id, returnId);
      const sent = await call(
        db,
        asRoot(),
        OUTSIDE,
        hand.id,
        'bank_transfer',
        'To the account of the buyer.',
      );
      return { covered, failed, rows, sent, after: await statementOf(db, admin.id, returnId) };
    });

    expect(out.covered).toEqual({ refundedTotal: '15.00', closed: true });
    expect(out.failed.refundedTotal).toBe('0.00');
    expect(out.rows).toEqual([expect.objectContaining({ money: 'refunded' })]);
    expect(out.sent.ok).toBe(true);
    expect(out.after.refundedTotal).toBe('15.00');
  });

  it('gives no share to a later statement while it is lost, and gives it again once it was sent another way', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await soldOrder(db);
      const hand = await handRefundOf(db, paymentId, 10, 'pending');
      await decided(db, hand.id, [{ orderItemId: itemIds[0], quantity: 1, amount: 10 }]);
      await settledOf(db, null, hand.refundId, 'failed');
      const lost = await cameBack(db, orderId, [itemIds[0]!]);
      const whileLost = await beginOf(db, admin.id, lost);
      return { whileLost };
    });

    expect(out.whileLost.ok).toBe(true);
    expect(out.whileLost.ok && out.whileLost.rows[0]!.result).toMatchObject({ covered: '0.00' });
  });
});

describe('the transfers of an order wait for the decision', () => {
  it('while a refund made by hand of its payment is not decided (RETURN_HAND_REFUND_PENDING)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await soldOrder(db);
      const returnId = await cameBack(db, orderId, [itemIds[1]!]);
      const hand = await handRefundOf(db, paymentId, 5);
      const waiting = await beginOf(db, admin.id, returnId);
      await decided(db, hand.id, []);
      return { waiting, after: await beginOf(db, admin.id, returnId) };
    });

    expect(out.waiting).toMatchObject(refused('RETURN_HAND_REFUND_PENDING'));
    expect(out.after.ok).toBe(true);
  });

  it('while what the bank took for a lost dispute of a sent order is not decided (RETURN_BANK_MONEY_PENDING)', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await soldOrder(db);
      const returnId = await cameBack(db, orderId, [itemIds[1]!]);
      await synced(db, {
        stripeId: newDisputeId(),
        paymentId,
        status: 'lost',
        transactions: [withdrawal(10)],
      });
      const waiting = await beginOf(db, admin.id, returnId);
      const [bank] = await linesWhere(
        db,
        admin.id,
        `"paymentId" = $1 and event = 'money.dispute_withdrawn'`,
        paymentId,
      );
      await decided(db, bank!.id, [{ orderItemId: itemIds[0], quantity: 1, amount: 10 }]);
      return { waiting, after: await beginOf(db, admin.id, returnId) };
    });

    expect(out.waiting).toMatchObject(refused('RETURN_BANK_MONEY_PENDING'));
    expect(out.after.ok).toBe(true);
  });
});

describe('the money shared by itself, by the sums of the items and the delivery', () => {
  it('shares a refund made by hand of an order root cancels, the cents to the delivery', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId } = await soldOrder(db, false);
      const hand = await handRefundOf(db, paymentId, 10);
      await call(
        db,
        asRoot(),
        DECIDE,
        orderId,
        'hand_refund',
        'cancel',
        'The buyer asked to cancel.',
      );
      return { line: await lineOf(db, admin.id, hand.id) };
    });

    // 10 of 40: a quarter of each item (5 and 3.75) and of the delivery (1.25)
    expect(out.line).toMatchObject({ moneyUse: 'goods' });
    const meta = out.line.meta as Array<Record<string, unknown>>;
    expect(meta.filter((one) => one.orderItemId).map((one) => one.amount)).toEqual([5, 3.75]);
    expect(meta.find((one) => one.delivery !== undefined)).toEqual({ delivery: 1.25 });
  });

  it('shares what the bank took for a lost dispute of an order not sent, which the system cancels', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId } = await soldOrder(db, false);
      await synced(db, {
        stripeId: newDisputeId(),
        paymentId,
        status: 'lost',
        transactions: [withdrawal(40)],
      });
      const [bank] = await linesWhere(
        db,
        admin.id,
        `"paymentId" = $1 and event = 'money.dispute_withdrawn'`,
        paymentId,
      );
      return { orderId, bank: await lineOf(db, admin.id, bank!.id) };
    });

    expect(out.bank).toMatchObject({ moneyUse: 'goods' });
    expect(
      (out.bank.meta as Array<Record<string, unknown>>).map((one) => one.amount ?? one.delivery),
    ).toEqual([20, 15, 5]);
  });

  // a line too small for the sums: the items round up past it, so the delivery takes none and the
  // cent comes off the dearest item
  it('shares a small line whose items round up past it: the delivery takes none, the dearest item gives the cent back', async () => {
    const out = await inRolledBackTx(async (db) => {
      const items: Items = rounded.map((product) => [product.variantId, 1]);
      const orderId = await paidOrderOf(db, buyer.id, admin.id, items, {
        flat: 0.01,
        freeFrom: null,
        expected: 0.01,
      });
      const hand = await handRefundOf(db, `pi_db_${orderId}`, 1);
      const decided = await call(
        db,
        asRoot(),
        DECIDE,
        orderId,
        'hand_refund',
        'cancel',
        'The buyer asked to cancel.',
      );
      return { decided, line: await lineOf(db, admin.id, hand.id) };
    });

    expect(out.decided).toMatchObject({ ok: true });
    const meta = out.line.meta as Array<Record<string, unknown>>;
    // 0.335, 0.335 and 0.3299 round to 0.34, 0.34 and 0.33: the first item gives the cent back
    expect(meta.filter((one) => one.orderItemId).map((one) => one.amount)).toEqual([
      0.33, 0.34, 0.33,
    ]);
    expect(meta.find((one) => one.delivery !== undefined)?.delivery ?? 0).toBe(0);
  });

  const SHARE = `select cartlify.share_money_line($1::int) as result`;

  // an item has room for what it cost less what the statements already paid its rows: the money of
  // a statement is the buyer's already, a share on top of it would pay the item twice
  it('gives no share to an item a statement already paid', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await soldOrder(db);
      const returnId = await cameBack(db, orderId, [itemIds[1]!]);
      await begun(db, admin.id, returnId);
      // the second item (15) is on its way back: 25 are left of the payment of 40
      const hand = await handRefundOf(db, paymentId, 25);
      const shared = await call(db, asRoot(), SHARE, hand.id);
      return { itemIds, shared, line: await lineOf(db, admin.id, hand.id) };
    });

    expect(out.shared.ok).toBe(true);
    expect(out.line).toMatchObject({ moneyUse: 'goods' });
    const meta = out.line.meta as Array<Record<string, unknown>>;
    expect(
      meta.filter((one) => one.orderItemId).map((one) => [one.orderItemId, one.amount]),
    ).toEqual([[out.itemIds[0], 20]]);
    expect(meta.find((one) => one.delivery !== undefined)).toEqual({ delivery: 5 });
  });

  it('gives nothing to the items and the delivery the statements paid whole: the line is a loss', async () => {
    const out = await inRolledBackTx(async (db) => {
      const { orderId, paymentId, itemIds } = await soldOrder(db);
      const returnId = await cameBack(db, orderId, itemIds);
      await begun(db, admin.id, returnId);
      await synced(db, {
        stripeId: newDisputeId(),
        paymentId,
        status: 'lost',
        transactions: [withdrawal(10)],
      });
      const [bank] = await linesWhere(
        db,
        admin.id,
        `"paymentId" = $1 and event = 'money.dispute_withdrawn'`,
        paymentId,
      );
      const shared = await call(db, asRoot(), SHARE, bank!.id);
      return { shared, line: await lineOf(db, admin.id, bank!.id) };
    });

    expect(out.shared.ok).toBe(true);
    expect(out.line).toMatchObject({ moneyUse: 'loss', meta: [] });
  });
});
