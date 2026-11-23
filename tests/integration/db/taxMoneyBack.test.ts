import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import {
  DECIDE_USE,
  begun,
  handRefundOf,
  reinstatement,
  settledOf,
  shopCancelOf,
  synced,
  withdrawal,
} from '../../helpers/dbMoney.js';
import { cartOf, confirm, pay } from '../../helpers/dbOrders.js';
import { invoicedOrderOf, invoiceShopOf } from '../../helpers/dbTaxDocuments.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// The tax of money that already reached the buyer and of money that came back to the shop
// (money_log.taxShares and the documents, docs/taxes.md): a refund made by hand holds no tax until
// root says what it was for, the decision gives one credit note, and a statement that takes it
// gives none, whichever way the rest of its rows is paid (at once, by a transfer, outside the app);
// the money of a dispute, which holds no tax while the dispute is open or won and gives its credit
// note with the decision of what it was for once lost; money
// the buyer gave back outside the app; a share a line cannot take goes to the other lines; the
// documents of an invoice made are corrected after the shop stopped making new ones; an order that
// lost the tax the confirmation fixed is not sold by a late payment. Everything rolls back

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let socks: TestProduct;
let caps: TestProduct;

beforeAll(async () => {
  buyer = await createUser({ name: 'Anna Koval' });
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  // 10 a unit
  socks = await createProduct({ stock: 60 });
  caps = await createProduct({ stock: 60 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

type Share = { kind: string; orderItemId: number | null; tax: number; gross: number };
type Line = { id: number; event: string; part: string; amount: number; taxShares: Share[] | null };
type Doc = {
  id: number;
  kind: string;
  gross: number;
  tax: number;
  correctsId: number | null;
  moneyLogId: number | null;
};

const asAdmin = (db: DbSession) => db.as({ role: 'ADMIN', userId: admin.id });
const asRoot = (db: DbSession) => db.as({ role: 'ROOT', userId: root.id });

// a paid order of two units of each product at 10 (20 % holds 3.33 of 20) and a delivery of 5
// (0.83), taxed in Spain by the rule seller, with its invoice
async function invoicedOrder(db: DbSession, variantIds = [socks.variantId]) {
  await invoiceShopOf(db, root.id, 'every_order');
  const orderId = await invoicedOrderOf(db, { buyerId: buyer.id, adminId: admin.id, variantIds });
  await asAdmin(db);
  const items = (
    await db.rows<{ id: number }>(
      'select id from cartlify.order_items where "orderId" = $1 order by id',
      orderId,
    )
  ).map((r) => r.id);
  return { orderId, items, paymentId: `pi_db_${orderId}` };
}

const linesOf = async (db: DbSession, orderId: number) => {
  await asAdmin(db);
  return db.rows<Line>(
    `select id, event, part::text as part, amount::float8 as amount, "taxShares"
     from cartlify.money_log where "orderId" = $1 order by id`,
    orderId,
  );
};

const docsOf = async (db: DbSession, orderId: number) => {
  await asAdmin(db);
  return db.rows<Doc>(
    `select id, kind::text as kind, gross::float8 as gross, tax::float8 as tax, "correctsId", "moneyLogId"
     from cartlify.tax_documents
     where "orderId" = $1 and kind in ('invoice', 'credit_note') order by id`,
    orderId,
  );
};

const cents = (n: number) => Math.round(n * 100) / 100;

// the gross of the shares of every line of money of the order, of a kind (item or delivery)
const sharesOf = (lines: Line[], kind: string) =>
  cents(
    lines
      .flatMap((l) => l.taxShares ?? [])
      .filter((s) => s.kind === kind)
      .reduce((sum, s) => sum + s.gross, 0),
  );

// what the documents after the invoice of the sale did to it: the credit notes and the invoices
// that reverse them
const correctionsOf = (docs: Doc[]) => cents(docs.slice(1).reduce((sum, d) => sum + d.gross, 0));

// an admin marks the order sent
async function shipped(db: DbSession, orderId: number) {
  await asAdmin(db);
  await db.rows(
    `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
    orderId,
  );
}

// the buyer states a defect of units of the item of the order sent, the goods come back to the shelf
async function statementBack(
  db: DbSession,
  orderId: number,
  itemId: number,
  units: number,
  // the units that came back money already with the buyer pays, when other units may still come
  paidUnits?: number,
) {
  await asAdmin(db);
  const created = await db.attempt<{ id: number }>(
    `select cartlify.create_return(
       $1::int, $2::jsonb, 'admin'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
       'defect'::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null, null, 4,
       'Europe/Madrid'
     ) as id`,
    orderId,
    JSON.stringify([{ orderItemId: itemId, quantity: units }]),
  );
  if (!created.ok) throw new Error(`create_return refused: ${created.message}`);
  const returnId = created.rows[0]!.id;
  const [row] = await db.rows<{ id: number }>(
    'select id from cartlify.return_items where "returnId" = $1 order by id',
    returnId,
  );
  const taken = await db.attempt(
    `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb, '{"buyerPaid": 0}'::jsonb)`,
    returnId,
    JSON.stringify([
      {
        itemId: row!.id,
        quantity: units,
        goods: 'to_stock',
        ...(paidUnits === undefined ? {} : { paidUnits }),
      },
    ]),
  );
  if (!taken.ok) throw new Error(`receive_return_items refused: ${taken.message}`);
  return { returnId, rowId: row!.id };
}

// root says what a refund made by hand was for: units of the item for the sum
async function decided(
  db: DbSession,
  lineId: number,
  itemId: number,
  units: number,
  amount: number,
) {
  await asRoot(db);
  const outcome = await db.attempt(
    DECIDE_USE,
    lineId,
    JSON.stringify([{ orderItemId: itemId, quantity: units, amount }]),
    0,
    'For the units of the statement.',
  );
  if (!outcome.ok) throw new Error(`decide_money_use refused: ${outcome.message}`);
}

describe('a refund by hand a statement takes', () => {
  // 25 paid (20 of the socks, 5 of the delivery); 10 given back by hand, which root says was for one
  // unit: the decision gives the credit note of the unit, the row of the unit is paid by it at once
  it('gives the tax of the unit once, with the credit note of the decision and none of the statement', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items, paymentId } = await invoicedOrder(db);
      await shipped(db, orderId);
      const hand = await handRefundOf(db, paymentId, 10);
      await statementBack(db, orderId, items[0]!, 1);
      await decided(db, hand.id, items[0]!, 1, 10);
      return { lines: await linesOf(db, orderId), docs: await docsOf(db, orderId) };
    });

    // one unit and the delivery are still sold
    expect(sharesOf(result.lines, 'item')).toBe(10);
    expect(sharesOf(result.lines, 'delivery')).toBe(5);
    expect(result.docs.map((d) => [d.kind, d.gross])).toEqual([
      ['invoice', 25],
      ['credit_note', -10],
    ]);
    // the credit note is of the decision: the line of the refund made by hand
    expect(result.docs[1]!.moneyLogId).toBe(
      result.lines.find((l) => l.event === 'money.refund')!.id,
    );
    expect(correctionsOf(result.docs)).toBe(-10);
  });

  it('gives the tax of the unit once when the rest goes by a transfer', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items, paymentId } = await invoicedOrder(db);
      await shipped(db, orderId);
      const hand = await handRefundOf(db, paymentId, 6);
      const { returnId } = await statementBack(db, orderId, items[0]!, 1);
      await decided(db, hand.id, items[0]!, 1, 6);
      const transfer = await begun(db, admin.id, returnId);
      await settledOf(db, transfer.key as string, `re_${randomUUID()}`, 'succeeded');
      return { lines: await linesOf(db, orderId), docs: await docsOf(db, orderId) };
    });

    expect(sharesOf(result.lines, 'item')).toBe(10);
    expect(sharesOf(result.lines, 'delivery')).toBe(5);
    // the decision of the 6, the transfer of the 4 left
    expect(result.docs.map((d) => [d.kind, d.gross])).toEqual([
      ['invoice', 25],
      ['credit_note', -6],
      ['credit_note', -4],
    ]);
    expect(correctionsOf(result.docs)).toBe(-10);
  });

  it('gives the tax of the unit once when the rest goes outside the app', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items, paymentId } = await invoicedOrder(db);
      await shipped(db, orderId);
      const hand = await handRefundOf(db, paymentId, 6);
      const { returnId } = await statementBack(db, orderId, items[0]!, 1);
      await decided(db, hand.id, items[0]!, 1, 6);
      await asRoot(db);
      const sent = await db.attempt(
        `select cartlify.mark_return_refunded_outside(
           $1::int, null::int[], 'bank_transfer'::cartlify."OutsideMethod", 'To the account of the buyer.',
           (now() at time zone 'UTC')::timestamp(3), null::numeric
         ) as done`,
        returnId,
      );
      if (!sent.ok) throw new Error(`mark_return_refunded_outside refused: ${sent.message}`);
      return { lines: await linesOf(db, orderId), docs: await docsOf(db, orderId) };
    });

    expect(sharesOf(result.lines, 'item')).toBe(10);
    expect(sharesOf(result.lines, 'delivery')).toBe(5);
    expect(correctionsOf(result.docs)).toBe(-10);
  });
});

// the sale stands while the bank holds the money: the tax goes down only once the dispute is lost,
// by the decision of what the bank gave the buyer was for
describe('the money of a dispute', () => {
  const disputeLines = (lines: Line[]) => lines.filter((l) => l.event.startsWith('money.dispute_'));

  it('holds no tax and gives no document while the dispute is open, nor once the shop won it', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, paymentId } = await invoicedOrder(db);
      const providerDisputeId = `dp_${randomUUID()}`;
      const taken = withdrawal(25);
      await synced(db, {
        providerDisputeId,
        paymentId,
        status: 'needs_response',
        transactions: [taken],
      });
      const open = await docsOf(db, orderId);
      await synced(db, {
        providerDisputeId,
        paymentId,
        status: 'won',
        transactions: [taken, reinstatement(25)],
      });
      return { open, lines: await linesOf(db, orderId), docs: await docsOf(db, orderId) };
    });

    expect(result.open.map((d) => d.kind)).toEqual(['invoice']);
    expect(disputeLines(result.lines).map((l) => [l.event, l.taxShares])).toEqual([
      ['money.dispute_withdrawn', null],
      ['money.dispute_reinstated', null],
    ]);
    expect(sharesOf(result.lines, 'item')).toBe(20);
    expect(sharesOf(result.lines, 'delivery')).toBe(5);
    expect(result.docs.map((d) => [d.kind, d.gross])).toEqual([['invoice', 25]]);
  });

  // the bank gave the buyer all of an order not sent: the system cancels it by a statement the money
  // of the dispute pays at once (nothing to send)
  it('gives one credit note once lost, with the statement the system makes to cancel the order not sent', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, paymentId } = await invoicedOrder(db);
      await synced(db, {
        providerDisputeId: `dp_${randomUUID()}`,
        paymentId,
        status: 'lost',
        transactions: [withdrawal(25)],
      });
      const lost = await docsOf(db, orderId);
      await db.as({ role: 'ADMIN' });
      const made = await db.attempt<{ id: number }>(
        `select cartlify.create_return(
           $1::int, null::jsonb, 'system'::cartlify."ReturnSource", 'other'::cartlify."ReturnBasis",
           'dispute_lost'::cartlify."ReturnReason", null, 'Anna Koval', 'anna@example.com', null, null,
           4, 'Europe/Madrid'
         ) as id`,
        orderId,
      );
      if (!made.ok) throw new Error(`create_return refused: ${made.message}`);
      return { lost, lines: await linesOf(db, orderId), docs: await docsOf(db, orderId) };
    });

    // the system said at once what the bank took was for: all of the order, one credit note
    expect(result.lost.map((d) => [d.kind, d.gross])).toEqual([
      ['invoice', 25],
      ['credit_note', -25],
    ]);
    // all of the order went back, its tax with it
    expect(sharesOf(result.lines, 'item')).toBe(0);
    expect(sharesOf(result.lines, 'delivery')).toBe(0);
    expect(result.docs.map((d) => [d.kind, d.gross])).toEqual([
      ['invoice', 25],
      ['credit_note', -25],
    ]);
    expect(result.docs[1]!.correctsId).toBe(result.docs[0]!.id);
  });

  // the shop cancelled the order not sent while the dispute was open: its statement waits for the
  // bank, and the money the bank gave the buyer pays it once the dispute is lost
  it('gives one credit note once lost, with the statement of the shop that waited for the bank', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, paymentId } = await invoicedOrder(db);
      const providerDisputeId = `dp_${randomUUID()}`;
      const taken = withdrawal(25);
      await synced(db, {
        providerDisputeId,
        paymentId,
        status: 'needs_response',
        transactions: [taken],
      });
      await shopCancelOf(db, admin.id, orderId);
      await synced(db, { providerDisputeId, paymentId, status: 'lost', transactions: [taken] });
      return { lines: await linesOf(db, orderId), docs: await docsOf(db, orderId) };
    });

    expect(sharesOf(result.lines, 'item')).toBe(0);
    expect(sharesOf(result.lines, 'delivery')).toBe(0);
    expect(result.docs.map((d) => [d.kind, d.gross])).toEqual([
      ['invoice', 25],
      ['credit_note', -25],
    ]);
  });

  // of an order sent the bank took all of the payment: the system shares it among the order, and
  // root says again what it was for: a unit, the rest a loss of the shop, which lowers no tax; the
  // decision made again reverses the credit note of the first and gives its own. The unit comes back
  // and the admin marks it as the one the bank paid (no decision is made again once a row took it)
  it('gives the credit note of the unit a statement takes of a dispute lost on an order sent, and none for the loss', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items, paymentId } = await invoicedOrder(db);
      await shipped(db, orderId);
      await synced(db, {
        providerDisputeId: `dp_${randomUUID()}`,
        paymentId,
        status: 'lost',
        transactions: [withdrawal(25)],
      });
      const bank = disputeLines(await linesOf(db, orderId))[0]!;
      await decided(db, bank.id, items[0]!, 1, 10);
      // the other unit may still come: the admin says this one is the one the bank paid
      await statementBack(db, orderId, items[0]!, 1, 1);
      return { lines: await linesOf(db, orderId), docs: await docsOf(db, orderId) };
    });

    // the decision of root: one unit, the rest a loss of the shop
    expect(sharesOf(disputeLines(result.lines), 'item')).toBe(-10);
    // one unit went back; the other unit and the delivery stay sold, the loss lowers nothing
    expect(sharesOf(result.lines, 'item')).toBe(10);
    expect(sharesOf(result.lines, 'delivery')).toBe(5);
    expect(result.docs.map((d) => [d.kind, d.gross])).toEqual([
      ['invoice', 25],
      ['credit_note', -25],
      ['invoice', 25],
      ['credit_note', -10],
    ]);
    expect(result.docs[2]!.correctsId).toBe(result.docs[1]!.id);
    expect(correctionsOf(result.docs)).toBe(-10);
  });
});

describe('money that came back to the shop', () => {
  it('takes back the tax of the money the buyer gave back outside the app for a row', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId } = await invoicedOrder(db);
      const returnId = await shopCancelOf(db, admin.id, orderId);
      const transfer = await begun(db, admin.id, returnId);
      await settledOf(db, transfer.key as string, `re_${randomUUID()}`, 'succeeded');
      await asAdmin(db);
      const [row] = await db.rows<{ id: number }>(
        'select id from cartlify.return_items where "returnId" = $1 order by id',
        returnId,
      );
      await asRoot(db);
      const received = await db.attempt(
        `select cartlify.record_money_received(
           $1::int, $2::jsonb, 'bank_transfer'::cartlify."OutsideMethod", 'The buyer sent 5 back.',
           (now() at time zone 'UTC')::timestamp(3)
         ) as done`,
        returnId,
        JSON.stringify([{ itemId: row!.id, amount: 5 }]),
      );
      if (!received.ok) throw new Error(`record_money_received refused: ${received.message}`);
      return { lines: await linesOf(db, orderId), docs: await docsOf(db, orderId) };
    });

    const back = result.lines.find((l) => l.event === 'money.received')!;
    expect(back.taxShares).toEqual([
      expect.objectContaining({ kind: 'item', gross: 5, tax: 0.83 }),
    ]);
    // all of it went back, 5 of the goods came back
    expect(sharesOf(result.lines, 'item')).toBe(5);
    expect(result.docs.at(-1)).toMatchObject({ kind: 'invoice', gross: 5, moneyLogId: back.id });
  });
});

describe('the shares of money that went back', () => {
  // 45 paid: 20 of each product and 5 of the delivery; 15 given back by hand (by what each had: 6.67,
  // 6.67, 1.66), which root says was no unit (a compensation); then all of the socks go back: 20,
  // of which the socks have 13.33 left, the rest goes to the other goods
  it('give a line the part another could not take, so the money and its tax meet', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId, items, paymentId } = await invoicedOrder(db, [
        socks.variantId,
        caps.variantId,
      ]);
      const hand = await handRefundOf(db, paymentId, 15);
      await asRoot(db);
      const decision = await db.attempt(
        DECIDE_USE,
        hand.id,
        '[]',
        0,
        'A compensation for the delay.',
      );
      if (!decision.ok) throw new Error(`decide_money_use refused: ${decision.message}`);
      const returnId = await shopCancelOf(db, admin.id, orderId, [items[0]!]);
      const transfer = await begun(db, admin.id, returnId);
      await settledOf(db, transfer.key as string, `re_${randomUUID()}`, 'succeeded');
      return (await linesOf(db, orderId)).filter(
        (l) => l.event === 'money.refund' && l.part === 'goods',
      );
    });

    const [goods] = result;
    expect(goods!.amount).toBe(-20);
    expect(cents((goods!.taxShares ?? []).reduce((sum, s) => sum + s.gross, 0))).toBe(-20);
  });
});

describe('the documents of an invoice made', () => {
  it('are corrected when money goes back after the shop stopped making new invoices', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { orderId } = await invoicedOrder(db);
      await asRoot(db);
      await db.rows(
        `insert into cartlify.shop_settings (key, value, "setById") values ('invoiceMode', 'null'::jsonb, $1)
         returning key`,
        root.id,
      );
      const returnId = await shopCancelOf(db, admin.id, orderId);
      const transfer = await begun(db, admin.id, returnId);
      await settledOf(db, transfer.key as string, `re_${randomUUID()}`, 'succeeded');
      return docsOf(db, orderId);
    });

    expect(result.map((d) => [d.kind, d.gross])).toEqual([
      ['invoice', 25],
      ['credit_note', -25],
    ]);
  });
});

describe('a payment after the order lost its reservation', () => {
  // the confirmation fixed the tax of the items; the reservation ended and the order is a cart
  // again; a read of the buyer gives it the prices of now and takes the tax off the items
  async function unconfirmedOrder(db: DbSession, readSince: boolean, deliveryTaxed = true) {
    const orderId = await cartOf(db, buyer.id, [[socks.variantId, 2]]);
    await asAdmin(db);
    const [item] = await db.rows<{ id: number }>(
      'select id from cartlify.order_items where "orderId" = $1',
      orderId,
    );
    const taxed = await confirm(db, buyer.id, orderId, '15 minutes', {
      flat: 5,
      expected: 5,
      tax: {
        items: [
          {
            id: item!.id,
            rule: 'seller',
            country: 'ES',
            groupId: null,
            rate: 20,
            unitPrice: 10,
            tax: 3.33,
          },
        ],
        delivery: deliveryTaxed
          ? { rule: 'seller', parts: [{ rate: 20, gross: 5, tax: 0.83 }] }
          : null,
      },
    });
    if (!taxed.ok) throw new Error(`confirm_order refused: ${taxed.message}`);
    // the timer of the reservation: the system
    await db.as({ role: 'ADMIN' });
    await db.rows('select 1 as done from cartlify.unconfirm_order($1::int)', orderId);
    if (readSince) {
      await db.as({ role: 'USER', userId: buyer.id });
      await db.rows('select cartlify.refresh_order_prices($1::int) as changed', orderId);
    }
    return orderId;
  }

  it('is not taken by an order that lost the tax the confirmation fixed', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await unconfirmedOrder(db, true);
      return pay(db, admin.id, orderId, { amount: '25', currency: 'eur' });
    });

    expect(result).toBe('ORDER_NOT_PAYABLE');
  });

  // a shop that takes the tax gives every item a rule: a delivery without one (a pickup) tells
  // nothing, the rule of the shop does
  it('is not taken by an order of a shop that takes the tax whose delivery held none, once its items lost theirs', async () => {
    const result = await inRolledBackTx(async (db) => {
      await asRoot(db);
      await db.rows(
        `insert into cartlify.shop_settings (key, value, "setById") values ('vatPayer', 'true'::jsonb, $1)
         returning key`,
        root.id,
      );
      const orderId = await unconfirmedOrder(db, true, false);
      return pay(db, admin.id, orderId, { amount: '25', currency: 'eur' });
    });

    expect(result).toBe('ORDER_NOT_PAYABLE');
  });

  it('is taken by an order that kept it', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await unconfirmedOrder(db, false);
      return pay(db, admin.id, orderId, { amount: '25', currency: 'eur' });
    });

    expect(result).toBe('PAID');
  });
});
