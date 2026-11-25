import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { changedRows } from '../../helpers/dbOrders.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// the second step of the login of an admin or root (user_two_factor): each admin or root reads,
// writes and changes only their own row; root reads every row and removes the row of an account
// that is no root; a guest and a customer see nothing. An update keeps whose the row is, when it was
// set up and made, and the step a code was taken for only grows unless the secret changes with it
// (trg_user_two_factor_update_columns). The row goes when the account stops being an admin or root
// (trg_users_drop_two_factor). Ten codes in a set, ten trusted browsers at most.

let buyer: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;
let root: TestUser;
let otherRoot: TestUser;

beforeAll(async () => {
  buyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  otherAdmin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
  otherRoot = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, admin.id, otherAdmin.id, root.id, otherRoot.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const as = (user: TestUser): Actor => ({ role: user.role, userId: user.id });

const write = (
  db: DbSession,
  userId: number,
  opts: { recoveryCodes?: string[]; usedRecoveryCodes?: string[]; trustedDevices?: unknown } = {},
) =>
  db.attempt(
    `insert into cartlify.user_two_factor
       ("userId", "secretEnc", "lastUsedStep", "recoveryCodes", "usedRecoveryCodes", "trustedDevices")
     values ($1, 'v1:a:b:c', 100, $2::text[], $3::text[], $4::jsonb) returning "userId"`,
    userId,
    opts.recoveryCodes ?? ['h1', 'h2'],
    opts.usedRecoveryCodes ?? [],
    JSON.stringify(opts.trustedDevices ?? []),
  );

// the row of each written the way its own account writes it
const writeOwn = async (db: DbSession, ...users: TestUser[]) => {
  for (const user of users) {
    await db.as(as(user));
    await write(db, user.id);
  }
};

const seen = async (db: DbSession) =>
  (
    await db.rows<{ userId: number }>(
      'select "userId" from cartlify.user_two_factor where "userId" = any($1::int[]) order by "userId"',
      [buyer.id, admin.id, otherAdmin.id, root.id, otherRoot.id],
    )
  ).map((row) => row.userId);

const update = (db: DbSession, set: string, userId: number) =>
  db.attempt(
    `update cartlify.user_two_factor set ${set} where "userId" = $1 returning "userId"`,
    userId,
  );

const remove = (db: DbSession, userId: number) =>
  db.attempt('delete from cartlify.user_two_factor where "userId" = $1 returning "userId"', userId);

describe('user_two_factor: who reads and writes', () => {
  it('lets an admin and root write their own row and see only it', async () => {
    const result = await inRolledBackTx(async (db) => {
      await writeOwn(db, admin, otherAdmin);
      const adminSeen = await (async () => {
        await db.as(as(admin));
        return seen(db);
      })();
      await db.as(as(buyer));
      const buyerSeen = await seen(db);
      await db.as({ role: 'GUEST', guestId: null });
      return { adminSeen, buyerSeen, guestSeen: await seen(db) };
    });

    expect(result.adminSeen).toEqual([admin.id]);
    expect(result.buyerSeen).toEqual([]);
    expect(result.guestSeen).toEqual([]);
  });

  it('lets root read every row', async () => {
    const rootSeen = await inRolledBackTx(async (db) => {
      await writeOwn(db, admin, otherRoot);
      await db.as(as(root));
      return seen(db);
    });

    expect(rootSeen).toEqual([admin.id, otherRoot.id].sort((a, b) => a - b));
  });

  it('refuses a row for another account, and any row of a customer', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      const forOther = await write(db, otherAdmin.id);
      await db.as(as(root));
      const rootForAdmin = await write(db, admin.id);
      await db.as(as(buyer));
      return { forOther, rootForAdmin, buyerOwn: await write(db, buyer.id) };
    });

    expect(outcomes.forOther.ok).toBe(false);
    expect(outcomes.rootForAdmin.ok).toBe(false);
    expect(outcomes.buyerOwn.ok).toBe(false);
  });

  it('lets an admin change only their own row', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await writeOwn(db, admin, otherAdmin);
      await db.as(as(admin));
      return {
        own: await update(db, '"failedCodes" = 1', admin.id),
        other: await update(db, '"failedCodes" = 1', otherAdmin.id),
      };
    });

    expect(changedRows(outcomes.own)).toBe(true);
    expect(changedRows(outcomes.other)).toBe(false);
  });

  it('lets root remove the row of an admin, never of a root; an admin removes none', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await writeOwn(db, admin, otherAdmin, otherRoot);
      await db.as(as(admin));
      const byAdmin = await remove(db, otherAdmin.id);
      const ownByAdmin = await remove(db, admin.id);
      await db.as(as(root));
      return {
        byAdmin,
        ownByAdmin,
        adminByRoot: await remove(db, admin.id),
        rootByRoot: await remove(db, otherRoot.id),
      };
    });

    expect(changedRows(outcomes.byAdmin)).toBe(false);
    expect(changedRows(outcomes.ownByAdmin)).toBe(false);
    expect(changedRows(outcomes.adminByRoot)).toBe(true);
    expect(changedRows(outcomes.rootByRoot)).toBe(false);
  });
});

describe('user_two_factor: what an update may change', () => {
  it.each([
    ['"secretEnc" = \'v1:x:y:z\''],
    ['"lastUsedStep" = 101'],
    ['"recoveryCodes" = array[\'h1\']::text[], "usedRecoveryCodes" = array[\'h2\']::text[]'],
    ['"trustedDevices" = \'[]\'::jsonb'],
    ['"failedCodes" = 3, "pausedUntil" = now()'],
    ['"secretEnc" = \'v1:x:y:z\', "lastUsedStep" = 5'],
  ])('lets the owner set %s', async (set) => {
    const outcome = await inRolledBackTx(async (db) => {
      await writeOwn(db, admin);
      return update(db, set, admin.id);
    });

    expect(changedRows(outcome)).toBe(true);
  });

  it.each([
    ['"userId" = "userId" + 1'],
    ['"enabledAt" = now() - interval \'1 day\''],
    ['"createdAt" = now() - interval \'1 day\''],
    // a code of an earlier step would work again
    ['"lastUsedStep" = 99'],
  ])('refuses %s', async (set) => {
    const outcome = await inRolledBackTx(async (db) => {
      await writeOwn(db, admin);
      return update(db, set, admin.id);
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
    if (!outcome.ok) expect(outcome.message).toContain('USER_TWO_FACTOR_UPDATE_FORBIDDEN');
  });
});

describe('user_two_factor: the role', () => {
  const setRole = (db: DbSession, userId: number, role: string) =>
    db.attempt(`update cartlify.users set role = $2::cartlify."Role" where id = $1`, userId, role);

  it('goes when the account stops being an admin, and stays while it is one', async () => {
    const result = await inRolledBackTx(async (db) => {
      await writeOwn(db, admin, otherAdmin);
      await db.as(as(root));
      await setRole(db, admin.id, 'USER');
      await setRole(db, otherAdmin.id, 'ROOT');
      return seen(db);
    });

    expect(result).toEqual([otherAdmin.id]);
  });
});

describe('user_two_factor: the counts', () => {
  const device = (n: number) => ({ id: `d${n}`, tokenHash: 'h', label: 'Chrome, Windows' });

  it.each([
    [{ recoveryCodes: Array.from({ length: 10 }, (_, i) => `h${i}`) }, true],
    [
      { recoveryCodes: ['a', 'b', 'c', 'd', 'e', 'f'], usedRecoveryCodes: ['g', 'h', 'i', 'j'] },
      true,
    ],
    [{ recoveryCodes: Array.from({ length: 11 }, (_, i) => `h${i}`) }, false],
    [
      {
        recoveryCodes: Array.from({ length: 6 }, (_, i) => `h${i}`),
        usedRecoveryCodes: ['a', 'b', 'c', 'd', 'e'],
      },
      false,
    ],
    [{ trustedDevices: Array.from({ length: 10 }, (_, i) => device(i)) }, true],
    [{ trustedDevices: Array.from({ length: 11 }, (_, i) => device(i)) }, false],
    [{ trustedDevices: { id: 'd1' } }, false],
  ])('takes %j: %p', async (opts, ok) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(as(admin));
      return write(db, admin.id, opts);
    });

    expect(outcome.ok).toBe(ok);
    if (!ok) expect(outcome).toMatchObject({ code: '23514' });
  });

  it('refuses a step or a count of wrong codes below 0', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      await writeOwn(db, admin);
      return {
        failed: await update(db, '"failedCodes" = -1', admin.id),
        // a new secret lets the step go back, never below 0
        step: await update(db, '"secretEnc" = \'v1:x:y:z\', "lastUsedStep" = -1', admin.id),
      };
    });

    expect(outcomes.failed).toMatchObject({ ok: false, code: '23514' });
    expect(outcomes.step).toMatchObject({ ok: false, code: '23514' });
  });
});
