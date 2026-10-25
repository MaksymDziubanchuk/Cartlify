import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// how long the shop keeps what it needs no longer: the address and the browser of old logins, the
// favorites and chats of guests who stopped coming, the chats of accounts deleted long ago. Each is
// a function of the system with the days it keeps as a parameter; the periodic tasks of Railway
// run them

let user: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

beforeAll(async () => {
  user = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct();
});

afterAll(async () => {
  try {
    await removeProducts([product]);
    await closeSessions([user.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

// the system acts as an admin without an id
const asSystem = (): Actor => ({ role: 'ADMIN' });

const daysAgo = (days: number) => `now() - make_interval(days => ${days})`;

const call = (db: DbSession, fn: string, keepDays: number) =>
  db.attempt(`select * from cartlify.${fn}($1::int)`, keepDays);

describe.each([
  ['cleanup_login_log_addresses'],
  ['cleanup_guest_data'],
  ['cleanup_deleted_accounts_chats'],
])('cartlify.%s', (fn) => {
  it.each([
    ['a signed-in admin', () => ({ role: 'ADMIN', userId: admin.id }) as Actor],
    ['root', () => ({ role: 'ROOT', userId: root.id }) as Actor],
    ['a user', () => ({ role: 'USER', userId: user.id }) as Actor],
  ])('is the work of the system, %s gets a refusal', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(actor());
      return call(db, fn, 30);
    });

    expect(outcome).toMatchObject({ ok: false, message: 'RETENTION_CLEANUP_FORBIDDEN' });
  });

  it('refuses to keep less than a day', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asSystem());
      return call(db, fn, 0);
    });

    expect(outcome).toMatchObject({ ok: false, message: 'RETENTION_CLEANUP_KEEP_DAYS_INVALID' });
  });
});

describe('cartlify.cleanup_login_log_addresses', () => {
  // a login line of the user, written the way a login writes it, some days ago
  const loginOf = async (db: DbSession, days: number) => {
    await db.as({ role: 'USER', userId: user.id });
    const [row] = await db.rows<{ id: number }>(
      `insert into cartlify.login_logs ("userId", email, role, "ipAddress", "userAgent", "createdAt")
       values ($1, $2, 'USER', '203.0.113.7', 'Test browser', ${daysAgo(days)})
       returning id`,
      user.id,
      user.email,
    );
    return row!.id;
  };

  const linesOf = (db: DbSession, ids: number[]) =>
    db.rows<{ id: number; email: string; ipAddress: string | null; userAgent: string | null }>(
      `select id, email, "ipAddress", "userAgent" from cartlify.login_logs
       where id = any($1::int[]) order by id`,
      ids,
    );

  it('forgets the address and the browser of the logins older than it keeps, the rest stays', async () => {
    const { old, recent, lines } = await inRolledBackTx(async (db) => {
      const old = await loginOf(db, 91);
      const recent = await loginOf(db, 89);

      await db.as(asSystem());
      await call(db, 'cleanup_login_log_addresses', 90);
      return { old, recent, lines: await linesOf(db, [old, recent]) };
    });

    expect(lines).toEqual([
      { id: old, email: user.email, ipAddress: null, userAgent: null },
      { id: recent, email: user.email, ipAddress: '203.0.113.7', userAgent: 'Test browser' },
    ]);
  });

  it('says how many lines it emptied', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await loginOf(db, 400);

      await db.as(asSystem());
      return call(db, 'cleanup_login_log_addresses', 365);
    });

    expect(outcome.ok).toBe(true);
    expect(
      Number(
        (outcome as { rows: Array<Record<string, number>> }).rows[0]!.cleanup_login_log_addresses,
      ),
    ).toBeGreaterThanOrEqual(1);
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
  // a guest with a favorite and a chat with a message, all of it some days ago
  const guestWith = async (db: DbSession, days: { favorite: number; chat: number }) => {
    const guestId = randomUUID();
    const threadId = randomUUID();
    await db.as({ role: 'GUEST', guestId });
    await db.rows(
      `insert into cartlify.favorites ("guestId", "productId", "createdAt")
       values ($1::uuid, $2, ${daysAgo(days.favorite)})`,
      guestId,
      product.id,
    );
    await db.rows(
      `insert into cartlify.chat_threads (id, "guestId", type, status, "lastMessageAt", "createdAt", "updatedAt")
       values ($1::uuid, $2::uuid, 'bot', 'open', ${daysAgo(days.chat)}, ${daysAgo(days.chat)}, ${daysAgo(days.chat)})`,
      threadId,
      guestId,
    );
    await db.rows(
      `insert into cartlify.chat_messages ("threadId", "senderType", content, "createdAt")
       values ($1::uuid, 'guest', 'My address is Main street 1', ${daysAgo(days.chat)})`,
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

  it('removes the favorites and the chats of a guest who has not come for longer than it keeps', async () => {
    const left = await inRolledBackTx(async (db) => {
      const guest = await guestWith(db, { favorite: 100, chat: 95 });

      await db.as(asSystem());
      await call(db, 'cleanup_guest_data', 90);
      return leftOf(db, guest);
    });

    expect(left).toEqual({ favorites: 0, threads: 0, messages: 0 });
  });

  // the guest wrote yesterday: the favorite of last year is still theirs
  it('keeps all of a guest who came within the days it keeps, old favorites too', async () => {
    const left = await inRolledBackTx(async (db) => {
      const guest = await guestWith(db, { favorite: 300, chat: 1 });

      await db.as(asSystem());
      await call(db, 'cleanup_guest_data', 90);
      return leftOf(db, guest);
    });

    expect(left).toEqual({ favorites: 1, threads: 1, messages: 1 });
  });

  it('leaves the favorites of users alone', async () => {
    const left = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: user.id });
      await db.rows(
        `insert into cartlify.favorites ("userId", "productId", "createdAt")
         values ($1, $2, ${daysAgo(500)})`,
        user.id,
        product.id,
      );

      await db.as(asSystem());
      await call(db, 'cleanup_guest_data', 90);
      return db.rows<{ n: number }>(
        'select count(*)::int as n from cartlify.favorites where "userId" = $1 and "productId" = $2',
        user.id,
        product.id,
      );
    });

    expect(left).toEqual([{ n: 1 }]);
  });
});

describe('cartlify.cleanup_deleted_accounts_chats', () => {
  // an account deleted some days ago, with a chat and a message of it; the user context writes
  // the chat before root marks the account deleted
  const deletedWithChat = async (db: DbSession, days: number) => {
    const target = await createUser();
    const threadId = randomUUID();
    await db.as({ role: 'USER', userId: target.id });
    await db.rows(
      `insert into cartlify.chat_threads (id, "userId", type, status) values ($1::uuid, $2, 'bot', 'open')`,
      threadId,
      target.id,
    );
    await db.rows(
      `insert into cartlify.chat_messages ("threadId", "senderId", "senderType", content)
       values ($1::uuid, $2, 'user', 'My phone is +380501234567')`,
      threadId,
      target.id,
    );
    if (days >= 0) {
      await db.as({ role: 'ROOT', userId: root.id });
      await db.rows(
        `update cartlify.chat_threads set status = 'closed' where id = $1::uuid`,
        threadId,
      );
      await db.rows(
        `update cartlify.users set "deletedAt" = ${daysAgo(days)} where id = $1`,
        target.id,
      );
    }
    return { userId: target.id, threadId };
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

  it('removes the chats of the accounts deleted longer ago than it keeps, with their messages', async () => {
    const left = await inRolledBackTx(async (db) => {
      const gone = await deletedWithChat(db, 40);

      await db.as(asSystem());
      await call(db, 'cleanup_deleted_accounts_chats', 30);
      return chatLeft(db, gone.threadId);
    });

    expect(left).toEqual({ threads: 0, messages: 0 });
  });

  it('keeps the chats of an account deleted lately and of an account that lives', async () => {
    const left = await inRolledBackTx(async (db) => {
      const lately = await deletedWithChat(db, 10);
      const living = await deletedWithChat(db, -1);

      await db.as(asSystem());
      await call(db, 'cleanup_deleted_accounts_chats', 30);
      return [await chatLeft(db, lately.threadId), await chatLeft(db, living.threadId)];
    });

    expect(left).toEqual([
      { threads: 1, messages: 1 },
      { threads: 1, messages: 1 },
    ]);
  });
});
