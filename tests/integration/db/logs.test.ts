import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { changedRows } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createLoginLog,
  createProduct,
  createUser,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// a log is history: login_logs, admin_audit_log and product_price_change_logs take a line once and
// no role of the app changes or deletes one (the data scripts of a superuser still clear them).
// The one change: when an account is deleted, its logins take the email the account has now
// (cartlify.anonymize_login_logs)

const DAY = 86_400_000;

let user: TestUser;
let leaving: TestUser;
let admin: TestUser;
let root: TestUser;
let product: TestProduct;

beforeAll(async () => {
  user = await createUser();
  leaving = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  product = await createProduct({ price: 10 });

  for (const days of [3, 1]) await createLoginLog(leaving, new Date(Date.now() - days * DAY));
  await createLoginLog(user, new Date());
});

afterAll(async () => {
  try {
    await closeSessions([user.id, leaving.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });
const asSystem = (): Actor => ({ role: 'ADMIN' });

// a line of the admin log and of the price log, written the way the app writes them
async function writeLogs(db: DbSession) {
  await db.as({ role: 'ADMIN', userId: admin.id });
  await db.rows(
    `select 1 as done from cartlify.log_admin_action($1::int, 'ADMIN', 'product', $2::int, 'OTHER', '[]'::jsonb)`,
    admin.id,
    product.id,
  );
  await db.rows(
    `select 1 as done from cartlify.log_product_price_change($1::int, 10, 12, 'fixed', 2)`,
    product.id,
  );
}

// what the deletion does to the row first: root marks it deleted and gives it a new email
async function deleteAccount(db: DbSession, userId: number) {
  const email = `deleted+${userId}+db_logs@shop.example.com`;
  await db.as(asRoot());
  await db.rows(
    'update cartlify.users set "deletedAt" = now(), email = $2 where id = $1 returning id',
    userId,
    email,
  );
  return email;
}

const loginsOf = async (db: DbSession, userId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  return db.rows<{ email: string; ipAddress: string | null; createdAt: Date }>(
    `select email, "ipAddress", "createdAt" from cartlify.login_logs where "userId" = $1 order by id`,
    userId,
  );
};

const anonymize = (db: DbSession, actor: Actor, userId: number) =>
  db
    .as(actor)
    .then(() =>
      db.attempt<{ changed: number }>(
        'select cartlify.anonymize_login_logs($1::int) as changed',
        userId,
      ),
    );

describe('the logs', () => {
  it.each([
    ['the user', (): Actor => ({ role: 'USER', userId: user.id })],
    ['an admin', (): Actor => ({ role: 'ADMIN', userId: admin.id })],
    ['root', asRoot],
    ['the system', asSystem],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])('let %s change or delete no line of the admin log or the price log', async (_who, actor) => {
    const outcomes = await inRolledBackTx(async (db) => {
      await writeLogs(db);
      await db.as(actor());
      return [
        await db.attempt(
          `update cartlify.admin_audit_log set meta = '[]'::jsonb where "actorId" = $1 returning id`,
          admin.id,
        ),
        await db.attempt(
          'delete from cartlify.admin_audit_log where "actorId" = $1 returning id',
          admin.id,
        ),
        await db.attempt(
          `update cartlify.product_price_change_logs set "newPrice" = 1 where "productId" = $1 returning id`,
          product.id,
        ),
        await db.attempt(
          'delete from cartlify.product_price_change_logs where "productId" = $1 returning id',
          product.id,
        ),
      ];
    });

    expect(outcomes.map(changedRows)).toEqual([false, false, false, false]);
  });

  // a deleted account can no more change a login line than a living one
  it('let no role change a login line of a deleted account with a plain update', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const email = await deleteAccount(db, leaving.id);
      const result = [];
      for (const actor of [asRoot(), asSystem(), { role: 'ADMIN', userId: admin.id } as Actor]) {
        await db.as(actor);
        result.push(
          await db.attempt(
            'update cartlify.login_logs set email = $2 where "userId" = $1 returning id',
            leaving.id,
            email,
          ),
        );
      }
      return result;
    });

    expect(outcomes.map(changedRows)).toEqual([false, false, false]);
  });
});

describe('cartlify.anonymize_login_logs', () => {
  it.each([
    ['root', asRoot],
    ['the system', asSystem],
  ])('lets %s give the logins of a deleted account its new email', async (_who, actor) => {
    const { before, email, outcome, after } = await inRolledBackTx(async (db) => {
      const before = await loginsOf(db, leaving.id);
      const email = await deleteAccount(db, leaving.id);
      const outcome = await anonymize(db, actor(), leaving.id);
      return { before, email, outcome, after: await loginsOf(db, leaving.id) };
    });

    expect(outcome).toEqual({ ok: true, rows: [{ changed: 2 }] });
    expect(after).toEqual(before.map((line) => ({ ...line, email })));
  });

  it('leaves the logins of another account as they are', async () => {
    const { before, after } = await inRolledBackTx(async (db) => {
      const before = await loginsOf(db, user.id);
      await deleteAccount(db, leaving.id);
      await anonymize(db, asRoot(), leaving.id);
      return { before, after: await loginsOf(db, user.id) };
    });

    expect(after).toEqual(before);
  });

  it('refuses an account that is not deleted, and changes no line', async () => {
    const { outcome, before, after } = await inRolledBackTx(async (db) => {
      const before = await loginsOf(db, leaving.id);
      const outcome = await anonymize(db, asRoot(), leaving.id);
      return { outcome, before, after: await loginsOf(db, leaving.id) };
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('USER_NOT_DELETED'),
    });
    expect(after).toEqual(before);
  });

  it.each([
    ['the user', (): Actor => ({ role: 'USER', userId: leaving.id })],
    ['a signed-in admin', (): Actor => ({ role: 'ADMIN', userId: admin.id })],
    ['a guest', (): Actor => ({ role: 'GUEST', guestId: randomUUID() })],
  ])('refuses %s', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      await deleteAccount(db, leaving.id);
      return anonymize(db, actor(), leaving.id);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('LOGIN_LOGS_ANONYMIZE_FORBIDDEN'),
    });
  });
});
