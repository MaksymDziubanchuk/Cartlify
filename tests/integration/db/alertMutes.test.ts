import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { changedRows } from '../../helpers/dbOrders.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// the kinds of alerts an admin or root turned off (admin_alert_mutes): each one sees, adds and
// takes away only their own; a user has none, nobody changes a row

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

const mute = (db: DbSession, userId: number, kind = 'low_stock') =>
  db.attempt(
    'insert into cartlify.admin_alert_mutes ("userId", kind) values ($1, $2) returning "userId"',
    userId,
    kind,
  );

const mutesSeen = async (db: DbSession) =>
  (
    await db.rows<{ userId: number }>(
      'select "userId" from cartlify.admin_alert_mutes where "userId" = any($1::int[])',
      [admin.id, otherAdmin.id, buyer.id],
    )
  ).map((row) => row.userId);

describe('admin_alert_mutes', () => {
  it('lets an admin turn off a kind for themselves and see only their own', async () => {
    const { written, ownSeen, otherSeen } = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      const written = await mute(db, admin.id);
      const ownSeen = await mutesSeen(db);
      await db.as(as(otherAdmin));
      return { written, ownSeen, otherSeen: await mutesSeen(db) };
    });

    expect(changedRows(written)).toBe(true);
    expect(ownSeen).toEqual([admin.id]);
    expect(otherSeen).toEqual([]);
  });

  it('does not let an admin turn off a kind for another admin', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      return mute(db, otherAdmin.id);
    });

    expect(outcome.ok).toBe(false);
  });

  it('does not let a user keep a row', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(buyer));
      return mute(db, buyer.id);
    });

    expect(outcome.ok).toBe(false);
  });

  it('lets an admin take their own row away, and not one of another admin', async () => {
    const { ownGone, otherGone } = await inRolledBackTx(async (db) => {
      await db.as(as(otherAdmin));
      await mute(db, otherAdmin.id);
      await db.as(as(admin));
      await mute(db, admin.id);
      const ownGone = await db.attempt(
        'delete from cartlify.admin_alert_mutes where "userId" = $1 returning "userId"',
        admin.id,
      );
      const otherGone = await db.attempt(
        'delete from cartlify.admin_alert_mutes where "userId" = $1 returning "userId"',
        otherAdmin.id,
      );
      return { ownGone, otherGone };
    });

    expect(changedRows(ownGone)).toBe(true);
    expect(changedRows(otherGone)).toBe(false);
  });

  it('lets nobody change a row', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      await mute(db, admin.id);
      return db.attempt(
        `update cartlify.admin_alert_mutes set kind = 'chats_waiting' where "userId" = $1 returning "userId"`,
        admin.id,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });
});
