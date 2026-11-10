import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inCommittedTx, inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { cartOf, confirm, pay, paidOrderOf, waitingOrderOf } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the right to withdraw from a purchase in the database: what a contract and a privacy policy
// have to say when root publishes them, the time an order was delivered (set by the database
// alone), the end of the period of withdrawal counted by one function, and the term of the
// contract in force that an order keeps when it is confirmed. All in transactions that roll back

let buyer: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ price: 10, stock: 20 });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

type Fields = Record<string, unknown>;

const CONTRACT: Fields = {
  withdrawalDays: 14,
  returnAddress: 'Returns, 1 Main Street, Madrid',
  returnShippingPaidBy: 'buyer',
};

const PRIVACY: Fields = {
  retentionLoginAddressesDays: 90,
  retentionGuestDataDays: 180,
  retentionDeletedChatsDays: 30,
  retentionReturnAddressesDays: 1095,
  retentionReturnPersonalDays: 3650,
  retentionRecipientDays: 3650,
  retentionNewsletterConsentDays: 3650,
  retentionNewsletterRecipientsDays: 365,
};

const ENUMS: Record<string, string> = { returnShippingPaidBy: 'cartlify."ReturnShippingPayer"' };

// publishes a version with the columns given; root does it
async function publish(
  db: DbSession,
  kind: 'terms' | 'contract' | 'privacy',
  fields: Fields = {},
  as: { role: 'ROOT' | 'ADMIN'; userId: number } = { role: 'ROOT', userId: root.id },
) {
  await db.as(as);
  const names = [
    'kind',
    'title',
    'content',
    '"publishedById"',
    ...Object.keys(fields).map((k) => `"${k}"`),
  ];
  const values = Object.values(fields);
  const marks = [
    '$1::cartlify."LegalDocumentKind"',
    '$2',
    '$3',
    '$4',
    ...Object.keys(fields).map((key, i) => `$${i + 5}${ENUMS[key] ? `::${ENUMS[key]}` : ''}`),
  ];

  return db.attempt<{ id: number; version: number }>(
    `insert into cartlify.legal_documents (${names.join(', ')})
     values (${marks.join(', ')}) returning id, version`,
    kind,
    `The ${kind}`,
    `The text of the ${kind}.`,
    as.userId,
    ...values,
  );
}

const CHECK_VIOLATION = '23514';
const STRING_TOO_LONG = '22001';

describe('a contract', () => {
  it('is published with the term of withdrawal, the address of returns and who pays the way back', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const published = await publish(db, 'contract', CONTRACT);
      if (!published.ok) return published;
      const rows = await db.rows<Fields>(
        `select "withdrawalDays", "returnAddress", "returnShippingPaidBy"::text as "returnShippingPaidBy"
         from cartlify.legal_documents where id = $1`,
        published.rows[0]!.id,
      );
      return { ok: true as const, rows };
    });

    expect(outcome).toEqual({ ok: true, rows: [CONTRACT] });
  });

  it.each([
    ['without a term of withdrawal', { ...CONTRACT, withdrawalDays: undefined }],
    ['without an address of returns', { ...CONTRACT, returnAddress: undefined }],
    ['without who pays the way back', { ...CONTRACT, returnShippingPaidBy: undefined }],
    ['with a term under 14 days', { ...CONTRACT, withdrawalDays: 13 }],
    ['with a term of a century', { ...CONTRACT, withdrawalDays: 36501 }],
    ['with an address of spaces only', { ...CONTRACT, returnAddress: '   ' }],
    ['with an address with spaces at its edges', { ...CONTRACT, returnAddress: ' Madrid ' }],
  ])('is refused %s', async (_case, fields) => {
    const given = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    const outcome = await inRolledBackTx((db) => publish(db, 'contract', given));

    expect(outcome).toMatchObject({ ok: false, code: CHECK_VIOLATION });
  });

  it('is refused with an address over 500 characters, which the column does not hold', async () => {
    const outcome = await inRolledBackTx((db) =>
      publish(db, 'contract', { ...CONTRACT, returnAddress: 'a'.repeat(501) }),
    );

    expect(outcome).toMatchObject({ ok: false, code: STRING_TOO_LONG });
  });

  it.each([
    ['14 days', 14],
    ['a long term', 365],
  ])('takes %s', async (_case, days) => {
    const outcome = await inRolledBackTx((db) =>
      publish(db, 'contract', { ...CONTRACT, withdrawalDays: days }),
    );

    expect(outcome.ok).toBe(true);
  });

  it.each([
    ['the terms', 'terms', CONTRACT],
    ['the privacy policy', 'privacy', { ...PRIVACY, ...CONTRACT }],
    [
      'the contract, with a term of the consents to the newsletters',
      'contract',
      { ...CONTRACT, retentionNewsletterConsentDays: 30 },
    ],
    [
      'the contract, with a term of the recipients of the newsletters',
      'contract',
      { ...CONTRACT, retentionNewsletterRecipientsDays: 30 },
    ],
    [
      'the terms, with a term of the consents to the newsletters',
      'terms',
      { retentionNewsletterConsentDays: 30 },
    ],
    [
      'the terms, with a term of the recipients of the newsletters',
      'terms',
      { retentionNewsletterRecipientsDays: 30 },
    ],
  ] as const)(
    'is the only kind that holds its fields: %s refuse them',
    async (_name, kind, fields) => {
      const outcome = await inRolledBackTx((db) => publish(db, kind, fields));

      expect(outcome).toMatchObject({ ok: false, code: CHECK_VIOLATION });
    },
  );
});

describe('a privacy policy', () => {
  it('is published with the terms of keeping each kind of data, in days', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const published = await publish(db, 'privacy', PRIVACY);
      if (!published.ok) return published;
      const rows = await db.rows<Fields>(
        `select "retentionLoginAddressesDays", "retentionGuestDataDays", "retentionDeletedChatsDays",
                "retentionReturnAddressesDays", "retentionReturnPersonalDays", "retentionRecipientDays",
                "retentionNewsletterConsentDays", "retentionNewsletterRecipientsDays"
         from cartlify.legal_documents where id = $1`,
        published.rows[0]!.id,
      );
      return { ok: true as const, rows };
    });

    expect(outcome).toEqual({ ok: true, rows: [PRIVACY] });
  });

  it.each(Object.keys(PRIVACY))('is refused without %s', async (field) => {
    const { [field]: _left, ...rest } = PRIVACY;
    const outcome = await inRolledBackTx((db) => publish(db, 'privacy', rest));

    expect(outcome).toMatchObject({ ok: false, code: CHECK_VIOLATION });
  });

  it.each(Object.keys(PRIVACY))('is refused with %s of no days or of a century', async (field) => {
    const none = await inRolledBackTx((db) => publish(db, 'privacy', { ...PRIVACY, [field]: 0 }));
    const century = await inRolledBackTx((db) =>
      publish(db, 'privacy', { ...PRIVACY, [field]: 36501 }),
    );

    expect(none).toMatchObject({ ok: false, code: CHECK_VIOLATION });
    expect(century).toMatchObject({ ok: false, code: CHECK_VIOLATION });
  });

  it('is numbered on its own, as the other kinds are', async () => {
    const versions = await inRolledBackTx(async (db) => {
      const first = await publish(db, 'privacy', PRIVACY);
      const second = await publish(db, 'privacy', PRIVACY);
      return [first, second].map((outcome) => (outcome.ok ? outcome.rows[0]!.version : null));
    });

    expect(versions[1]).toBe(versions[0]! + 1);
  });

  it('is not accepted by anybody: it informs, the database refuses a consent to it', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const published = await publish(db, 'privacy', PRIVACY);
      if (!published.ok) throw new Error(`publishing failed: ${published.message}`);
      await db.as({ role: 'USER', userId: buyer.id });
      return db.attempt(
        `insert into cartlify.legal_acceptances ("userId", "documentId", event)
         values ($1, $2, 'consent.accept') returning id`,
        buyer.id,
        published.rows[0]!.id,
      );
    });

    expect(outcome).toMatchObject({
      ok: false,
      code: CHECK_VIOLATION,
      message: expect.stringContaining('LEGAL_DOCUMENT_NOT_ACCEPTABLE'),
    });
  });

  it('is published by root only', async () => {
    const outcome = await inRolledBackTx((db) =>
      publish(db, 'privacy', PRIVACY, { role: 'ADMIN', userId: admin.id }),
    );

    expect(outcome.ok).toBe(false);
  });
});

// a paid order of the buyer, and a step of the admin on it
async function paidOrder(db: DbSession): Promise<number> {
  return paidOrderOf(db, buyer.id, admin.id, [[product.variantId, 1]]);
}

const stepTo = (db: DbSession, orderId: number, status: string, set = '') =>
  db.attempt(
    `update cartlify.orders set status = '${status}'${set ? `, ${set}` : ''} where id = $1 returning id`,
    orderId,
  );

// when the order was delivered and the time of the transaction, as the columns hold them (utc
// without a zone, to the millisecond)
async function deliveredAtOf(db: DbSession, orderId: number) {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const [row] = await db.rows<{ deliveredAt: string | null; now: string }>(
    `select "deliveredAt"::text as "deliveredAt",
            (now() at time zone 'UTC')::timestamp(3)::text as now
     from cartlify.orders where id = $1`,
    orderId,
  );
  return row!;
}

describe('the time an order was delivered', () => {
  it('is none before the order is delivered', async () => {
    const { paid, shipped } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      const paid = await deliveredAtOf(db, orderId);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await stepTo(db, orderId, 'shipped');
      return { paid, shipped: await deliveredAtOf(db, orderId) };
    });

    expect(paid.deliveredAt).toBeNull();
    expect(shipped.deliveredAt).toBeNull();
  });

  it('is set by the database when an admin delivers the order', async () => {
    const result = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await stepTo(db, orderId, 'shipped');
      const delivered = await stepTo(db, orderId, 'delivered');
      return { delivered, at: await deliveredAtOf(db, orderId) };
    });

    expect(result.delivered.ok).toBe(true);
    expect(result.at.deliveredAt).toBe(result.at.now);
  });

  // the carrier delivered it before the admin marked it: the admin gives that moment with the step,
  // the period counts from it; never before the send (a send there is not: the payment), never of
  // the future
  it('keeps the moment the admin gives with the step, between the send and now, and refuses one outside', async () => {
    const orderId = await inCommittedTx(async (db) => {
      const id = await paidOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await stepTo(db, id, 'shipped');
      return id;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: admin.id });
      const before = await stepTo(
        db,
        orderId,
        'delivered',
        `"deliveredAt" = "paidAt" - interval '1 second'`,
      );
      const future = await stepTo(
        db,
        orderId,
        'delivered',
        `"deliveredAt" = (now() at time zone 'UTC') + interval '1 day'`,
      );
      const given = await stepTo(
        db,
        orderId,
        'delivered',
        `"deliveredAt" = "paidAt" + interval '10 milliseconds'`,
      );
      const [row] = await db.rows<{ deliveredAt: string; expected: string }>(
        `select "deliveredAt"::text as "deliveredAt",
                ("paidAt" + interval '10 milliseconds')::text as expected
         from cartlify.orders where id = $1`,
        orderId,
      );
      return { before, future, given, row: row! };
    });

    for (const refused of [result.before, result.future]) {
      expect(refused).toMatchObject({
        ok: false,
        message: expect.stringContaining('ORDER_DELIVERED_AT_INVALID'),
      });
    }
    expect(result.given.ok).toBe(true);
    expect(result.row.deliveredAt).toBe(result.row.expected);
  });

  it('goes with a step back and comes again with the next delivery', async () => {
    const { back, again } = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await stepTo(db, orderId, 'shipped');
      await stepTo(db, orderId, 'delivered');
      await stepTo(db, orderId, 'shipped');
      const back = await deliveredAtOf(db, orderId);
      await stepTo(db, orderId, 'delivered');
      return { back, again: await deliveredAtOf(db, orderId) };
    });

    expect(back.deliveredAt).toBeNull();
    expect(again.deliveredAt).toBe(again.now);
  });

  it.each([
    ['a delivered order', true],
    ['a shipped order', false],
  ])('is not written by hand on %s', async (_case, delivered) => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await stepTo(db, orderId, 'shipped');
      if (delivered) await stepTo(db, orderId, 'delivered');
      return db.attempt(
        `update cartlify.orders set "deliveredAt" = now() - interval '3 days' where id = $1 returning id`,
        orderId,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  it('is not written by the buyer', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const orderId = await paidOrder(db);
      await db.as({ role: 'USER', userId: buyer.id });
      return db.attempt(
        `update cartlify.orders set "deliveredAt" = now() where id = $1 returning id`,
        orderId,
      );
    });

    expect(outcome.ok === false || outcome.rows.length === 0).toBe(true);
  });
});

// the end of the period of withdrawal: the end of the last day, in the time zone of the shop,
// of the days of the contract and of the days of grace counted after the day of the delivery
async function endOf(
  db: DbSession,
  deliveredAt: string | null,
  days: number,
  grace: number,
  timeZone: string,
) {
  const [row] = await db.rows<{ end: string | null }>(
    `select cartlify.withdrawal_ends_at($1::timestamp, $2::int, $3::int, $4)::text as "end"`,
    deliveredAt,
    days,
    grace,
    timeZone,
  );
  return row!.end;
}

describe('the end of the period of withdrawal', () => {
  it.each([
    // delivered on 3 March at 15:00 utc (16:00 in Madrid): 14 days end on 17 March at midnight
    [
      'the end of the last day',
      '2026-03-03 15:00:00',
      14,
      0,
      'Europe/Madrid',
      '2026-03-17 22:59:59.999',
    ],
    [
      'the days of grace on top',
      '2026-03-03 15:00:00',
      14,
      4,
      'Europe/Madrid',
      '2026-03-21 22:59:59.999',
    ],
    // 23:30 utc is already the next day in Madrid: that day is the day of the delivery
    [
      'the day of the shop, not the utc day',
      '2026-03-03 23:30:00',
      14,
      0,
      'Europe/Madrid',
      '2026-03-18 22:59:59.999',
    ],
    // the clocks go forward on 29 March: the last day ends one hour earlier in utc
    ['summer time', '2026-03-20 12:00:00', 14, 0, 'Europe/Madrid', '2026-04-03 21:59:59.999'],
    [
      'a zone behind utc',
      '2026-03-03 02:00:00',
      14,
      0,
      'America/New_York',
      '2026-03-17 03:59:59.999',
    ],
    ['utc', '2026-03-03 15:00:00', 14, 0, 'UTC', '2026-03-17 23:59:59.999'],
    ['a long term', '2026-03-03 15:00:00', 30, 0, 'UTC', '2026-04-02 23:59:59.999'],
  ])('is %s', async (_case, deliveredAt, days, grace, timeZone, expected) => {
    const end = await inRolledBackTx((db) => endOf(db, deliveredAt, days, grace, timeZone));

    expect(end).toBe(expected);
  });

  it('is none for an order that is not delivered', async () => {
    const end = await inRolledBackTx((db) => endOf(db, null, 14, 4, 'Europe/Madrid'));

    expect(end).toBeNull();
  });

  it('refuses a zone it does not know', async () => {
    const outcome = await inRolledBackTx((db) =>
      db.attempt(`select cartlify.withdrawal_ends_at(now()::timestamp, 14, 0, 'Nowhere/Land')`),
    );

    expect(outcome.ok).toBe(false);
  });
});

type Kept = { withdrawalDays: number | null; returnShippingPaidBy: string | null };

const keptBy = async (db: DbSession, orderId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const [row] = await db.rows<Kept>(
    `select "withdrawalDays", "returnShippingPaidBy"::text as "returnShippingPaidBy"
     from cartlify.orders where id = $1`,
    orderId,
  );
  return row!;
};

describe('the term of the contract an order keeps', () => {
  it('is none while the order is a cart', async () => {
    const kept = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, buyer.id, [[product.variantId, 1]]);
      return keptBy(db, orderId);
    });

    expect(kept).toEqual({ withdrawalDays: null, returnShippingPaidBy: null });
  });

  it('is the term and the payer of the contract in force at the confirmation', async () => {
    const kept = await inRolledBackTx(async (db) => {
      await publish(db, 'contract', {
        ...CONTRACT,
        withdrawalDays: 21,
        returnShippingPaidBy: 'shop',
      });
      const orderId = await waitingOrderOf(db, buyer.id, [[product.variantId, 1]]);
      return keptBy(db, orderId);
    });

    expect(kept).toEqual({ withdrawalDays: 21, returnShippingPaidBy: 'shop' });
  });

  it('is the one of the latest version when several were published', async () => {
    const kept = await inRolledBackTx(async (db) => {
      await publish(db, 'contract', {
        ...CONTRACT,
        withdrawalDays: 14,
        returnShippingPaidBy: 'buyer',
      });
      await publish(db, 'contract', {
        ...CONTRACT,
        withdrawalDays: 30,
        returnShippingPaidBy: 'shop',
      });
      const orderId = await waitingOrderOf(db, buyer.id, [[product.variantId, 1]]);
      return keptBy(db, orderId);
    });

    expect(kept).toEqual({ withdrawalDays: 30, returnShippingPaidBy: 'shop' });
  });

  it('does not change when a newer version is published after the confirmation', async () => {
    const kept = await inRolledBackTx(async (db) => {
      await publish(db, 'contract', {
        ...CONTRACT,
        withdrawalDays: 21,
        returnShippingPaidBy: 'shop',
      });
      const orderId = await waitingOrderOf(db, buyer.id, [[product.variantId, 1]]);
      await publish(db, 'contract', {
        ...CONTRACT,
        withdrawalDays: 60,
        returnShippingPaidBy: 'buyer',
      });
      return keptBy(db, orderId);
    });

    expect(kept).toEqual({ withdrawalDays: 21, returnShippingPaidBy: 'shop' });
  });

  it('is read under the shared lock of the contract kind, which a version being published waits for', async () => {
    const held = async (db: DbSession) => {
      const [row] = await db.rows<{ n: number }>(
        `select count(*)::int as n from pg_locks
         where locktype = 'advisory' and granted and mode = 'ShareLock' and pid = pg_backend_pid()
           and objid::bigint = (hashtext('cartlify.legal_documents:contract')::bigint & 4294967295)`,
      );
      return row!.n;
    };

    const { before, after } = await inRolledBackTx(async (db) => {
      const orderId = await cartOf(db, buyer.id, [[product.variantId, 1]]);
      const before = await held(db);
      await db.as({ role: 'USER', userId: buyer.id });
      await db.rows(
        `select 1 as done from cartlify.confirm_order($1::int, '15 minutes'::interval, null, null, null)`,
        orderId,
      );
      return { before, after: await held(db) };
    });

    expect({ before, after }).toEqual({ before: 0, after: 1 });
  });

  it('is not changed by the terms or the privacy policy being the latest version published', async () => {
    const kept = await inRolledBackTx(async (db) => {
      await publish(db, 'contract', {
        ...CONTRACT,
        withdrawalDays: 21,
        returnShippingPaidBy: 'shop',
      });
      await publish(db, 'terms');
      await publish(db, 'privacy', PRIVACY);
      const orderId = await waitingOrderOf(db, buyer.id, [[product.variantId, 1]]);
      return keptBy(db, orderId);
    });

    expect(kept).toEqual({ withdrawalDays: 21, returnShippingPaidBy: 'shop' });
  });

  it('is the one in force at the payment when the reservation ran out before the payment came', async () => {
    const kept = await inRolledBackTx(async (db) => {
      await publish(db, 'contract', {
        ...CONTRACT,
        withdrawalDays: 30,
        returnShippingPaidBy: 'shop',
      });
      const orderId = await cartOf(db, buyer.id, [[product.variantId, 1]]);
      await confirm(db, buyer.id, orderId, '1 millisecond');
      // the reservation is over: the order is a cart again and keeps no term
      await db.rows('select 1 as done from pg_sleep(0.05)');
      await db.as({ role: 'ADMIN' });
      await db.rows(`select 1 as done from cartlify.expire_order_reservation($1::int)`, orderId);
      const unconfirmed = await keptBy(db, orderId);
      // the payment of the page comes late: the order is paid all the same
      const paid = await pay(db, admin.id, orderId);
      return { unconfirmed, paid, kept: await keptBy(db, orderId) };
    });

    expect(kept.unconfirmed).toEqual({ withdrawalDays: null, returnShippingPaidBy: null });
    expect(kept.paid).toBe('PAID');
    expect(kept.kept).toEqual({ withdrawalDays: 30, returnShippingPaidBy: 'shop' });
  });

  it('is kept when the order is paid, shipped and delivered', async () => {
    const kept = await inRolledBackTx(async (db) => {
      await publish(db, 'contract', {
        ...CONTRACT,
        withdrawalDays: 21,
        returnShippingPaidBy: 'shop',
      });
      const orderId = await paidOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      await stepTo(db, orderId, 'shipped');
      await stepTo(db, orderId, 'delivered');
      return keptBy(db, orderId);
    });

    expect(kept).toEqual({ withdrawalDays: 21, returnShippingPaidBy: 'shop' });
  });

  it.each([
    ['the term', '"withdrawalDays" = 99'],
    ['the payer', `"returnShippingPaidBy" = 'shop'`],
  ])('is not changed by an admin: %s', async (_case, set) => {
    const outcome = await inRolledBackTx(async (db) => {
      await publish(db, 'contract', CONTRACT);
      const orderId = await paidOrder(db);
      await db.as({ role: 'ADMIN', userId: admin.id });
      return db.attempt(`update cartlify.orders set ${set} where id = $1 returning id`, orderId);
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });
});
