import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { begun, settledOf, shopCancelOf } from '../../helpers/dbMoney.js';
import { invoicedOrderOf, invoiceShopOf, seriesPrefix } from '../../helpers/dbTaxDocuments.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { deferred, sleep } from '../../helpers/interleave.js';
import { asDbSession, inOwnerTx } from '../../helpers/ownerDb.js';

// The tax documents the database makes in the transaction of the line of money they come from
// (docs/taxes.md): the invoice of a paid order (of every order, or of the ones the buyer asked one
// for), numbered without gaps in its series, with the copies of the seller, the buyer and the lines;
// a refund that is sent gives one credit note of all its lines, which lowers the invoice to the cent
// (the rule of the remainder); a refund that failed after it was sent gives an invoice that reverses
// the credit note. Everything rolls back: each test names a series of its own

let buyer: TestUser;
let stranger: TestUser;
let admin: TestUser;
let product: TestProduct;
let other: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  stranger = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  // 10 a unit
  product = await createProduct({ stock: 50 });
  other = await createProduct({ stock: 50 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, stranger.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

// the data of the shop the documents copy, written in this transaction only
const shopOf = (db: DbSession, mode: 'every_order' | 'on_request') =>
  invoiceShopOf(db, admin.id, mode);

// a paid order of two units at 10 (20 % holds 3.33) and a delivery of 5 (0.83)
const paidOrder = (db: DbSession, invoice = false) =>
  invoicedOrderOf(
    db,
    { buyerId: buyer.id, adminId: admin.id, variantId: product.variantId },
    invoice,
  );

type Doc = {
  id: number;
  kind: string;
  series: string;
  number: number;
  correctsId: number | null;
  seller: Record<string, unknown>;
  buyer: Record<string, unknown>;
  lines: Record<string, unknown>[];
  totals: Record<string, unknown>[];
  details: Record<string, unknown>;
  net: number;
  tax: number;
  gross: number;
  currency: string;
};

const docsOf = async (db: DbSession, orderId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  return db.rows<Doc>(
    `select id, kind::text as kind, series, number, "correctsId", seller, buyer, lines, totals,
            details, net::float8 as net, tax::float8 as tax, gross::float8 as gross, currency
     from cartlify.tax_documents where "orderId" = $1 order by id`,
    orderId,
  );
};

describe('the invoice of a paid order', () => {
  it('copies the seller, the buyer and the lines, numbered without gaps in its series', async () => {
    const result = await inRolledBackTx(async (db) => {
      const series = await shopOf(db, 'every_order');
      const first = await paidOrder(db);
      const second = await paidOrder(db);
      return { series, first: await docsOf(db, first), second: await docsOf(db, second) };
    });

    const [invoice] = result.first;
    expect(result.first).toHaveLength(1);
    expect(invoice).toMatchObject({
      kind: 'invoice',
      series: result.series.invoice,
      number: 1,
      currency: 'EUR',
      seller: {
        name: 'Cartlify S.L.',
        country: 'ES',
        taxNumber: 'ESB12345678',
        taxNumberLabel: 'NIF',
      },
      buyer: { country: 'UA', city: expect.any(String) },
      net: 20.84,
      tax: 4.16,
      gross: 25,
      totals: [{ rate: 20, net: 20.84, tax: 4.16, gross: 25 }],
      details: { footer: 'Registro Mercantil de Madrid' },
    });
    expect(invoice!.lines).toEqual([
      expect.objectContaining({
        kind: 'item',
        quantity: 2,
        rate: 20,
        net: 16.67,
        tax: 3.33,
        gross: 20,
      }),
      expect.objectContaining({ kind: 'delivery', rate: 20, net: 4.17, tax: 0.83, gross: 5 }),
    ]);
    expect(result.second.map((d) => d.number)).toEqual([2]);
  });

  it('makes one on request only for an order the buyer asked one for', async () => {
    const result = await inRolledBackTx(async (db) => {
      await shopOf(db, 'on_request');
      const without = await paidOrder(db, false);
      const asked = await paidOrder(db, true);
      return { without: await docsOf(db, without), asked: await docsOf(db, asked) };
    });

    expect(result.without).toEqual([]);
    expect(result.asked.map((d) => [d.kind, d.number])).toEqual([['invoice', 1]]);
  });
});

describe('the credit notes', () => {
  it('lowers the invoice by one credit note of a refund sent, to the cent', async () => {
    const result = await inRolledBackTx(async (db) => {
      const series = await shopOf(db, 'every_order');
      const orderId = await paidOrder(db);
      const returnId = await shopCancelOf(db, admin.id, orderId);
      const transfer = await begun(db, admin.id, returnId);
      const inTransit = await docsOf(db, orderId);
      await settledOf(db, transfer.key as string, `re_${orderId}`, 'succeeded');
      return { series, inTransit, docs: await docsOf(db, orderId) };
    });

    // nothing while the money is on its way
    expect(result.inTransit.map((d) => d.kind)).toEqual(['invoice']);
    const [invoice, credit] = result.docs;
    expect(result.docs).toHaveLength(2);
    expect(credit).toMatchObject({
      kind: 'credit_note',
      series: result.series.credit,
      number: 1,
      correctsId: invoice!.id,
      net: -20.84,
      tax: -4.16,
      gross: -25,
      buyer: invoice!.buyer,
      details: { invoice: `${result.series.invoice}-1` },
    });
    expect((credit!.details.moneyLogIds as number[]).length).toBe(2);
  });

  // the goods and the delivery of a statement sent outside the app: one movement, one credit note
  it('lowers the invoice by one credit note of the goods and the delivery sent outside the app', async () => {
    const result = await inRolledBackTx(async (db) => {
      await shopOf(db, 'every_order');
      const orderId = await paidOrder(db);
      const returnId = await shopCancelOf(db, admin.id, orderId);
      await db.as({ role: 'ROOT', userId: admin.id });
      const sent = await db.attempt(
        `select cartlify.mark_return_refunded_outside(
           $1::int, null::int[], 'bank_transfer'::cartlify."OutsideMethod", 'To the account of the buyer.',
           (now() at time zone 'UTC')::timestamp(3), null::numeric
         ) as done`,
        returnId,
      );
      if (!sent.ok) throw new Error(`mark_return_refunded_outside refused: ${sent.message}`);
      return docsOf(db, orderId);
    });

    expect(result.map((d) => [d.kind, d.gross])).toEqual([
      ['invoice', 25],
      ['credit_note', -25],
    ]);
    expect((result[1]!.details.moneyLogIds as number[]).length).toBe(2);
  });

  it('reverses a credit note with an invoice when the refund failed after it was sent', async () => {
    const result = await inRolledBackTx(async (db) => {
      await shopOf(db, 'every_order');
      const orderId = await paidOrder(db);
      const returnId = await shopCancelOf(db, admin.id, orderId);
      const transfer = await begun(db, admin.id, returnId);
      await settledOf(db, transfer.key as string, `re_${orderId}`, 'succeeded');
      // the bank of the card sends the money back
      await settledOf(db, transfer.key as string, `re_${orderId}`, 'failed');
      return docsOf(db, orderId);
    });

    expect(result.map((d) => d.kind)).toEqual(['invoice', 'credit_note', 'invoice']);
    const [, credit, reverse] = result;
    // the document it corrects, for the PDF
    expect(reverse!.details.corrects).toBe(`${credit!.series}-${credit!.number}`);
    expect(reverse).toMatchObject({
      correctsId: credit!.id,
      net: 20.84,
      tax: 4.16,
      gross: 25,
      number: 2,
    });
  });
});

// a series holds one kind of document; a prefix may change or go, and the corrections of the
// documents made go on in the last series
describe('the series of the documents', () => {
  // root writes settings of the data of the shop, each row as it is given
  async function rootWrites(db: DbSession, values: [string, unknown][]) {
    await db.as({ role: 'ROOT', userId: admin.id });
    const outcomes = [];
    for (const [key, value] of values) {
      outcomes.push(
        await db.attempt(
          `insert into cartlify.shop_settings (key, value, "setById") values ($1, $2::jsonb, $3)
           returning key`,
          key,
          JSON.stringify(value),
          admin.id,
        ),
      );
    }
    return outcomes;
  }

  it('numbers the credit note of an invoice made in the last series once root took the series away', async () => {
    const result = await inRolledBackTx(async (db) => {
      const series = await shopOf(db, 'every_order');
      await rootWrites(db, [['invoiceYearly', true]]);
      const orderId = await paidOrder(db);
      await rootWrites(db, [
        ['invoiceMode', null],
        ['invoicePrefix', null],
        ['creditNotePrefix', null],
        ['invoiceYearly', null],
      ]);
      const returnId = await shopCancelOf(db, admin.id, orderId);
      const transfer = await begun(db, admin.id, returnId);
      await settledOf(db, transfer.key as string, `re_${orderId}`, 'succeeded');
      return { series, docs: await docsOf(db, orderId) };
    });

    const [invoice, credit] = result.docs;
    // the series a year of the invoice, the same year for its credit note
    const year = invoice!.series.slice(result.series.invoice.length);
    expect(year).toMatch(/^\d{4}$/);
    expect(credit).toMatchObject({
      kind: 'credit_note',
      series: `${result.series.credit}${year}`,
      number: 1,
      correctsId: invoice!.id,
    });
  });

  it('refuses a prefix of one kind the documents of the other are numbered in, a series a year of it too (INVOICE_SERIES_TAKEN), and starts a new series with a new prefix', async () => {
    const result = await inRolledBackTx(async (db) => {
      const series = await shopOf(db, 'every_order');
      const orderId = await paidOrder(db);
      const returnId = await shopCancelOf(db, admin.id, orderId);
      const transfer = await begun(db, admin.id, returnId);
      await settledOf(db, transfer.key as string, `re_${orderId}`, 'succeeded');
      const taken = await rootWrites(db, [
        ['invoicePrefix', series.credit],
        ['creditNotePrefix', series.invoice],
      ]);
      // the invoices of a new prefix in its series a year only
      const yearlyPrefix = seriesPrefix();
      await rootWrites(db, [
        ['invoicePrefix', yearlyPrefix],
        ['invoiceYearly', true],
      ]);
      const yearly = await paidOrder(db);
      const [yearlyInvoice] = await docsOf(db, yearly);
      const takenYearly = await rootWrites(db, [['creditNotePrefix', yearlyPrefix]]);
      const fresh = seriesPrefix();
      const renamed = await rootWrites(db, [
        ['invoiceYearly', false],
        ['invoicePrefix', fresh],
      ]);
      const next = await paidOrder(db);
      return {
        taken,
        yearlyPrefix,
        yearlyInvoice,
        takenYearly,
        renamed,
        fresh,
        next: (await docsOf(db, next))[0],
      };
    });

    for (const refused of [...result.taken, ...result.takenYearly]) {
      expect(refused).toMatchObject({
        ok: false,
        code: '23514',
        message: expect.stringContaining('INVOICE_SERIES_TAKEN'),
      });
    }
    // the credit notes may not take the prefix whose series a year holds the invoice
    expect(result.yearlyInvoice!.series).toMatch(new RegExp(`^${result.yearlyPrefix}\\d{4}$`));
    expect(result.renamed.every((one) => one.ok)).toBe(true);
    expect(result.next).toMatchObject({ kind: 'invoice', series: result.fresh, number: 1 });
  });
});

describe('who reads a document and who changes it', () => {
  it('shows the buyer the documents of their own orders, an admin and root all, nobody else', async () => {
    const seen = await inRolledBackTx(async (db) => {
      await shopOf(db, 'every_order');
      const orderId = await paidOrder(db);
      const count = async (actor: Actor | null) => {
        await db.as(actor);
        const [row] = await db.rows<{ n: number }>(
          'select count(*)::int as n from cartlify.tax_documents where "orderId" = $1',
          orderId,
        );
        return row!.n;
      };
      return {
        buyer: await count({ role: 'USER', userId: buyer.id }),
        stranger: await count({ role: 'USER', userId: stranger.id }),
        guest: await count({ role: 'GUEST', guestId: randomUUID() }),
        admin: await count({ role: 'ADMIN', userId: admin.id }),
        root: await count({ role: 'ROOT', userId: admin.id }),
        nobody: await count(null),
      };
    });

    expect(seen).toEqual({ buyer: 1, stranger: 0, guest: 0, admin: 1, root: 1, nobody: 0 });
  });

  it('gives no role of the app a way to change or remove a document', async () => {
    const result = await inRolledBackTx(async (db) => {
      await shopOf(db, 'every_order');
      const orderId = await paidOrder(db);
      const [invoice] = await docsOf(db, orderId);
      const touched: Record<string, number> = {};
      for (const [name, actor] of [
        ['root', { role: 'ROOT', userId: admin.id }],
        ['admin', { role: 'ADMIN', userId: admin.id }],
        ['buyer', { role: 'USER', userId: buyer.id }],
      ] as const) {
        await db.as(actor);
        const [changed] = await db.rows<{ n: number }>(
          `with c as (
             update cartlify.tax_documents set gross = 0, net = 0, tax = 0 where id = $1 returning id
           )
           select count(*)::int as n from c`,
          invoice!.id,
        );
        const [removed] = await db.rows<{ n: number }>(
          `with c as (delete from cartlify.tax_documents where id = $1 returning id)
           select count(*)::int as n from c`,
          invoice!.id,
        );
        touched[name] = changed!.n + removed!.n;
      }
      const [after] = await docsOf(db, orderId);
      return { touched, gross: after!.gross };
    });

    expect(result).toEqual({ touched: { root: 0, admin: 0, buyer: 0 }, gross: 25 });
  });

  it('lets the owner change nothing of an invoice but empty the copy of the buyer, and remove none', async () => {
    const result = await inOwnerTx(async (owner) => {
      const db = asDbSession(owner);
      await shopOf(db, 'every_order');
      const orderId = await paidOrder(db);
      const [invoice] = await docsOf(db, orderId);
      const attempt = (sql: string) => db.attempt(sql, invoice!.id);
      return {
        sums: await attempt(
          'update cartlify.tax_documents set gross = 0, net = 0, tax = 0 where id = $1',
        ),
        buyer: await attempt(
          `update cartlify.tax_documents set buyer = '{"name": "Other"}'::jsonb where id = $1`,
        ),
        receipt: await attempt(
          `update cartlify.tax_documents set "receiptNumber" = 'X' where id = $1`,
        ),
        emptied: await attempt(
          `update cartlify.tax_documents set buyer = '{}'::jsonb where id = $1`,
        ),
        removed: await attempt('delete from cartlify.tax_documents where id = $1 returning id'),
        left: (await docsOf(db, orderId)).map((d) => d.buyer),
      };
    });

    expect(result.sums).toMatchObject({ ok: false, message: 'TAX_DOCUMENT_APPEND_ONLY' });
    expect(result.buyer).toMatchObject({ ok: false, message: 'TAX_DOCUMENT_APPEND_ONLY' });
    expect(result.receipt).toMatchObject({ ok: false, message: 'TAX_DOCUMENT_APPEND_ONLY' });
    expect(result.emptied.ok).toBe(true);
    expect(result.removed).toEqual({ ok: true, rows: [] });
    expect(result.left).toEqual([{}]);
  });
});

describe('the numbers of a series under payments at once', () => {
  // the backend of a session waits for an advisory lock another session holds
  async function waitsForAdvisoryLock(pid: number, ms = 4000): Promise<boolean> {
    for (let waited = 0; waited < ms; waited += 50) {
      const rows = await inRolledBackTx((db) =>
        db.rows(
          `select 1 as waiting from pg_locks
           where pid = $1 and locktype = 'advisory' and not granted`,
          pid,
        ),
      );
      if (rows.length > 0) return true;
      await sleep(50);
    }
    return false;
  }

  it('makes the payment of a second order wait for the invoice of the first, and leaves no gap when that one is undone', async () => {
    const series = { invoice: seriesPrefix(), credit: seriesPrefix() };
    const held = deferred();
    const release = deferred();
    const pid = deferred<number>();

    const first = inRolledBackTx(async (db) => {
      await invoiceShopOf(db, admin.id, 'every_order', series);
      const numbers = (await docsOf(db, await paidOrder(db))).map((d) => d.number);
      held.resolve();
      await release.promise;
      return numbers;
    });
    first.catch((err) => held.reject(err));
    await held.promise;

    const second = inRolledBackTx(async (db) => {
      const [row] = await db.rows<{ pid: number }>('select pg_backend_pid() as pid');
      pid.resolve(row!.pid);
      await invoiceShopOf(db, admin.id, 'every_order', series);
      const orderId = await invoicedOrderOf(db, {
        buyerId: buyer.id,
        adminId: admin.id,
        variantId: other.variantId,
      });
      return (await docsOf(db, orderId)).map((d) => d.number);
    });
    second.catch(() => undefined);

    let waited: boolean;
    try {
      waited = await waitsForAdvisoryLock(await pid.promise);
    } finally {
      release.resolve();
    }

    expect(waited).toBe(true);
    // the first is undone: the second takes the number it would have taken
    expect(await first).toEqual([1]);
    expect(await second).toEqual([1]);
  });
});
