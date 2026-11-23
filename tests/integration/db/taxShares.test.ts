import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import {
  begun,
  DECIDE_USE,
  handRefundOf,
  settledOf,
  shopCancelOf,
  SYSTEM,
} from '../../helpers/dbMoney.js';
import { invoicedOrderOf, invoiceShopOf } from '../../helpers/dbTaxDocuments.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { asDbSession, inOwnerTx } from '../../helpers/ownerDb.js';

// The tax a line of money of an order holds (money_log.taxShares, docs/taxes.md), share by share of
// the copy of the order: a payment takes the copy of its part; money that went back to the buyer
// (a refund once it is sent, money sent outside the app) takes what each line of the copy has left,
// the last share of a line the rest of its tax (the rule of the remainder); money that came back to
// the shop the shares of the line it covers, turned round. A credit note holds the shares of its
// lines; the report of the tax reads them. Everything rolls back

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let socks: TestProduct;
let caps: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
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

type Share = {
  kind: string;
  orderItemId: number | null;
  rate: number | null;
  rule: string | null;
  country: string | null;
  net: number;
  tax: number;
  gross: number;
};

type Line = {
  id: number;
  event: string;
  part: string;
  amount: number;
  state: string | null;
  taxShares: Share[] | null;
};

const linesOf = async (db: DbSession, orderId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  return db.rows<Line>(
    `select id, event, part::text as part, amount::float8 as amount, state::text as state,
            "taxShares"
     from cartlify.money_log where "orderId" = $1 order by id`,
    orderId,
  );
};

// a paid order of two units of each product at 10 (20 % holds 3.33 of each item) and a delivery of
// 5 (0.83), taxed in Spain by the rule seller
const paidOrder = (db: DbSession, variantIds = [socks.variantId]) =>
  invoicedOrderOf(db, { buyerId: buyer.id, adminId: admin.id, variantIds });

// the shares summed: net, tax, gross
const sumOf = (shares: Share[]) =>
  shares.reduce(
    (s, x) => ({
      net: Math.round((s.net + x.net) * 100) / 100,
      tax: Math.round((s.tax + x.tax) * 100) / 100,
      gross: Math.round((s.gross + x.gross) * 100) / 100,
    }),
    { net: 0, tax: 0, gross: 0 },
  );

async function refundOf(db: DbSession, orderId: number, itemIds: number[] | null, sent = true) {
  const returnId = await shopCancelOf(db, admin.id, orderId, itemIds);
  const transfer = await begun(db, admin.id, returnId);
  const refundId = `re_${orderId}_${returnId}`;
  if (sent) await settledOf(db, transfer.key as string, refundId, 'succeeded');
  return { key: transfer.key as string, refundId };
}

const itemsOf = async (db: DbSession, orderId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  return (
    await db.rows<{ id: number }>(
      'select id from cartlify.order_items where "orderId" = $1 order by id',
      orderId,
    )
  ).map((r) => r.id);
};

describe('the tax of a payment', () => {
  it('holds the copy of the order by the part of its line, with the rule and the country', async () => {
    const lines = await inRolledBackTx(async (db) => linesOf(db, await paidOrder(db)));

    const [goods, delivery] = lines;
    expect(lines.map((l) => [l.event, l.part])).toEqual([
      ['money.payment', 'goods'],
      ['money.payment', 'delivery'],
    ]);
    expect(goods!.taxShares).toEqual([
      expect.objectContaining({
        kind: 'item',
        rate: 20,
        rule: 'seller',
        country: 'ES',
        net: 16.67,
        tax: 3.33,
        gross: 20,
      }),
    ]);
    expect(delivery!.taxShares).toEqual([
      expect.objectContaining({
        kind: 'delivery',
        orderItemId: null,
        rate: 20,
        rule: 'seller',
        country: 'ES',
        net: 4.17,
        tax: 0.83,
        gross: 5,
      }),
    ]);
  });
});

describe('the tax of money that went back', () => {
  it('holds none while a refund is on its way, and its shares, below 0, once it is sent', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      const returnId = await shopCancelOf(db, admin.id, orderId);
      const transfer = await begun(db, admin.id, returnId);
      const onItsWay = (await linesOf(db, orderId)).filter((l) => l.event === 'money.refund');
      await settledOf(db, transfer.key as string, `re_${orderId}`, 'succeeded');
      return {
        onItsWay,
        sent: (await linesOf(db, orderId)).filter((l) => l.event === 'money.refund'),
      };
    });

    expect(result.onItsWay.map((l) => [l.state, l.taxShares])).toEqual([
      ['in_transit', null],
      ['in_transit', null],
    ]);
    const shares = result.sent.flatMap((l) => l.taxShares ?? []);
    expect(result.sent.map((l) => l.state)).toEqual(['sent', 'sent']);
    expect(sumOf(shares)).toEqual({ net: -20.84, tax: -4.16, gross: -25 });
  });

  it('gives the credit note the shares of the lines of its transfer', async () => {
    const result = await inRolledBackTx(async (db) => {
      await invoiceShopOf(db, admin.id, 'every_order');
      const orderId = await paidOrder(db, [socks.variantId, caps.variantId]);
      const [first] = await itemsOf(db, orderId);
      await refundOf(db, orderId, [first!]);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const [credit] = await db.rows<{ lines: Share[] }>(
        `select lines from cartlify.tax_documents where "orderId" = $1 and kind = 'credit_note'`,
        orderId,
      );
      return { credit: credit!.lines, lines: await linesOf(db, orderId) };
    });

    const refundShares = result.lines
      .filter((l) => l.event === 'money.refund')
      .flatMap((l) => l.taxShares ?? []);
    expect(result.credit).toEqual(refundShares);
    expect(sumOf(refundShares)).toEqual({ net: -16.67, tax: -3.33, gross: -20 });
  });

  it('meets the tax of an item to the cent in parts: the last part takes the rest of its tax', async () => {
    const lines = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      // 7 and then 13 given back by hand in the dashboard, each a compensation by the decision of
      // root: its tax by what every line has left
      for (const amount of [7, 13]) {
        const hand = await handRefundOf(db, `pi_db_${orderId}`, amount);
        await db.as({ role: 'ROOT', userId: root.id });
        const decided = await db.attempt(DECIDE_USE, hand.id, '[]', 0, 'A compensation.');
        if (!decided.ok) throw new Error(`decide_money_use refused: ${decided.message}`);
      }
      return (await linesOf(db, orderId)).filter((l) => l.event === 'money.refund');
    });

    const items = lines.flatMap((l) => (l.taxShares ?? []).filter((s) => s.kind === 'item'));
    const delivery = lines.flatMap((l) => (l.taxShares ?? []).filter((s) => s.kind === 'delivery'));
    // 20 of 25 went back in all: what each line of the copy left meets the payment to the cent
    expect(sumOf([...items, ...delivery]).gross).toBe(-20);
    for (const share of [...items, ...delivery]) {
      const r = share.rate!;
      expect(Math.abs(share.tax)).toBeLessThanOrEqual(
        Math.round(((Math.abs(share.gross) * r) / (100 + r)) * 100) / 100 + 0.01,
      );
    }
  });

  it('gives the shares back when a refund failed after it was sent, none when it failed on its way', async () => {
    const result = await inRolledBackTx(async (db) => {
      const sentThenFailed = await paidOrder(db);
      const one = await refundOf(db, sentThenFailed, null);
      await settledOf(db, one.key, one.refundId, 'failed');

      const failedOnItsWay = await paidOrder(db);
      const two = await refundOf(db, failedOnItsWay, null, false);
      await settledOf(db, two.key, null, 'failed');

      return {
        after: await linesOf(db, sentThenFailed),
        onItsWay: await linesOf(db, failedOnItsWay),
      };
    });

    const refunds = result.after.filter((l) => l.event === 'money.refund');
    const failures = result.after.filter((l) => l.event === 'money.refund_failed');
    expect(sumOf(refunds.flatMap((l) => l.taxShares ?? []))).toEqual({
      net: -20.84,
      tax: -4.16,
      gross: -25,
    });
    expect(sumOf(failures.flatMap((l) => l.taxShares ?? []))).toEqual({
      net: 20.84,
      tax: 4.16,
      gross: 25,
    });
    const quiet = result.onItsWay.filter((l) => l.event !== 'money.payment');
    expect(quiet.length).toBeGreaterThan(0);
    expect(quiet.every((l) => l.taxShares === null)).toBe(true);
  });
});

describe('the tax of a line is written by the database', () => {
  // a line written the way the functions of the journal write it, as the system
  const LOG = `select cartlify.log_money_change($1::jsonb) as id`;

  it('holds none for a line of no sale: a late payment', async () => {
    const line = await inOwnerTx(async (owner) => {
      const db = asDbSession(owner);
      const orderId = await paidOrder(db);
      await db.as(SYSTEM);
      const [row] = await db.rows<{ id: number }>(
        LOG,
        JSON.stringify({
          event: 'money.late_payment',
          purpose: 'late_payment',
          part: 'whole',
          amount: 5,
          provider: 'stripe',
          paymentId: `pi_late_${orderId}`,
          orderId,
        }),
      );
      return (await linesOf(db, orderId)).find((l) => l.id === row!.id)!;
    });

    expect(line.taxShares).toBeNull();
  });

  it('drops the shares a writer puts in, and keeps the ones a line got', async () => {
    const result = await inOwnerTx(async (owner) => {
      const db = asDbSession(owner);
      const orderId = await paidOrder(db);
      await db.as(SYSTEM);
      // a compensation root sent outside the app, with shares of its own
      const [row] = await db.rows<{ id: number }>(
        LOG,
        JSON.stringify({
          event: 'money.outside',
          purpose: 'compensation',
          part: 'whole',
          amount: -10,
          method: 'bank_transfer',
          note: 'Sent outside the app',
          happenedAt: '2026-11-20T10:00:00',
          orderId,
          taxShares: [{ kind: 'item', gross: -999, tax: -999, net: 0 }],
        }),
      );
      const changed = await db.attempt(
        `update cartlify.money_log set "taxShares" = '[]'::jsonb where id = $1`,
        row!.id,
      );
      return { line: (await linesOf(db, orderId)).find((l) => l.id === row!.id)!, changed };
    });

    // the whole order shares the 10: 8 of the items (1.33), 2 of the delivery (0.33)
    expect(sumOf(result.line.taxShares!)).toEqual({ net: -8.34, tax: -1.66, gross: -10 });
    expect(result.changed).toMatchObject({ ok: false, message: 'MONEY_LOG_APPEND_ONLY' });
  });
});
