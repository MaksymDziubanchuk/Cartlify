import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { begun, settledOf, shopCancelOf, SYSTEM } from '../../helpers/dbMoney.js';
import { invoicedOrderOf, invoiceShopOf, receiptMomentOf } from '../../helpers/dbTaxDocuments.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { asDbSession, inOwnerTx } from '../../helpers/ownerDb.js';

// The fiscal receipts of the documents (docs/taxes.md): the database makes the row of a receipt with
// its invoice or credit note when root wrote the moment of the receipt: the receipt of a sale with
// the invoice at the payment, or when the order is sent; a return receipt with a credit note, after
// the receipt of the sale it corrects; a receipt with an invoice that reverses a credit note. The
// row waits for the worker of the receipts, which writes the answer of the provider
// (record_receipt_result, the system only); an admin confirms one made by hand
// (confirm_receipt_manual). Everything rolls back: each test names a series of its own

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
  socks = await createProduct({ stock: 50 });
  caps = await createProduct({ stock: 50 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const adminActor = (): Actor => ({ role: 'ADMIN', userId: admin.id });

// the shop of the test: invoices of every order, the receipt of a sale at the moment given
async function shopOf(db: DbSession, moment: 'payment' | 'shipment' | null) {
  const series = await invoiceShopOf(db, root.id, 'every_order');
  if (moment) await receiptMomentOf(db, root.id, moment);
  return series;
}

const paidOrder = (db: DbSession, variantIds = [socks.variantId]) =>
  invoicedOrderOf(db, { buyerId: buyer.id, adminId: admin.id, variantIds });

type Doc = {
  id: number;
  orderId: number;
  kind: string;
  series: string | null;
  number: number | null;
  correctsId: number | null;
  documentId: number | null;
  provider: string | null;
  receiptState: string | null;
  receiptAttempts: number;
  receiptNumber: string | null;
  receiptUrl: string | null;
  receiptCode: string | null;
  receiptText: string | null;
  receiptError: string | null;
  due: boolean | null;
  receiptConfirmedById: number | null;
  lines: unknown;
  details: Record<string, unknown>;
  net: number;
  tax: number;
  gross: number;
};

const docsOf = async (db: DbSession, orderId: number) => {
  await db.as(adminActor());
  return db.rows<Doc>(
    `select id, "orderId", kind::text as kind, series, number, "correctsId", "documentId", provider,
            "receiptState"::text as "receiptState", "receiptAttempts", "receiptNumber",
            "receiptUrl", "receiptCode", "receiptText", "receiptError",
            "receiptNextAt" <= (clock_timestamp() at time zone 'UTC') as due,
            "receiptConfirmedById", lines, details, net::float8 as net, tax::float8 as tax,
            gross::float8 as gross
     from cartlify.tax_documents where "orderId" = $1 order by id`,
    orderId,
  );
};

const kindsOf = (docs: Doc[]) => docs.map((d) => d.kind);

// an admin marks the order sent
async function ship(db: DbSession, orderId: number) {
  await db.as(adminActor());
  await db.rows(`update cartlify.orders set status = 'shipped' where id = $1`, orderId);
}

// a refund of the items named of the order that is sent and succeeds: a credit note
async function refundItems(db: DbSession, orderId: number, itemIds: number[] | null = null) {
  const returnId = await shopCancelOf(db, admin.id, orderId, itemIds);
  const transfer = await begun(db, admin.id, returnId);
  const refundId = `re_${orderId}_${returnId}`;
  await settledOf(db, transfer.key as string, refundId, 'succeeded');
  return { key: transfer.key as string, refundId };
}

const itemsOf = async (db: DbSession, orderId: number) => {
  await db.as(adminActor());
  const rows = await db.rows<{ id: number }>(
    'select id from cartlify.order_items where "orderId" = $1 order by id',
    orderId,
  );
  return rows.map((r) => r.id);
};

const RECORD = `select cartlify.record_receipt_result($1::int, $2, $3, $4, $5, $6, $7, $8, $9::timestamp) as registered`;

// the answer of the provider, written as the system writes it
const record = (
  db: DbSession,
  id: number,
  state: string,
  over: {
    number?: string | null;
    url?: string | null;
    code?: string | null;
    text?: string | null;
    error?: string | null;
    nextAt?: string | null;
    provider?: string | null;
  } = {},
) =>
  db.attempt<{ registered: boolean }>(
    RECORD,
    id,
    'provider' in over ? over.provider : 'fiskaly',
    state,
    over.number ?? null,
    over.url ?? null,
    over.code ?? null,
    over.text ?? null,
    over.error ?? null,
    'nextAt' in over ? over.nextAt : state === 'pending' ? '2026-11-22 12:00:00' : null,
  );

const CONFIRM = `select 1 as done from cartlify.confirm_receipt_manual($1::int, $2, $3, $4)`;

describe('the receipts the database makes with the documents', () => {
  it('makes none while the shop has no moment of the receipt', async () => {
    const docs = await inRolledBackTx(async (db) => {
      await shopOf(db, null);
      return docsOf(db, await paidOrder(db));
    });

    expect(kindsOf(docs)).toEqual(['invoice']);
  });

  it('makes the receipt of a sale with its invoice at the payment: a copy that waits for the worker', async () => {
    const result = await inRolledBackTx(async (db) => {
      const series = await shopOf(db, 'payment');
      return { series, docs: await docsOf(db, await paidOrder(db)) };
    });

    const [invoice, receipt] = result.docs;
    expect(kindsOf(result.docs)).toEqual(['invoice', 'receipt']);
    expect(receipt).toMatchObject({
      series: null,
      number: null,
      documentId: invoice!.id,
      correctsId: null,
      provider: null,
      receiptState: 'pending',
      receiptAttempts: 0,
      receiptNumber: null,
      due: true,
      net: invoice!.net,
      tax: invoice!.tax,
      gross: invoice!.gross,
      details: { document: `${result.series.invoice}-1` },
    });
    expect(receipt!.lines).toEqual(invoice!.lines);
  });

  it('makes the receipt of a sale when the order is sent, then the return receipt of a credit note made before', async () => {
    const result = await inRolledBackTx(async (db) => {
      await shopOf(db, 'shipment');
      const orderId = await paidOrder(db, [socks.variantId, caps.variantId]);
      const atPayment = kindsOf(await docsOf(db, orderId));
      // one item cancelled and refunded before the parcel goes
      const [first] = await itemsOf(db, orderId);
      await refundItems(db, orderId, [first!]);
      const beforeShipment = kindsOf(await docsOf(db, orderId));
      await ship(db, orderId);
      return { atPayment, beforeShipment, docs: await docsOf(db, orderId) };
    });

    expect(result.atPayment).toEqual(['invoice']);
    expect(result.beforeShipment).toEqual(['invoice', 'credit_note']);
    const [invoice, credit, sale, back] = result.docs;
    expect(kindsOf(result.docs)).toEqual(['invoice', 'credit_note', 'receipt', 'return_receipt']);
    expect(sale).toMatchObject({ documentId: invoice!.id, correctsId: null });
    expect(back).toMatchObject({
      documentId: credit!.id,
      correctsId: sale!.id,
      gross: credit!.gross,
      receiptState: 'pending',
    });
  });

  it('makes the receipt of a sale once, when the order is sent again after a step back', async () => {
    const docs = await inRolledBackTx(async (db) => {
      await shopOf(db, 'shipment');
      const orderId = await paidOrder(db);
      await ship(db, orderId);
      await db.as(adminActor());
      await db.rows(`update cartlify.orders set status = 'paid' where id = $1`, orderId);
      await ship(db, orderId);
      return docsOf(db, orderId);
    });

    expect(kindsOf(docs)).toEqual(['invoice', 'receipt']);
  });

  it('makes the return receipt of a credit note after the receipt of its sale, and a receipt of an invoice that reverses it', async () => {
    const docs = await inRolledBackTx(async (db) => {
      await shopOf(db, 'payment');
      const orderId = await paidOrder(db);
      const refund = await refundItems(db, orderId);
      // the bank of the card sends the money back
      await settledOf(db, refund.key, refund.refundId, 'failed');
      return docsOf(db, orderId);
    });

    expect(kindsOf(docs)).toEqual([
      'invoice',
      'receipt',
      'credit_note',
      'return_receipt',
      'invoice',
      'receipt',
    ]);
    const [, sale, credit, back, reverse, again] = docs;
    expect(back).toMatchObject({ documentId: credit!.id, correctsId: sale!.id });
    expect(again).toMatchObject({
      documentId: reverse!.id,
      correctsId: back!.id,
      gross: reverse!.gross,
    });
  });

  it('makes no return receipt of a credit note whose sale has no receipt', async () => {
    const docs = await inRolledBackTx(async (db) => {
      await shopOf(db, null);
      const orderId = await paidOrder(db);
      // the shop starts the receipts after the sale
      await receiptMomentOf(db, root.id, 'payment');
      await refundItems(db, orderId);
      return docsOf(db, orderId);
    });

    expect(kindsOf(docs)).toEqual(['invoice', 'credit_note']);
  });
});

describe('the answer of the provider (record_receipt_result)', () => {
  // a paid order of a shop that registers its receipts at the payment: its receipt
  async function receiptOf(db: DbSession) {
    await shopOf(db, 'payment');
    const docs = await docsOf(db, await paidOrder(db));
    return docs.find((d) => d.kind === 'receipt')!;
  }

  it.each([
    ['a signed-in admin', (): Actor | null => adminActor()],
    ['root', (): Actor | null => ({ role: 'ROOT', userId: root.id })],
    ['a buyer', (): Actor | null => ({ role: 'USER', userId: buyer.id })],
    ['nobody', (): Actor | null => null],
  ])('is the work of the system: %s gets RECEIPT_FORBIDDEN', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      const receipt = await receiptOf(db);
      await db.as(actor());
      return record(db, receipt.id, 'registered');
    });

    expect(outcome).toMatchObject({ ok: false, message: 'RECEIPT_FORBIDDEN' });
  });

  it('writes the provider, the state and what it gave, one more try; true once, when it became registered', async () => {
    const result = await inRolledBackTx(async (db) => {
      const receipt = await receiptOf(db);
      await db.as(SYSTEM);
      const taken = await record(db, receipt.id, 'pending', {
        number: 'inv-1',
        nextAt: '2999-01-01 00:00:00',
      });
      await db.as(SYSTEM);
      const done = await record(db, receipt.id, 'registered', {
        number: 'A-CSV1',
        url: 'https://check.example/1',
        code: 'iVBORw0KGgo=',
        text: 'QR tributario:\nVERI*FACTU',
      });
      await db.as(SYSTEM);
      const again = await record(db, receipt.id, 'registered', { number: 'A-CSV2' });
      const [row] = (await docsOf(db, receipt.orderId)).filter((d) => d.id === receipt.id);
      return { taken, done, again, row };
    });

    expect(result.taken).toEqual({ ok: true, rows: [{ registered: false }] });
    expect(result.done).toEqual({ ok: true, rows: [{ registered: true }] });
    // a receipt that does not wait any more is left as it is
    expect(result.again).toEqual({ ok: true, rows: [{ registered: false }] });
    expect(result.row).toMatchObject({
      provider: 'fiskaly',
      receiptState: 'registered',
      receiptAttempts: 2,
      receiptNumber: 'A-CSV1',
      receiptUrl: 'https://check.example/1',
      receiptCode: 'iVBORw0KGgo=',
      receiptText: 'QR tributario:\nVERI*FACTU',
      receiptError: null,
      due: null,
    });
  });

  // the link of a provider is shown to the buyer as well: one not on https is not kept
  it('keeps no link of the provider that is not on https', async () => {
    const row = await inRolledBackTx(async (db) => {
      const receipt = await receiptOf(db);
      await db.as(SYSTEM);
      await record(db, receipt.id, 'registered', {
        number: 'A-CSV1',
        url: 'javascript:alert(1)',
      });
      return (await docsOf(db, receipt.orderId)).find((d) => d.id === receipt.id)!;
    });

    expect(row).toMatchObject({
      receiptState: 'registered',
      receiptNumber: 'A-CSV1',
      receiptUrl: null,
    });
  });

  it('keeps the number the provider gave before when an answer gives none, and the time of the next try of one that waits', async () => {
    const row = await inRolledBackTx(async (db) => {
      const receipt = await receiptOf(db);
      await db.as(SYSTEM);
      await record(db, receipt.id, 'pending', { number: 'inv-1', nextAt: '2999-01-01 00:00:00' });
      await db.as(SYSTEM);
      await record(db, receipt.id, 'pending', {
        error: '{"code":"RECEIPT_PROVIDER_UNAVAILABLE"}',
        nextAt: '2999-01-01 00:00:00',
      });
      return (await docsOf(db, receipt.orderId)).find((d) => d.id === receipt.id)!;
    });

    expect(row).toMatchObject({
      receiptState: 'pending',
      receiptNumber: 'inv-1',
      receiptAttempts: 2,
      receiptError: '{"code":"RECEIPT_PROVIDER_UNAVAILABLE"}',
      due: false,
    });
  });

  it('closes a refused receipt for a person: no next try', async () => {
    const row = await inRolledBackTx(async (db) => {
      const receipt = await receiptOf(db);
      await db.as(SYSTEM);
      await record(db, receipt.id, 'refused', { error: '{"code":"RECEIPT_PROVIDER_REFUSED"}' });
      return (await docsOf(db, receipt.orderId)).find((d) => d.id === receipt.id)!;
    });

    expect(row).toMatchObject({ receiptState: 'refused', due: null, receiptAttempts: 1 });
  });

  it.each([
    ['a state it does not know', 'manual', {}],
    ['a receipt that waits without its next try', 'pending', { nextAt: null }],
    ['no provider', 'registered', { provider: null }],
  ])('takes no answer of %s: RECEIPT_RESULT_INVALID', async (_name, state, over) => {
    const outcome = await inRolledBackTx(async (db) => {
      const receipt = await receiptOf(db);
      await db.as(SYSTEM);
      return record(db, receipt.id, state, over);
    });

    expect(outcome).toMatchObject({ ok: false, message: 'RECEIPT_RESULT_INVALID' });
  });

  it('has no answer for an invoice: RECEIPT_NOT_FOUND', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const receipt = await receiptOf(db);
      await db.as(SYSTEM);
      return record(db, receipt.documentId!, 'registered');
    });

    expect(outcome).toMatchObject({ ok: false, message: 'RECEIPT_NOT_FOUND' });
  });
});

describe('a receipt confirmed by hand (confirm_receipt_manual)', () => {
  async function refusedReceiptOf(db: DbSession) {
    await shopOf(db, 'payment');
    const orderId = await paidOrder(db);
    const receipt = (await docsOf(db, orderId)).find((d) => d.kind === 'receipt')!;
    await db.as(SYSTEM);
    await record(db, receipt.id, 'refused', { error: '{"code":"RECEIPT_PROVIDER_REFUSED"}' });
    return { orderId, receipt };
  }

  it.each([
    ['the system', (): Actor | null => SYSTEM],
    ['a buyer', (): Actor | null => ({ role: 'USER', userId: buyer.id })],
    ['nobody', (): Actor | null => null],
  ])('is for an admin or root: %s gets RECEIPT_FORBIDDEN', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { receipt } = await refusedReceiptOf(db);
      await db.as(actor());
      return db.attempt(CONFIRM, receipt.id, 'fiskaly', 'A-HAND1', null);
    });

    expect(outcome).toMatchObject({ ok: false, message: 'RECEIPT_FORBIDDEN' });
  });

  it.each([
    ['an admin', () => adminActor()],
    ['root', (): Actor => ({ role: 'ROOT', userId: root.id })],
  ])(
    'confirms a refused receipt with its number and its link, by %s, and stops its tries',
    async (_who, actor) => {
      const result = await inRolledBackTx(async (db) => {
        const { orderId, receipt } = await refusedReceiptOf(db);
        const who = actor();
        await db.as(who);
        const done = await db.attempt(
          CONFIRM,
          receipt.id,
          'fiskaly',
          '  A-HAND1 ',
          'https://check.example/hand',
        );
        return { done, who, row: (await docsOf(db, orderId)).find((d) => d.id === receipt.id)! };
      });

      expect(result.done.ok).toBe(true);
      expect(result.row).toMatchObject({
        receiptState: 'manual',
        receiptNumber: 'A-HAND1',
        receiptUrl: 'https://check.example/hand',
        receiptConfirmedById: result.who.userId,
        provider: 'fiskaly',
        due: null,
      });
    },
  );

  // the link is shown to the buyer: another scheme than https is refused, nothing is written
  it.each(['javascript:alert(1)', 'http://check.example/hand', 'https://check example/hand'])(
    'does not confirm a receipt with the link %p: RECEIPT_RESULT_INVALID',
    async (url) => {
      const result = await inRolledBackTx(async (db) => {
        const { orderId, receipt } = await refusedReceiptOf(db);
        await db.as(adminActor());
        const done = await db.attempt(CONFIRM, receipt.id, 'fiskaly', 'A-HAND1', url);
        return { done, row: (await docsOf(db, orderId)).find((d) => d.id === receipt.id)! };
      });

      expect(result.done).toMatchObject({ ok: false, message: 'RECEIPT_RESULT_INVALID' });
      expect(result.row).toMatchObject({ receiptState: 'refused', receiptUrl: null });
    },
  );

  it('confirms a receipt that waits, the provider of the app named for one never sent', async () => {
    const row = await inRolledBackTx(async (db) => {
      await shopOf(db, 'payment');
      const orderId = await paidOrder(db);
      const receipt = (await docsOf(db, orderId)).find((d) => d.kind === 'receipt')!;
      await db.as(adminActor());
      await db.attempt(CONFIRM, receipt.id, 'fiskaly', 'A-HAND2', null);
      return (await docsOf(db, orderId)).find((d) => d.id === receipt.id)!;
    });

    expect(row).toMatchObject({ receiptState: 'manual', provider: 'fiskaly', receiptUrl: null });
  });

  it('does not confirm a receipt registered or confirmed already: RECEIPT_STATE_INVALID', async () => {
    const result = await inRolledBackTx(async (db) => {
      const { receipt } = await refusedReceiptOf(db);
      await db.as(adminActor());
      await db.attempt(CONFIRM, receipt.id, 'fiskaly', 'A-HAND1', null);
      const twice = await db.attempt(CONFIRM, receipt.id, 'fiskaly', 'A-HAND3', null);

      await shopOf(db, 'payment');
      const other = (await docsOf(db, await paidOrder(db))).find((d) => d.kind === 'receipt')!;
      await db.as(SYSTEM);
      await record(db, other.id, 'registered', { number: 'A-CSV9' });
      await db.as(adminActor());
      const registered = await db.attempt(CONFIRM, other.id, 'fiskaly', 'A-HAND4', null);
      return { twice, registered };
    });

    expect(result.twice).toMatchObject({ ok: false, message: 'RECEIPT_STATE_INVALID' });
    expect(result.registered).toMatchObject({ ok: false, message: 'RECEIPT_STATE_INVALID' });
  });

  it.each([
    ['no number', '   '],
    ['a number longer than 100', 'A'.repeat(101)],
  ])('takes no confirmation with %s: RECEIPT_RESULT_INVALID', async (_name, number) => {
    const outcome = await inRolledBackTx(async (db) => {
      const { receipt } = await refusedReceiptOf(db);
      await db.as(adminActor());
      return db.attempt(CONFIRM, receipt.id, 'fiskaly', number, null);
    });

    expect(outcome).toMatchObject({ ok: false, message: 'RECEIPT_RESULT_INVALID' });
  });

  it('is no step for an invoice: RECEIPT_NOT_FOUND', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const { receipt } = await refusedReceiptOf(db);
      await db.as(adminActor());
      return db.attempt(CONFIRM, receipt.documentId, 'fiskaly', 'A-HAND5', null);
    });

    expect(outcome).toMatchObject({ ok: false, message: 'RECEIPT_NOT_FOUND' });
  });
});

describe('a receipt is kept as it was made', () => {
  it('lets the owner change only what the provider answered: not the copies, not the sums, never a removal', async () => {
    const result = await inOwnerTx(async (owner) => {
      const db = asDbSession(owner);
      await shopOf(db, 'payment');
      const orderId = await paidOrder(db);
      const receipt = (await docsOf(db, orderId)).find((d) => d.kind === 'receipt')!;
      await db.as(SYSTEM);
      const answer = await db.attempt(
        `update cartlify.tax_documents set "receiptState" = 'registered', provider = 'fiskaly',
           "receiptNumber" = 'A-OWN', "receiptNextAt" = null where id = $1`,
        receipt.id,
      );
      const sums = await db.attempt(
        `update cartlify.tax_documents set gross = gross + 1, net = net + 1 where id = $1`,
        receipt.id,
      );
      const copies = await db.attempt(
        `update cartlify.tax_documents set lines = '[]'::jsonb where id = $1`,
        receipt.id,
      );
      const removed = await db.attempt(
        `delete from cartlify.tax_documents where id = $1`,
        receipt.id,
      );
      const [left] = await db.rows<{ n: number }>(
        'select count(*)::int as n from cartlify.tax_documents where id = $1',
        receipt.id,
      );
      return { answer, sums, copies, removed, left: left!.n };
    });

    expect(result.answer.ok).toBe(true);
    expect(result.sums).toMatchObject({ ok: false, message: 'TAX_DOCUMENT_APPEND_ONLY' });
    expect(result.copies).toMatchObject({ ok: false, message: 'TAX_DOCUMENT_APPEND_ONLY' });
    expect(result.left).toBe(1);
  });
});
