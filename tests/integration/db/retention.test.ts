import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import {
  cartOf,
  paidOrderOf,
  PICKUP,
  waitingOrderOf,
  type DeliveryData,
  type Items,
} from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';
import { cancelAndRefundIn, refundReturnIn } from '../../helpers/returns.js';

// how long the shop keeps what it needs no longer: the address and the browser of old logins, the
// favorites and chats of guests who stopped coming, the chats of accounts deleted long ago, the
// address and the browser of closed statements of return, their personal data, the recipient of
// the orders of deleted accounts, and what the newsletters leave (the requests that were not
// confirmed, the proof of the consent of an ended subscription, the mails of a campaign; their
// cases are in newsletterRetention.test.ts). The days are in the privacy policy of the shop, one
// column for each kind; a function takes none. A row is kept for the shorter of the term of the version in force when
// the data was collected and the term of the version in force now, and is cleaned a day before the
// term ends. Each function is the work of the system; the periodic tasks of Railway run them.
//
// Everything runs in transactions that roll back, so the version of the policy a test publishes is
// seen by that test only. A published version cannot be dated back, and the data a test makes is
// some days older than any version in the database, so only the version of the test counts for it
// (the data collected before the first version follows the newest one). A cleanup works on every
// row of the database, not only on the rows of the test: the counts say "at least", the rows of the
// test are checked one by one.

let user: TestUser;
let admin: TestUser;
let root: TestUser;
// the buyer of the statements of return and the owner of the guests' favorites
let buyer: TestUser;
// the accounts that get deleted in a test (the deletion rolls back with the test), and one that lives
let leaver: TestUser;
let leaver2: TestUser;
let living: TestUser;
let product: TestProduct;
// the three items of the order a statement of return is made of
let parts: TestProduct[];

beforeAll(async () => {
  user = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  buyer = await createUser({ name: 'Anna Koval' });
  leaver = await createUser();
  leaver2 = await createUser();
  living = await createUser();
  product = await createProduct({ price: 10, stock: 80 });
  parts = [
    await createProduct({ price: 10, stock: 10 }),
    await createProduct({ price: 10, stock: 10 }),
    await createProduct({ price: 10, stock: 10 }),
  ];
});

afterAll(async () => {
  try {
    await removeProducts([product, ...parts]);
    await closeSessions([user.id, admin.id, root.id, buyer.id, leaver.id, leaver2.id, living.id]);
  } finally {
    await prisma.$disconnect();
  }
});

// the system acts as an admin without an id
const asSystem = (): Actor => ({ role: 'ADMIN' });
const adminActor = (): Actor => ({ role: 'ADMIN', userId: admin.id });
const rootActor = (): Actor => ({ role: 'ROOT', userId: root.id });
const buyerActor = (): Actor => ({ role: 'USER', userId: buyer.id });

// a moment some days (and minutes) before the transaction, utc the way the columns keep it. A cleanup
// counts from the same moment, so a row at the edge of a term is put a minute to either side of it
const daysAgo = (days: number, minutes = 0) =>
  `((now() at time zone 'UTC') - make_interval(days => ${days}, mins => ${minutes}))`;

const NOW = `(now() at time zone 'UTC')`;

type Terms = {
  loginAddresses: number;
  guestData: number;
  deletedChats: number;
  returnAddresses: number;
  returnPersonal: number;
  recipient: number;
  newsletterConsent: number;
  newsletterRecipients: number;
};

const TERMS: Terms = {
  loginAddresses: 90,
  guestData: 90,
  deletedChats: 30,
  returnAddresses: 30,
  returnPersonal: 30,
  recipient: 30,
  newsletterConsent: 3650,
  newsletterRecipients: 365,
};

// root publishes a version of the privacy policy with the terms given (the rest as in TERMS); the
// database dates it when it is written, later than the moment the transaction began
async function publishPolicy(db: DbSession, terms: Partial<Terms> = {}) {
  const t = { ...TERMS, ...terms };
  await db.as(rootActor());
  const [row] = await db.rows<{ id: number; version: number; createdAt: string }>(
    `insert into cartlify.legal_documents
       (kind, title, content, "publishedById", "retentionLoginAddressesDays",
        "retentionGuestDataDays", "retentionDeletedChatsDays", "retentionReturnAddressesDays",
        "retentionReturnPersonalDays", "retentionRecipientDays",
        "retentionNewsletterConsentDays", "retentionNewsletterRecipientsDays")
     values ('privacy'::cartlify."LegalDocumentKind", 'The privacy policy',
             'The text of the privacy policy.', $1, $2, $3, $4, $5, $6, $7, $8, $9)
     returning id, version, "createdAt"::text as "createdAt"`,
    root.id,
    t.loginAddresses,
    t.guestData,
    t.deletedChats,
    t.returnAddresses,
    t.returnPersonal,
    t.recipient,
    t.newsletterConsent,
    t.newsletterRecipients,
  );
  return row!;
}

const call = (db: DbSession, fn: string) =>
  db.attempt<Record<string, unknown>>(`select * from cartlify.${fn}()`);

// the system runs a cleanup; the row it gives back
async function cleanup(db: DbSession, fn: string) {
  await db.as(asSystem());
  const outcome = await call(db, fn);
  if (!outcome.ok) throw new Error(`${fn} refused: ${outcome.message}`);
  return outcome.rows[0]!;
}

// a cleanup that gives a count: how many rows it cleaned
const cleaned = async (db: DbSession, fn: string) => Number((await cleanup(db, fn))[fn]);

// A statement is closed at the moment of the transaction, which the column keeps to the millisecond,
// rounded. A moment that rounds up is a hair after the moment the cleanup counts from (the
// microsecond of the same transaction), so the statement is not due even with a term of one day. The
// test starts again in a transaction whose moment rounds down; nothing is done in the one it leaves
async function inRoundedTx<T>(fn: (db: DbSession) => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const done = await inRolledBackTx(async (db) => {
      const [row] = await db.rows<{ rounds: boolean }>(
        `select ${NOW}::timestamp(3) <= ${NOW} as rounds`,
      );
      return row!.rounds ? { result: await fn(db) } : null;
    });
    if (done) return done.result;
  }
  throw new Error('no transaction began at a moment that rounds down');
}

describe.each([
  ['cleanup_login_log_addresses'],
  ['cleanup_guest_data'],
  ['cleanup_deleted_accounts_chats'],
  ['cleanup_return_addresses'],
  ['cleanup_return_personal'],
  ['cleanup_deleted_accounts_recipients'],
  ['cleanup_newsletter_pending'],
  ['cleanup_newsletter_consent'],
  ['cleanup_newsletter_recipients'],
])('cartlify.%s', (fn) => {
  it.each([
    ['a signed-in admin', () => adminActor()],
    ['root', () => rootActor()],
    ['a user', () => ({ role: 'USER', userId: user.id }) as Actor],
    ['a guest', () => ({ role: 'GUEST', guestId: randomUUID() }) as Actor],
    ['nobody', () => null],
  ])('is the work of the system, %s gets a refusal', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      await publishPolicy(db);
      await db.as(actor());
      return call(db, fn);
    });

    expect(outcome).toMatchObject({ ok: false, message: 'RETENTION_CLEANUP_FORBIDDEN' });
  });

  it('is not left in the old form, with the days to keep as an argument', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asSystem());
      return db.attempt(`select * from cartlify.${fn}(30)`);
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('cartlify.cleanup_login_log_addresses', () => {
  // a login line of the user, written the way a login writes it, some days ago
  const loginOf = async (db: DbSession, days: number, minutes = 0) => {
    await db.as({ role: 'USER', userId: user.id });
    const [row] = await db.rows<{ id: number }>(
      `insert into cartlify.login_logs ("userId", email, role, "ipAddress", "userAgent", event, "createdAt")
       values ($1, $2, 'USER', '203.0.113.7', 'Test browser', 'login.password', ${daysAgo(days, minutes)})
       returning id`,
      user.id,
      user.email,
    );
    return row!.id;
  };

  type Line = {
    id: number;
    userId: number;
    email: string;
    role: string;
    event: string;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: string;
  };

  const linesOf = async (db: DbSession, ids: number[]) => {
    await db.as(rootActor());
    return db.rows<Line>(
      `select id, "userId", email, role::text as role, event::text as event, "ipAddress", "userAgent",
              "createdAt"::text as "createdAt"
       from cartlify.login_logs where id = any($1::int[]) order by id`,
      ids,
    );
  };

  const addressesOf = async (db: DbSession, ids: number[]) =>
    (await linesOf(db, ids)).map((line) => [line.ipAddress, line.userAgent]);

  const EMPTY = [null, null];
  const KEPT = ['203.0.113.7', 'Test browser'];

  it('forgets the address and the browser of the logins older than the term, the rest stays', async () => {
    const { lines, before } = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { loginAddresses: 90 });
      const old = await loginOf(db, 100);
      const recent = await loginOf(db, 80);
      const before = await linesOf(db, [old, recent]);

      await cleanup(db, 'cleanup_login_log_addresses');
      return { lines: await linesOf(db, [old, recent]), before };
    });

    expect(before.map((line) => [line.ipAddress, line.userAgent])).toEqual([KEPT, KEPT]);
    expect(lines.map((line) => [line.ipAddress, line.userAgent])).toEqual([EMPTY, KEPT]);
  });

  // the line is history: who logged in, when, with which role stay, only the two fields are emptied
  it('keeps the line itself: who, when and with which role', async () => {
    const { before, after } = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { loginAddresses: 90 });
      const old = await loginOf(db, 100);
      const before = await linesOf(db, [old]);

      await cleanup(db, 'cleanup_login_log_addresses');
      return { before, after: await linesOf(db, [old]) };
    });

    expect(after).toEqual(before.map((line) => ({ ...line, ipAddress: null, userAgent: null })));
  });

  // cleaned a day before the term ends: a task that runs once a day never cleans late
  it('cleans a day before the term ends, a minute short of that it waits', async () => {
    const addresses = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { loginAddresses: 90 });
      const due = await loginOf(db, 89, 1);
      const notYet = await loginOf(db, 89, -1);

      await cleanup(db, 'cleanup_login_log_addresses');
      return addressesOf(db, [due, notYet]);
    });

    expect(addresses).toEqual([EMPTY, KEPT]);
  });

  it('cleans at once with a term of one day', async () => {
    const addresses = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { loginAddresses: 1 });
      const today = await loginOf(db, 0, 1);

      await cleanup(db, 'cleanup_login_log_addresses');
      return addressesOf(db, [today]);
    });

    expect(addresses).toEqual([EMPTY]);
  });

  it('keeps a login of today with a term of two days, and cleans one of yesterday', async () => {
    const addresses = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { loginAddresses: 2 });
      const today = await loginOf(db, 0, 1);
      const yesterday = await loginOf(db, 1, 1);

      await cleanup(db, 'cleanup_login_log_addresses');
      return addressesOf(db, [today, yesterday]);
    });

    expect(addresses).toEqual([KEPT, EMPTY]);
  });

  // a login from before the first version follows the newest one: a later version with a longer term
  // keeps what an earlier one would have cleaned, a shorter one cleans what an earlier one kept
  it.each([
    ['a longer', 30, 1000, KEPT],
    ['a shorter', 1000, 30, EMPTY],
  ])(
    'follows the newest version for a login from before the first one, %s term there',
    async (_case, first, newest, expected) => {
      const addresses = await inRolledBackTx(async (db) => {
        await publishPolicy(db, { loginAddresses: first });
        await publishPolicy(db, { loginAddresses: newest });
        const old = await loginOf(db, 100);

        await cleanup(db, 'cleanup_login_log_addresses');
        return addressesOf(db, [old]);
      });

      expect(addresses).toEqual([expected]);
    },
  );

  it('says how many lines it emptied, and has none to empty the second time', async () => {
    const counts = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { loginAddresses: 90 });
      await loginOf(db, 100);
      await loginOf(db, 120);
      await loginOf(db, 10);

      const first = await cleaned(db, 'cleanup_login_log_addresses');
      return { first, second: await cleaned(db, 'cleanup_login_log_addresses') };
    });

    expect(counts.first).toBeGreaterThanOrEqual(2);
    expect(counts.second).toBe(0);
  });

  // the log stays history: the cleanup is the one way to empty these two fields, nothing else
  it('gives no role of the app a way to change a login line itself', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await loginOf(db, 91);
      await db.as(asSystem());
      return db.attempt(
        'update cartlify.login_logs set "ipAddress" = null where id = $1 returning id',
        id,
      );
    });

    expect(outcome.ok && outcome.rows.length > 0).toBe(false);
  });
});

describe('cartlify.cleanup_guest_data', () => {
  // a guest with a favorite and a chat with a message, some days ago (a negative number of
  // minutes puts the moment later)
  const guestWith = async (
    db: DbSession,
    when: { favorite: [days: number, minutes?: number]; chat: [days: number, minutes?: number] },
  ) => {
    const guestId = randomUUID();
    const threadId = randomUUID();
    const favorite = daysAgo(...when.favorite);
    const chat = daysAgo(...when.chat);
    await db.as({ role: 'GUEST', guestId });
    await db.rows(
      `insert into cartlify.favorites ("guestId", "productId", "variantId", "createdAt")
       values ($1::uuid, $2, $3, ${favorite})`,
      guestId,
      product.id,
      product.variantId,
    );
    await db.rows(
      `insert into cartlify.chat_threads (id, "guestId", type, status, "lastMessageAt", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, 'bot', 'open', ${chat}, ${chat}, ${chat})`,
      threadId,
      guestId,
    );
    await db.rows(
      `insert into cartlify.chat_messages ("threadId", "senderType", content, "createdAt")
       values ($1::uuid, 'guest', 'My address is Main street 1', ${chat})`,
      threadId,
    );
    return { guestId, threadId };
  };

  const leftOf = async (db: DbSession, guest: { guestId: string; threadId: string }) => {
    await db.as(asSystem());
    const [row] = await db.rows<{ favorites: number; threads: number; messages: number }>(
      `select
         (select count(*)::int from cartlify.favorites where "guestId" = $1::uuid) as favorites,
         (select count(*)::int from cartlify.chat_threads where id = $2::uuid) as threads,
         (select count(*)::int from cartlify.chat_messages where "threadId" = $2::uuid) as messages`,
      guest.guestId,
      guest.threadId,
    );
    return row!;
  };

  const GONE = { favorites: 0, threads: 0, messages: 0 };
  const WHOLE = { favorites: 1, threads: 1, messages: 1 };

  it('removes the favorites and the chats of a guest who has not come for longer than the term, with the messages', async () => {
    const left = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { guestData: 90 });
      const guest = await guestWith(db, { favorite: [100], chat: [95] });

      await cleanup(db, 'cleanup_guest_data');
      return leftOf(db, guest);
    });

    expect(left).toEqual(GONE);
  });

  // the guest wrote yesterday: the favorite of last year is still theirs
  it('keeps all of a guest who came within the term, old favorites too', async () => {
    const left = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { guestData: 90 });
      const guest = await guestWith(db, { favorite: [300], chat: [1] });

      await cleanup(db, 'cleanup_guest_data');
      return leftOf(db, guest);
    });

    expect(left).toEqual(WHOLE);
  });

  it('counts from the newest of the favorites and the chat: a favorite added lately keeps an old chat', async () => {
    const left = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { guestData: 90 });
      const guest = await guestWith(db, { favorite: [2], chat: [300] });

      await cleanup(db, 'cleanup_guest_data');
      return leftOf(db, guest);
    });

    expect(left).toEqual(WHOLE);
  });

  it('cleans a day before the term ends, a minute short of that it waits', async () => {
    const left = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { guestData: 90 });
      const due = await guestWith(db, { favorite: [89, 1], chat: [89, 1] });
      const notYet = await guestWith(db, { favorite: [89, -1], chat: [89, -1] });

      await cleanup(db, 'cleanup_guest_data');
      return [await leftOf(db, due), await leftOf(db, notYet)];
    });

    expect(left).toEqual([GONE, WHOLE]);
  });

  it('cleans at once with a term of one day, and keeps a guest of today with a term of two', async () => {
    const left = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { guestData: 1 });
      const guest = await guestWith(db, { favorite: [0, 1], chat: [0, 1] });
      await cleanup(db, 'cleanup_guest_data');
      const once = await leftOf(db, guest);

      await publishPolicy(db, { guestData: 2 });
      const other = await guestWith(db, { favorite: [0, 1], chat: [0, 1] });
      await cleanup(db, 'cleanup_guest_data');
      return [once, await leftOf(db, other)];
    });

    expect(left).toEqual([GONE, WHOLE]);
  });

  it('says how many favorites and chats went, and has none the second time', async () => {
    const result = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { guestData: 90 });
      await guestWith(db, { favorite: [100], chat: [95] });

      const first = await cleanup(db, 'cleanup_guest_data');
      return { first, second: await cleanup(db, 'cleanup_guest_data') };
    });

    expect(Number(result.first.removed_favorites)).toBeGreaterThanOrEqual(1);
    expect(Number(result.first.removed_chats)).toBeGreaterThanOrEqual(1);
    expect(result.second).toEqual({ removed_favorites: 0, removed_chats: 0 });
  });

  it('leaves the favorites and the chats of users alone', async () => {
    const left = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { guestData: 90 });
      const threadId = randomUUID();
      await db.as({ role: 'USER', userId: user.id });
      await db.rows(
        `insert into cartlify.favorites ("userId", "productId", "variantId", "createdAt")
         values ($1, $2, $3, ${daysAgo(500)})`,
        user.id,
        product.id,
        product.variantId,
      );
      await db.rows(
        `insert into cartlify.chat_threads (id, "userId", type, status, "lastMessageAt", "createdAt", "updatedAt")
         values ($1::uuid, $2, 'bot', 'closed', ${daysAgo(500)}, ${daysAgo(500)}, ${daysAgo(500)})`,
        threadId,
        user.id,
      );

      await cleanup(db, 'cleanup_guest_data');
      await db.as(rootActor());
      return db.rows<{ favorites: number; threads: number }>(
        `select
           (select count(*)::int from cartlify.favorites
            where "userId" = $1 and "productId" = $2) as favorites,
           (select count(*)::int from cartlify.chat_threads where id = $3::uuid) as threads`,
        user.id,
        product.id,
        threadId,
      );
    });

    expect(left).toEqual([{ favorites: 1, threads: 1 }]);
  });
});

describe('cartlify.cleanup_deleted_accounts_chats', () => {
  // the account is marked deleted some days ago by root
  const markDeleted = async (db: DbSession, who: TestUser, at: string) => {
    await db.as(rootActor());
    await db.rows(`update cartlify.users set "deletedAt" = ${at} where id = $1`, who.id);
  };

  // a chat of the user with a message of theirs, written by the user and closed by root; the
  // thread is dated as asked (SQL of a timestamp), the moment of the transaction without it
  const chatOf = async (db: DbSession, who: TestUser, createdAt: string | null = null) => {
    const threadId = randomUUID();
    await db.as({ role: 'USER', userId: who.id });
    await db.rows(
      `insert into cartlify.chat_threads (id, "userId", type, status, "createdAt")
       values ($1::uuid, $2, 'bot', 'open', coalesce(${createdAt ?? 'null::timestamp'}, ${NOW}))`,
      threadId,
      who.id,
    );
    await db.rows(
      `insert into cartlify.chat_messages ("threadId", "senderId", "senderType", content)
       values ($1::uuid, $2, 'user', 'My phone is +380501234567')`,
      threadId,
      who.id,
    );
    await db.as(rootActor());
    await db.rows(
      `update cartlify.chat_threads set status = 'closed' where id = $1::uuid`,
      threadId,
    );
    return threadId;
  };

  const chatLeft = async (db: DbSession, threadId: string) => {
    await db.as(asSystem());
    const [row] = await db.rows<{ threads: number; messages: number }>(
      `select
         (select count(*)::int from cartlify.chat_threads where id = $1::uuid) as threads,
         (select count(*)::int from cartlify.chat_messages where "threadId" = $1::uuid) as messages`,
      threadId,
    );
    return row!;
  };

  const GONE = { threads: 0, messages: 0 };
  const WHOLE = { threads: 1, messages: 1 };

  it('removes the chats of the accounts deleted longer ago than the term, with their messages', async () => {
    const left = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { deletedChats: 30 });
      const gone = await chatOf(db, leaver);
      await markDeleted(db, leaver, daysAgo(40));

      await cleanup(db, 'cleanup_deleted_accounts_chats');
      return chatLeft(db, gone);
    });

    expect(left).toEqual(GONE);
  });

  it('keeps the chats of an account deleted lately and of an account that lives', async () => {
    const left = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { deletedChats: 30 });
      const lately = await chatOf(db, leaver);
      const alive = await chatOf(db, living);
      await markDeleted(db, leaver, daysAgo(10));

      await cleanup(db, 'cleanup_deleted_accounts_chats');
      return [await chatLeft(db, lately), await chatLeft(db, alive)];
    });

    expect(left).toEqual([WHOLE, WHOLE]);
  });

  it('cleans a day before the term ends, a minute short of that it waits', async () => {
    const left = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { deletedChats: 30 });
      const due = await chatOf(db, leaver);
      const notYet = await chatOf(db, leaver2);
      await markDeleted(db, leaver, daysAgo(29, 1));
      await markDeleted(db, leaver2, daysAgo(29, -1));

      await cleanup(db, 'cleanup_deleted_accounts_chats');
      return [await chatLeft(db, due), await chatLeft(db, notYet)];
    });

    expect(left).toEqual([GONE, WHOLE]);
  });

  it('cleans at once with a term of one day, and keeps the chats of an account deleted today with a term of two', async () => {
    const left = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { deletedChats: 1 });
      const once = await chatOf(db, leaver);
      await markDeleted(db, leaver, daysAgo(0, 1));
      await cleanup(db, 'cleanup_deleted_accounts_chats');
      const first = await chatLeft(db, once);

      await publishPolicy(db, { deletedChats: 2 });
      const kept = await chatOf(db, leaver2);
      await markDeleted(db, leaver2, daysAgo(0, 1));
      await cleanup(db, 'cleanup_deleted_accounts_chats');
      return [first, await chatLeft(db, kept)];
    });

    expect(left).toEqual([GONE, WHOLE]);
  });

  // The shorter of the term of the version in force when the chat began and of the newest version.
  // The transaction began before it published the versions, so a chat dated after the first version
  // is "from the future" of the transaction: only a term that counts from the deletion, which is a
  // day old, can be due. The term counts from the deletion, the version is looked up by the day the
  // chat began; the two are independent, which is what lets a test see the rule
  it.each([
    ['the first version shorter', 1, 30, GONE],
    ['the newest version shorter', 30, 1, GONE],
    ['both as long', 30, 30, WHOLE],
  ])(
    'keeps a chat for the shorter of the two terms: %s',
    async (_case, first, newest, expected) => {
      const left = await inRolledBackTx(async (db) => {
        const v1 = await publishPolicy(db, { deletedChats: first });
        await db.rows('select 1 as done from pg_sleep(0.01)');
        await publishPolicy(db, { deletedChats: newest });
        // began a millisecond after the first version, so that version was in force then
        const chat = await chatOf(
          db,
          leaver,
          `('${v1.createdAt}'::timestamp + interval '1 millisecond')`,
        );
        await markDeleted(db, leaver, daysAgo(1));

        await cleanup(db, 'cleanup_deleted_accounts_chats');
        return chatLeft(db, chat);
      });

      expect(left).toEqual(expected);
    },
  );

  it('says how many chats went, and has none the second time', async () => {
    const counts = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { deletedChats: 30 });
      await chatOf(db, leaver);
      await markDeleted(db, leaver, daysAgo(40));

      const first = await cleaned(db, 'cleanup_deleted_accounts_chats');
      return { first, second: await cleaned(db, 'cleanup_deleted_accounts_chats') };
    });

    expect(counts.first).toBeGreaterThanOrEqual(1);
    expect(counts.second).toBe(0);
  });
});

// The statements of return. A statement is closed by the database in the transaction that sets the
// last result of its rows, at the moment of that transaction: it cannot be dated back by a test. A
// term of one day is due at once (the statement was closed a moment ago, now is the same moment), a
// term of two is not, a term of a year is far from it. The terms of the versions committed by the
// other files (a year and more) are longer than the terms used here, so they do not change the
// results

const REQUEST_IP = '203.0.113.7';
const REQUEST_AGENT = 'Test browser';

type OrderItem = { id: number; quantity: number };

const itemsOf = async (db: DbSession, orderId: number) => {
  await db.as(rootActor());
  return db.rows<OrderItem>(
    `select id, quantity from cartlify.order_items where "orderId" = $1 order by id`,
    orderId,
  );
};

type StatementOpts = {
  actor?: Actor;
  source?: 'admin' | 'account';
  basis?: 'withdrawal' | 'other';
  reason?: string | null;
  description?: string | null;
};

// the statement for every unit of the order, with the address and the browser of the request
async function statementOf(db: DbSession, orderId: number, opts: StatementOpts = {}) {
  const items = await itemsOf(db, orderId);
  await db.as(opts.actor ?? adminActor());
  await db.rows(
    `select set_config('cartlify.request_ip', $1, true), set_config('cartlify.request_user_agent', $2, true)`,
    REQUEST_IP,
    REQUEST_AGENT,
  );
  const [row] = await db.rows<{ id: number }>(
    `select cartlify.create_return(
       $1::int, $2::jsonb, $3::cartlify."ReturnSource", $4::cartlify."ReturnBasis",
       $5::cartlify."ReturnReason", $6::text, 'Anna Koval', 'anna@example.com', null, null, 4,
       'Europe/Madrid'
     ) as id`,
    orderId,
    JSON.stringify(items.map((item) => ({ orderItemId: item.id, quantity: item.quantity }))),
    opts.source ?? 'admin',
    opts.basis ?? 'other',
    opts.reason === undefined ? 'defect' : opts.reason,
    opts.description === undefined
      ? 'The box came open, call me on +380501234567.'
      : opts.description,
  );
  return row!.id;
}

const rowsOf = async (db: DbSession, returnId: number) => {
  await db.as(rootActor());
  return db.rows<OrderItem>(
    `select id, quantity from cartlify.return_items where "returnId" = $1 order by id`,
    returnId,
  );
};

const receive = async (
  db: DbSession,
  returnId: number,
  results: Array<{ itemId: number; quantity: number; goods: string }>,
) => {
  await db.as(adminActor());
  await db.rows(
    `select 1 as done from cartlify.receive_return_items($1::int, $2::jsonb)`,
    returnId,
    JSON.stringify(results),
  );
};

// a statement closed the simplest way: the goods are back on the shelf and the money went back
async function closedStatementOn(db: DbSession, orderId: number) {
  const returnId = await statementOf(db, orderId);
  const rows = await rowsOf(db, returnId);
  await receive(
    db,
    returnId,
    rows.map((row) => ({ itemId: row.id, quantity: row.quantity, goods: 'to_stock' })),
  );
  await refundReturnIn(db, admin.id, returnId);
  return returnId;
}

// the order is sent; the admin does it the way the app does
async function ship(db: DbSession, orderId: number, status: 'shipped' | 'delivered' = 'shipped') {
  await db.as(adminActor());
  await db.rows(
    `update cartlify.orders set status = 'shipped' where id = $1 returning id`,
    orderId,
  );
  if (status === 'delivered') {
    await db.rows(
      `update cartlify.orders set status = 'delivered' where id = $1 returning id`,
      orderId,
    );
  }
}

const paidFor = (db: DbSession, who: TestUser, delivery: Partial<DeliveryData> = {}) =>
  paidOrderOf(db, who.id, admin.id, [[product.variantId, 1]], {}, delivery);

type Json = Record<string, unknown>;

type Statement = {
  head: Json & {
    contactName: string;
    contactEmail: string;
    description: string | null;
    ip: string | null;
    userAgent: string | null;
    proofCarrier: string | null;
    proofTrackingNumber: string | null;
    proofTrackingUrl: string | null;
    closedAt: string | null;
    closeNote: string | null;
  };
  rows: Array<
    Json & {
      amountNote: string | null;
      outsideNote: string | null;
      refundFailureText: string | null;
    }
  >;
};

// the whole statement as it is kept, without the moment it was last touched
async function snapshotOf(db: DbSession, returnId: number): Promise<Statement> {
  await db.as(rootActor());
  const [head] = await db.rows<{ j: Statement['head'] }>(
    `select to_jsonb(r) - 'updatedAt' as j from cartlify.returns as r where r.id = $1`,
    returnId,
  );
  const rows = await db.rows<{ j: Statement['rows'][number] }>(
    `select to_jsonb(i) - 'updatedAt' as j from cartlify.return_items as i
     where i."returnId" = $1 order by i.id`,
    returnId,
  );
  return { head: head!.j, rows: rows.map((row) => row.j) };
}

// A sent order of three items that the buyer took back from their account, and the whole story of
// it: the buyer wrote the words of the request, the carrier and the number of the parcel; the admin
// took two items in; root lowered the sum of the first with the reason, and it went back through the
// provider; the transfer of the second failed and root sent the money outside the app; the third
// never came and root closed it with a note. The statement is closed, every note is set
async function fullStatement(db: DbSession) {
  const orderId = await paidOrderOf(
    db,
    buyer.id,
    admin.id,
    parts.map((part) => [part.variantId, 1]) as Items,
  );
  await ship(db, orderId);

  const returnId = await statementOf(db, orderId, {
    actor: buyerActor(),
    source: 'account',
    basis: 'withdrawal',
    reason: null,
    description: 'I changed my mind, my address is Main street 1.',
  });
  await db.as(buyerActor());
  await db.rows(
    `select 1 as done from cartlify.provide_return_proof(
       $1::int, 'DHL', 'JD0146000123', 'https://track.example.com/JD0146000123'
     )`,
    returnId,
  );

  const [first, second, third] = await rowsOf(db, returnId);
  await receive(db, returnId, [
    { itemId: first!.id, quantity: 1, goods: 'to_stock' },
    { itemId: second!.id, quantity: 1, goods: 'to_stock' },
  ]);

  // the first: lowered by root, sent back through the provider
  await db.as(rootActor());
  const [lowered] = await db.rows<{ done: { key: string } }>(
    `select cartlify.begin_return_refund($1::int, $2::int[], $3::jsonb) as done`,
    returnId,
    [first!.id],
    JSON.stringify([{ itemId: first!.id, amount: 5, note: 'Opened and used.' }]),
  );
  await db.rows(
    `select cartlify.finish_return_refund($1::uuid, 'succeeded', 're_test_1', null, null) as done`,
    lowered!.done.key,
  );

  // the second: the transfer fails with the words of the provider, root sends the money outside
  const [failing] = await db.rows<{ done: { key: string } }>(
    `select cartlify.begin_return_refund($1::int, $2::int[], null::jsonb) as done`,
    returnId,
    [second!.id],
  );
  await db.rows(
    `select cartlify.finish_return_refund(
       $1::uuid, 'failed', null, 'card_unavailable'::cartlify."ReturnRefundFailure", 'The card is closed.'
     ) as done`,
    failing!.done.key,
  );
  const [order] = await db.rows<{ paidAt: string }>(
    `select "paidAt"::text as "paidAt" from cartlify.orders where id = $1`,
    orderId,
  );
  await db.rows(
    `select cartlify.mark_return_refunded_outside(
       $1::int, $2::int[], 'bank_transfer'::cartlify."ReturnOutsideMethod",
       'Sent to the account of the buyer.', $3::timestamp
     ) as done`,
    returnId,
    [second!.id],
    order!.paidAt,
  );

  // the third: the goods never came
  await db.rows(
    `select cartlify.close_return_without_refund(
       $1::int, $2::int[], 'goods_not_returned'::cartlify."ReturnCloseCode", 'The goods never came.'
     ) as done`,
    returnId,
    [third!.id],
  );

  const statement = await snapshotOf(db, returnId);
  if (statement.head.closedAt === null) throw new Error('the statement is not closed');
  return returnId;
}

// a statement with nothing but what it needs: no parcel, no note, no lowered sum
async function bareStatement(db: DbSession) {
  const returnId = await closedStatementOn(db, await paidFor(db, buyer));
  const statement = await snapshotOf(db, returnId);
  if (statement.head.closedAt === null) throw new Error('the statement is not closed');
  return returnId;
}

// a statement that waits for its goods
async function openStatement(db: DbSession) {
  return statementOf(db, await paidFor(db, buyer));
}

describe('cartlify.cleanup_return_addresses', () => {
  const addressesOf = async (db: DbSession, returnId: number) => {
    const { head } = await snapshotOf(db, returnId);
    return [head.ip, head.userAgent];
  };

  const KEPT = [REQUEST_IP, REQUEST_AGENT];
  const EMPTY = [null, null];

  it('empties the address and the browser of the closed statements, the statement stays whole', async () => {
    const result = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnAddresses: 1 });
      const full = await fullStatement(db);
      const bare = await bareStatement(db);
      const before = [await snapshotOf(db, full), await snapshotOf(db, bare)];

      await cleanup(db, 'cleanup_return_addresses');
      return { before, after: [await snapshotOf(db, full), await snapshotOf(db, bare)] };
    });

    expect(result.before.map((s) => [s.head.ip, s.head.userAgent])).toEqual([KEPT, KEPT]);
    expect(result.after).toEqual(
      result.before.map((s) => ({
        head: { ...s.head, ip: null, userAgent: null },
        rows: s.rows,
      })),
    );
  });

  // the journals are never cleaned as a whole: what they keep of the request of the buyer (or of
  // the form) for a statement goes with the address of the statement; the lines of the admins stay
  it('empties the address and the browser the journals keep of what the buyer did, the lines of the admins stay', async () => {
    const logLine = async (
      db: DbSession,
      orderId: number,
      returnId: number,
      who: { role: 'USER' | 'ADMIN'; id: number },
    ) => {
      await db.as(who.role === 'USER' ? { role: 'ADMIN' } : adminActor());
      await db.rows(
        `select set_config('cartlify.request_ip', $1, true), set_config('cartlify.request_user_agent', $2, true)`,
        REQUEST_IP,
        REQUEST_AGENT,
      );
      await db.rows(
        `select 1 as done from cartlify.log_admin_action(
           $1::int, $2::cartlify."Role", 'order'::cartlify."AdminAuditEntityType", $3::int,
           'OTHER'::cartlify."AdminAuditAction", 'return.create', $4::jsonb
         )`,
        who.id,
        who.role,
        orderId,
        JSON.stringify([{ field: 'returnId', old: null, new: returnId }]),
      );
    };
    const journalsOf = async (db: DbSession, orderId: number) => {
      await db.as(rootActor());
      const lines = (table: string, where: string) =>
        db.rows<{ role: string | null; ip: string | null; userAgent: string | null }>(
          `select "actorRole"::text as role, ip, "userAgent" from cartlify.${table}
           where ${where} order by id`,
          orderId,
        );
      return {
        audit: await lines('admin_audit_log', `"entityType" = 'order' and "entityId" = $1`),
        stock: await lines('stock_log', `"orderId" = $1 and event = 'stock.return'`),
      };
    };

    const result = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnAddresses: 1 });
      // the buyer withdraws from a paid order: the goods come back at once in their name
      const orderId = await paidFor(db, buyer);
      const returnId = await statementOf(db, orderId, {
        actor: buyerActor(),
        source: 'account',
        basis: 'withdrawal',
        reason: null,
      });
      await logLine(db, orderId, returnId, { role: 'USER', id: buyer.id });
      await logLine(db, orderId, returnId, { role: 'ADMIN', id: admin.id });
      await refundReturnIn(db, admin.id, returnId);
      const before = await journalsOf(db, orderId);

      await cleanup(db, 'cleanup_return_addresses');
      return { before, after: await journalsOf(db, orderId) };
    });

    const kept = { ip: REQUEST_IP, userAgent: REQUEST_AGENT };
    const emptied = { ip: null, userAgent: null };
    expect(result.before).toEqual({
      audit: [
        { role: 'USER', ...kept },
        { role: 'ADMIN', ...kept },
      ],
      stock: [{ role: 'USER', ...kept }],
    });
    expect(result.after).toEqual({
      audit: [
        { role: 'USER', ...emptied },
        { role: 'ADMIN', ...kept },
      ],
      stock: [{ role: 'USER', ...emptied }],
    });
  });

  it('leaves a statement that is not closed, whatever the term', async () => {
    const result = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnAddresses: 1 });
      const open = await openStatement(db);
      const before = await snapshotOf(db, open);

      await cleanup(db, 'cleanup_return_addresses');
      return { before, after: await snapshotOf(db, open) };
    });

    expect(result.before.head.closedAt).toBeNull();
    expect(result.after).toEqual(result.before);
  });

  it.each([
    ['two days', 2],
    ['a year', 365],
  ])('keeps the address of a statement closed today with a term of %s', async (_case, days) => {
    const addresses = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnAddresses: days });
      const bare = await bareStatement(db);

      await cleanup(db, 'cleanup_return_addresses');
      return addressesOf(db, bare);
    });

    expect(addresses).toEqual(KEPT);
  });

  it('empties the address of a statement closed today with a term of one day', async () => {
    const addresses = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnAddresses: 1 });
      const bare = await bareStatement(db);

      await cleanup(db, 'cleanup_return_addresses');
      return addressesOf(db, bare);
    });

    expect(addresses).toEqual(EMPTY);
  });

  it('says how many statements it emptied, and has none the second time', async () => {
    const counts = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnAddresses: 1 });
      await bareStatement(db);
      await bareStatement(db);
      await openStatement(db);

      const first = await cleaned(db, 'cleanup_return_addresses');
      return { first, second: await cleaned(db, 'cleanup_return_addresses') };
    });

    expect(counts.first).toBeGreaterThanOrEqual(2);
    expect(counts.second).toBe(0);
  });
});

describe('cartlify.cleanup_return_personal', () => {
  const anonymised = (statement: Statement, returnId: number): Statement => ({
    head: {
      ...statement.head,
      contactName: 'Recipient Customer',
      contactEmail: `return+${returnId}@example.com`,
      description: null,
      proofTrackingNumber: statement.head.proofTrackingNumber === null ? null : `R${returnId}`,
      proofTrackingUrl: null,
      closeNote: statement.head.closeNote === null ? null : 'Cleared',
    },
    rows: statement.rows.map((row) => ({
      ...row,
      amountNote: row.amountNote === null ? null : 'Lowered by the shop',
      outsideNote: row.outsideNote === null ? null : 'Sent outside the app',
      refundFailureText: null,
    })),
  });

  it('makes the personal data of a closed statement anonymous, with every note it holds', async () => {
    const result = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnPersonal: 1 });
      const returnId = await fullStatement(db);
      const before = await snapshotOf(db, returnId);

      await cleanup(db, 'cleanup_return_personal');
      return { returnId, before, after: await snapshotOf(db, returnId) };
    });

    // what the buyer and the admins wrote
    expect(result.before.head).toMatchObject({
      contactName: 'Anna Koval',
      contactEmail: 'anna@example.com',
      description: 'I changed my mind, my address is Main street 1.',
      proofCarrier: 'DHL',
      proofTrackingNumber: 'JD0146000123',
      proofTrackingUrl: 'https://track.example.com/JD0146000123',
      closeNote: 'The goods never came.',
    });
    expect(result.before.rows.map((row) => row.amountNote)).toEqual([
      'Opened and used.',
      null,
      null,
    ]);
    expect(result.before.rows.map((row) => row.outsideNote)).toEqual([
      null,
      'Sent to the account of the buyer.',
      null,
    ]);

    // what is left: made-up words, the notes with the same meaning in general words
    expect(result.after.head).toMatchObject({
      contactName: 'Recipient Customer',
      contactEmail: `return+${result.returnId}@example.com`,
      description: null,
      proofCarrier: 'DHL',
      proofTrackingNumber: `R${result.returnId}`,
      proofTrackingUrl: null,
      closeNote: 'Cleared',
    });
    expect(result.after.rows.map((row) => row.amountNote)).toEqual([
      'Lowered by the shop',
      null,
      null,
    ]);
    expect(result.after.rows.map((row) => row.outsideNote)).toEqual([
      null,
      'Sent outside the app',
      null,
    ]);
    expect(result.after.rows.map((row) => row.refundFailureText)).toEqual([null, null, null]);

    // and nothing else moved: the money, the goods, the dates, the reasons, the parcel's carrier,
    // the address and the browser
    expect(result.after).toEqual(anonymised(result.before, result.returnId));
  });

  it('makes up only the notes that are there: a statement without a parcel or a note gets none', async () => {
    const result = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnPersonal: 1 });
      const returnId = await bareStatement(db);
      const before = await snapshotOf(db, returnId);

      await cleanup(db, 'cleanup_return_personal');
      return { returnId, before, after: await snapshotOf(db, returnId) };
    });

    expect(result.before.head).toMatchObject({
      description: 'The box came open, call me on +380501234567.',
      proofTrackingNumber: null,
      closeNote: null,
    });
    expect(result.after.head).toMatchObject({
      contactName: 'Recipient Customer',
      contactEmail: `return+${result.returnId}@example.com`,
      description: null,
      proofTrackingNumber: null,
      proofTrackingUrl: null,
      closeNote: null,
    });
    expect(result.after.rows.map((row) => [row.amountNote, row.outsideNote])).toEqual([
      [null, null],
    ]);
    expect(result.after).toEqual(anonymised(result.before, result.returnId));
  });

  it('leaves a statement that is not closed, whatever the term', async () => {
    const result = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnPersonal: 1 });
      const open = await openStatement(db);
      const before = await snapshotOf(db, open);

      await cleanup(db, 'cleanup_return_personal');
      return { before, after: await snapshotOf(db, open) };
    });

    expect(result.before.head.closedAt).toBeNull();
    expect(result.after).toEqual(result.before);
  });

  it.each([
    ['two days', 2],
    ['a year', 365],
  ])('keeps a statement closed today with a term of %s', async (_case, days) => {
    const result = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnPersonal: days });
      const returnId = await fullStatement(db);
      const before = await snapshotOf(db, returnId);

      await cleanup(db, 'cleanup_return_personal');
      return { before, after: await snapshotOf(db, returnId) };
    });

    expect(result.after).toEqual(result.before);
  });

  it('does not touch the address and the browser: that is the term of the other function', async () => {
    const result = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnPersonal: 1, returnAddresses: 365 });
      const returnId = await bareStatement(db);

      await cleanup(db, 'cleanup_return_personal');
      return (await snapshotOf(db, returnId)).head;
    });

    expect(result).toMatchObject({ ip: REQUEST_IP, userAgent: REQUEST_AGENT });
  });

  it('says how many statements it made anonymous, and none the second time', async () => {
    const result = await inRoundedTx(async (db) => {
      await publishPolicy(db, { returnPersonal: 1 });
      const full = await fullStatement(db);
      const bare = await bareStatement(db);
      await openStatement(db);

      const first = await cleaned(db, 'cleanup_return_personal');
      const afterFirst = [await snapshotOf(db, full), await snapshotOf(db, bare)];
      const second = await cleaned(db, 'cleanup_return_personal');
      return {
        first,
        second,
        afterFirst,
        afterSecond: [await snapshotOf(db, full), await snapshotOf(db, bare)],
      };
    });

    expect(result.first).toBeGreaterThanOrEqual(2);
    expect(result.second).toBe(0);
    // the second look changes nothing of what the first made
    expect(result.afterSecond).toEqual(result.afterFirst);
  });
});

describe('cartlify.cleanup_deleted_accounts_recipients', () => {
  const MANUAL: Partial<DeliveryData> = { apartment: '12', note: 'Call before you come' };
  const PICKED_UP: Partial<DeliveryData> = { ...PICKUP, note: 'Leave it at the desk' };

  const markDeleted = async (db: DbSession, who: TestUser, at: string) => {
    await db.as(rootActor());
    await db.rows(`update cartlify.users set "deletedAt" = ${at} where id = $1`, who.id);
  };

  const sentOrder = async (db: DbSession, who: TestUser, status: 'shipped' | 'delivered') => {
    const orderId = await paidFor(db, who, MANUAL);
    await ship(db, orderId, status);
    return orderId;
  };

  // the orders of the user that are done with: not paid yet, a cart, and one cancelled by a
  // statement that is closed. The cart is the last: a user has one cart
  async function doneOrders(db: DbSession, who: TestUser) {
    const waiting = await waitingOrderOf(db, who.id, [[product.variantId, 1]], {}, MANUAL);
    const pickup = await waitingOrderOf(db, who.id, [[product.variantId, 1]], {}, PICKED_UP);
    const cancelled = await paidFor(db, who, MANUAL);
    await cancelAndRefundIn(db, admin.id, cancelled);
    const cart = await cartOf(db, who.id, [[product.variantId, 1]], { delivery: MANUAL });
    return { waiting, pickup, cancelled, cart };
  }

  // the orders that are being worked: paid, on their way, and one delivered with a statement of
  // return that is open
  async function workedOrders(db: DbSession, who: TestUser) {
    const paid = await paidFor(db, who, MANUAL);
    const shipped = await sentOrder(db, who, 'shipped');
    const returned = await sentOrder(db, who, 'delivered');
    await statementOf(db, returned);
    return { paid, shipped, returned };
  }

  const waitingFor = (db: DbSession, who: TestUser) =>
    waitingOrderOf(db, who.id, [[product.variantId, 1]], {}, MANUAL);

  const deliveryOf = async (db: DbSession, orderId: number) => {
    await db.as(rootActor());
    const [row] = await db.rows<{ j: Json }>(
      `select to_jsonb(d) - 'updatedAt' as j from cartlify.order_deliveries as d where d."orderId" = $1`,
      orderId,
    );
    return row!.j;
  };

  const deliveriesOf = (db: DbSession, orderIds: number[]) =>
    Promise.all(orderIds.map((id) => deliveryOf(db, id)));

  const statusesOf = async (db: DbSession, orderIds: number[]) => {
    await db.as(rootActor());
    return (
      await db.rows<{ status: string }>(
        `select status::text as status from cartlify.orders where id = any($1::int[]) order by array_position($1::int[], id)`,
        orderIds,
      )
    ).map((row) => row.status);
  };

  const anonymised = (row: Json): Json => ({
    ...row,
    recipientFirstName: 'Recipient',
    recipientLastName: 'Customer',
    recipientPhone: '+10000000000',
    postalCode: null,
    apartment: null,
    note: null,
    city: row.method === 'manual' ? 'City' : null,
    street: row.method === 'manual' ? 'Street' : null,
    house: row.method === 'manual' ? '0' : null,
  });

  it('makes the recipient of the orders of a deleted account anonymous, the country, the method and the price stay', async () => {
    const result = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { recipient: 30 });
      const orders = await doneOrders(db, leaver);
      const ids = Object.values(orders);
      const statuses = await statusesOf(db, ids);
      await markDeleted(db, leaver, daysAgo(40));
      const before = await deliveriesOf(db, ids);

      await cleanup(db, 'cleanup_deleted_accounts_recipients');
      return { ids, statuses, before, after: await deliveriesOf(db, ids) };
    });

    // none of them is paid or on its way
    expect(result.statuses).toEqual(['waiting', 'waiting', 'cancelled', 'pending']);
    // a recipient with a name, a phone and an address is there before
    expect(result.before.map((row) => [row.recipientFirstName, row.recipientPhone])).toEqual(
      result.before.map(() => ['Anna', '+380501234567']),
    );
    expect(result.before[0]).toMatchObject({ method: 'manual', city: 'Kyiv', apartment: '12' });
    expect(result.before[1]).toMatchObject({
      method: 'pickup',
      city: null,
      note: 'Leave it at the desk',
    });
    // and made up after, the pickup without an address as before
    expect(result.after).toEqual(result.before.map(anonymised));
    expect(result.after[0]).toMatchObject({
      recipientFirstName: 'Recipient',
      recipientLastName: 'Customer',
      recipientPhone: '+10000000000',
      postalCode: null,
      city: 'City',
      street: 'Street',
      house: '0',
      apartment: null,
      note: null,
    });
    expect(result.after[1]).toMatchObject({
      method: 'pickup',
      city: null,
      street: null,
      house: null,
    });
  });

  it('keeps the recipient of an order that is paid or on its way, and of one with an open statement of return', async () => {
    const result = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { recipient: 30 });
      const orders = await workedOrders(db, leaver);
      const ids = Object.values(orders);
      const statuses = await statusesOf(db, ids);
      await markDeleted(db, leaver, daysAgo(40));
      const before = await deliveriesOf(db, ids);

      await cleanup(db, 'cleanup_deleted_accounts_recipients');
      return { statuses, before, after: await deliveriesOf(db, ids) };
    });

    expect(result.statuses).toEqual(['paid', 'shipped', 'delivered']);
    expect(result.after).toEqual(result.before);
  });

  // the public form asks for the name of the recipient: the buyer of a deleted account withdraws
  // with it until the end of the period, the longest grace of the shop counted in. The end of a
  // period that is over cannot be reached here: the database stamps the delivery with its own time
  it('keeps the recipient of a delivered order while its period of withdrawal may run, whatever its statement', async () => {
    const result = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { recipient: 30 });
      const delivered = await sentOrder(db, leaver, 'delivered');
      const answered = await sentOrder(db, leaver, 'delivered');
      const returnId = await statementOf(db, answered);
      await markDeleted(db, leaver, daysAgo(40));
      const before = await deliveriesOf(db, [delivered, answered]);

      await cleanup(db, 'cleanup_deleted_accounts_recipients');
      const open = await deliveriesOf(db, [delivered, answered]);

      // the statement gets its goods and its money, and is closed
      const rows = await rowsOf(db, returnId);
      await receive(
        db,
        returnId,
        rows.map((row) => ({ itemId: row.id, quantity: row.quantity, goods: 'to_stock' })),
      );
      await refundReturnIn(db, admin.id, returnId);
      await cleanup(db, 'cleanup_deleted_accounts_recipients');
      return { before, open, closed: await deliveriesOf(db, [delivered, answered]) };
    });

    expect(result.open).toEqual(result.before);
    expect(result.closed).toEqual(result.before);
  });

  it('keeps the recipient of the orders of an account that lives and of one deleted lately', async () => {
    const result = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { recipient: 30 });
      const alive = await waitingFor(db, living);
      const lately = await waitingFor(db, leaver);
      const gone = await waitingFor(db, leaver2);
      await markDeleted(db, leaver, daysAgo(10));
      await markDeleted(db, leaver2, daysAgo(40));
      const before = await deliveriesOf(db, [alive, lately, gone]);

      await cleanup(db, 'cleanup_deleted_accounts_recipients');
      return { before, after: await deliveriesOf(db, [alive, lately, gone]) };
    });

    expect(result.after).toEqual([
      result.before[0],
      result.before[1],
      anonymised(result.before[2]!),
    ]);
  });

  it('cleans a day before the term ends, a minute short of that it waits', async () => {
    const result = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { recipient: 30 });
      const due = await waitingFor(db, leaver);
      const notYet = await waitingFor(db, leaver2);
      await markDeleted(db, leaver, daysAgo(29, 1));
      await markDeleted(db, leaver2, daysAgo(29, -1));
      const before = await deliveriesOf(db, [due, notYet]);

      await cleanup(db, 'cleanup_deleted_accounts_recipients');
      return { before, after: await deliveriesOf(db, [due, notYet]) };
    });

    expect(result.after).toEqual([anonymised(result.before[0]!), result.before[1]]);
  });

  it('cleans at once with a term of one day, and keeps the orders of an account deleted today with a term of two', async () => {
    const result = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { recipient: 1 });
      const once = await waitingFor(db, leaver);
      await markDeleted(db, leaver, daysAgo(0, 1));
      const beforeOnce = await deliveryOf(db, once);
      await cleanup(db, 'cleanup_deleted_accounts_recipients');
      const afterOnce = await deliveryOf(db, once);

      await publishPolicy(db, { recipient: 2 });
      const kept = await waitingFor(db, leaver2);
      await markDeleted(db, leaver2, daysAgo(0, 1));
      const beforeKept = await deliveryOf(db, kept);
      await cleanup(db, 'cleanup_deleted_accounts_recipients');
      return { beforeOnce, afterOnce, beforeKept, afterKept: await deliveryOf(db, kept) };
    });

    expect(result.afterOnce).toEqual(anonymised(result.beforeOnce));
    expect(result.afterKept).toEqual(result.beforeKept);
  });

  it('says how many deliveries it made anonymous, and has none the second time', async () => {
    const result = await inRolledBackTx(async (db) => {
      await publishPolicy(db, { recipient: 30 });
      const orders = await doneOrders(db, leaver);
      await markDeleted(db, leaver, daysAgo(40));

      const first = await cleaned(db, 'cleanup_deleted_accounts_recipients');
      const afterFirst = await deliveriesOf(db, Object.values(orders));
      const second = await cleaned(db, 'cleanup_deleted_accounts_recipients');
      return {
        first,
        second,
        afterFirst,
        afterSecond: await deliveriesOf(db, Object.values(orders)),
      };
    });

    expect(result.first).toBeGreaterThanOrEqual(4);
    expect(result.second).toBe(0);
    expect(result.afterSecond).toEqual(result.afterFirst);
  });
});
