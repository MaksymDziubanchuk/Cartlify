import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { changedRows } from '../../helpers/dbOrders.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// the settings of the kinds of alerts of an admin or root (admin_alert_settings): whether a kind
// is on and its threshold. Each one sees, adds, changes and takes away only their own; a user has
// none; an update changes whether the kind is on and its threshold, never whose or which kind the
// row is (trg_admin_alert_settings_update_columns); a threshold is a whole number from 1

let buyer: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  otherAdmin = await createUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, otherAdmin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const as = (user: TestUser): Actor => ({ role: user.role, userId: user.id });

const keep = (
  db: DbSession,
  userId: number,
  opts: { kind?: string; subscribed?: boolean; threshold?: number | null } = {},
) =>
  db.attempt(
    `insert into cartlify.admin_alert_settings ("userId", kind, subscribed, threshold)
     values ($1, $2, $3, $4) returning "userId"`,
    userId,
    opts.kind ?? 'low_stock',
    opts.subscribed ?? false,
    opts.threshold ?? null,
  );

const settingsSeen = async (db: DbSession) =>
  (
    await db.rows<{ userId: number }>(
      'select "userId" from cartlify.admin_alert_settings where "userId" = any($1::int[])',
      [admin.id, otherAdmin.id, buyer.id],
    )
  ).map((row) => row.userId);

const update = (db: DbSession, set: string, userId: number) =>
  db.attempt(
    `update cartlify.admin_alert_settings set ${set} where "userId" = $1 returning "userId"`,
    userId,
  );

describe('admin_alert_settings', () => {
  it('lets an admin keep a setting of their own and see only their own', async () => {
    const { written, ownSeen, otherSeen } = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      const written = await keep(db, admin.id, { threshold: 10 });
      const ownSeen = await settingsSeen(db);
      await db.as(as(otherAdmin));
      return { written, ownSeen, otherSeen: await settingsSeen(db) };
    });

    expect(changedRows(written)).toBe(true);
    expect(ownSeen).toEqual([admin.id]);
    expect(otherSeen).toEqual([]);
  });

  it('does not let an admin keep a setting for another admin', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      return keep(db, otherAdmin.id);
    });

    expect(outcome.ok).toBe(false);
  });

  it('does not let a user keep a row', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(buyer));
      return keep(db, buyer.id);
    });

    expect(outcome.ok).toBe(false);
  });

  it('keeps one row of a kind for an admin', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      await keep(db, admin.id);
      return keep(db, admin.id, { subscribed: true });
    });

    expect(outcome).toMatchObject({ ok: false, code: '23505' });
  });

  it('turns a kind on when nothing says otherwise', async () => {
    const rows = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      await db.attempt(
        'insert into cartlify.admin_alert_settings ("userId", kind) values ($1, $2)',
        admin.id,
        'low_stock',
      );
      return db.rows<{ subscribed: boolean; threshold: number | null }>(
        'select subscribed, threshold from cartlify.admin_alert_settings where "userId" = $1',
        admin.id,
      );
    });

    expect(rows).toEqual([{ subscribed: true, threshold: null }]);
  });

  it.each([
    [0, false],
    [-5, false],
    [1, true],
    [100_000, true],
  ])('takes a threshold of %p: %p', async (threshold, ok) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      return keep(db, admin.id, { threshold });
    });

    expect(outcome.ok).toBe(ok);
    if (!ok) expect(outcome).toMatchObject({ code: '23514' });
  });

  it('lets an admin change whether their kind is on and its threshold', async () => {
    const { changed, rows } = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      await keep(db, admin.id);
      const changed = await update(db, 'subscribed = true, threshold = 20', admin.id);
      const rows = await db.rows<{ subscribed: boolean; threshold: number | null }>(
        'select subscribed, threshold from cartlify.admin_alert_settings where "userId" = $1',
        admin.id,
      );
      return { changed, rows };
    });

    expect(changedRows(changed)).toBe(true);
    expect(rows).toEqual([{ subscribed: true, threshold: 20 }]);
  });

  it('does not let an admin change a setting of another admin', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(otherAdmin));
      await keep(db, otherAdmin.id);
      await db.as(as(admin));
      return update(db, 'threshold = 20', otherAdmin.id);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it.each([
    ['the kind', () => `kind = 'chats_waiting'`],
    ['whose it is', () => `"userId" = ${otherAdmin.id}`],
    ['when it was made', () => `"createdAt" = '2020-01-01'`],
  ])('does not let an admin change %s of a row', async (_case, set) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      await keep(db, admin.id);
      return update(db, set(), admin.id);
    });

    expect(outcome).toMatchObject({
      ok: false,
      code: '42501',
      message: 'ADMIN_ALERT_SETTING_UPDATE_FORBIDDEN',
    });
  });

  it('lets an admin take their own row away, and not one of another admin', async () => {
    const { ownGone, otherGone } = await inRolledBackTx(async (db) => {
      await db.as(as(otherAdmin));
      await keep(db, otherAdmin.id);
      await db.as(as(admin));
      await keep(db, admin.id);
      const ownGone = await db.attempt(
        'delete from cartlify.admin_alert_settings where "userId" = $1 returning "userId"',
        admin.id,
      );
      const otherGone = await db.attempt(
        'delete from cartlify.admin_alert_settings where "userId" = $1 returning "userId"',
        otherAdmin.id,
      );
      return { ownGone, otherGone };
    });

    expect(changedRows(ownGone)).toBe(true);
    expect(changedRows(otherGone)).toBe(false);
  });
});
