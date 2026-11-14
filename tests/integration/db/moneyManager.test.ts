import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type Outcome } from '../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';
import { giveMoneyRight, moneyRightOf } from '../../helpers/moneyManager.js';
import { giveNewsletterRight, newsletterRightOf } from '../../helpers/newsletterManager.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';

// the right of an admin to handle the money of the shop the way root does (users."canManageMoney"):
// the function of the database that answers whether the actor of a statement has it, the function
// root gives and takes it with, and what the database lets anybody else do with the column. The
// money functions that let root through let such an admin through too: the routes check that

let root: TestUser;
let plainAdmin: TestUser;
let manager: TestUser;
let stranger: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const ROOT = (): Actor => ({ role: 'ROOT', userId: root.id });
const PLAIN_ADMIN = (): Actor => ({ role: 'ADMIN', userId: plainAdmin.id });
const MANAGER = (): Actor => ({ role: 'ADMIN', userId: manager.id });
const SYSTEM: Actor = { role: 'ADMIN' };

const resultOf = (outcome: Outcome): string =>
  outcome.ok ? (outcome.rows.length ? 'row' : 'none') : (outcome.code ?? 'refused');

const FLAG_OF = `select "canManageMoney" as flag, role::text as role from cartlify.users where id = $1`;
const ASK = 'select cartlify.money_manager() as manager';
const SET = 'select cartlify.money_set_manager($1::int, $2::boolean) as changed';

beforeAll(async () => {
  root = await newUser({ role: 'ROOT' });
  plainAdmin = await newUser({ role: 'ADMIN' });
  manager = await newUser({ role: 'ADMIN' });
  stranger = await newUser();
  await giveMoneyRight(root.id, manager.id);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await prisma.$disconnect();
  }
});

describe('cartlify.money_manager', () => {
  it.each([
    ['root', ROOT, true],
    ['an admin root allowed', MANAGER, true],
    ['an admin root did not allow', PLAIN_ADMIN, false],
    ['a buyer', () => ({ role: 'USER', userId: stranger.id }) as Actor, false],
    ['the system', () => SYSTEM, false],
    ['no context', () => null, false],
  ] as [string, () => Actor | null, boolean][])('answers for %s', async (_who, actor, expected) => {
    const [row] = await inRolledBackTx(async (db) => {
      await db.as(actor());
      return db.rows<{ manager: boolean }>(ASK);
    });

    expect(row).toEqual({ manager: expected });
  });

  it('is false for an admin whose token names the role but whose account is a buyer now', async () => {
    const [row] = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: stranger.id });
      return db.rows<{ manager: boolean }>(ASK);
    });

    expect(row).toEqual({ manager: false });
  });

  it('is false for an admin with the right whose account was deleted', async () => {
    const [row] = await inOwnerTx(async (db) => {
      await db.as(ROOT());
      await db.rows(
        `update cartlify.users set "deletedAt" = now() at time zone 'UTC' where id = $1`,
        manager.id,
      );
      await db.as(MANAGER());
      return db.rows<{ manager: boolean }>(ASK);
    });

    expect(row).toEqual({ manager: false });
  });

  it('is its own right: the right to run the newsletters does not give it', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    await giveNewsletterRight(root.id, admin.id);

    const [row] = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: admin.id });
      return db.rows<{ manager: boolean; newsletters: boolean }>(
        'select cartlify.money_manager() as manager, cartlify.newsletter_manager() as newsletters',
      );
    });

    expect(row).toEqual({ manager: false, newsletters: true });
  });
});

describe('cartlify.money_set_manager', () => {
  it('allows an admin and takes the right away again; a repeated step changes nothing', async () => {
    const admin = await newUser({ role: 'ADMIN' });

    const steps = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      const on = await db.rows<{ changed: boolean }>(SET, admin.id, true);
      const again = await db.rows<{ changed: boolean }>(SET, admin.id, true);
      const [flag] = await db.rows<{ flag: boolean }>(FLAG_OF, admin.id);
      const off = await db.rows<{ changed: boolean }>(SET, admin.id, false);
      const offAgain = await db.rows<{ changed: boolean }>(SET, admin.id, false);
      const [after] = await db.rows<{ flag: boolean }>(FLAG_OF, admin.id);
      return { on, again, flag: flag!.flag, off, offAgain, after: after!.flag };
    });

    expect(steps).toEqual({
      on: [{ changed: true }],
      again: [{ changed: false }],
      flag: true,
      off: [{ changed: true }],
      offAgain: [{ changed: false }],
      after: false,
    });
  });

  it('works at once for the admin: the right is read from the database on every call', async () => {
    const admin = await newUser({ role: 'ADMIN' });

    const answers = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: admin.id });
      const [before] = await db.rows<{ manager: boolean }>(ASK);
      await db.as(ROOT());
      await db.rows(SET, admin.id, true);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const [after] = await db.rows<{ manager: boolean }>(ASK);
      return { before: before!.manager, after: after!.manager };
    });

    expect(answers).toEqual({ before: false, after: true });
  });

  it('changes the right of the money of that admin only, and nothing else of the account', async () => {
    const admin = await newUser({ role: 'ADMIN' });

    const rows = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      const read = () =>
        db.rows<Record<string, unknown>>(
          `select email, role::text as role, "canManageNewsletters", "deletedAt", "isVerified"
           from cartlify.users where id = $1`,
          admin.id,
        );
      const [before] = await read();
      await db.rows(SET, admin.id, true);
      const [after] = await read();
      const [other] = await db.rows<{ flag: boolean }>(FLAG_OF, plainAdmin.id);
      return { before, after, other: other!.flag };
    });

    expect(rows.after).toEqual(rows.before);
    expect(rows.other).toBe(false);
  });

  it('takes the right away when no value is given: no value is no right', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      const changed = await db.rows<{ changed: boolean }>(SET, manager.id, null);
      const [flag] = await db.rows<{ flag: boolean }>(FLAG_OF, manager.id);
      return { changed, flag: flag!.flag };
    });

    expect(outcome).toEqual({ changed: [{ changed: true }], flag: false });
  });

  it.each([
    ['an admin who tries to allow themselves', PLAIN_ADMIN, () => plainAdmin.id],
    ['an admin with the right, for another admin', MANAGER, () => plainAdmin.id],
    ['the system', () => SYSTEM, () => plainAdmin.id],
    ['a buyer', () => ({ role: 'USER', userId: stranger.id }) as Actor, () => plainAdmin.id],
  ] as [string, () => Actor, () => number][])(
    'is refused to %s: only root gives and takes the right',
    async (_who, actor, targetId) => {
      const outcome = await inRolledBackTx(async (db) => {
        await db.as(actor());
        return db.attempt(SET, targetId(), true);
      });

      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('MONEY_FORBIDDEN'),
      });
    },
  );

  it('is done by root without an account too: root is root', async () => {
    const admin = await newUser({ role: 'ADMIN' });

    const changed = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ROOT' });
      return db.rows<{ changed: boolean }>(SET, admin.id, true);
    });

    expect(changed).toEqual([{ changed: true }]);
  });

  it.each([
    ['a buyer', () => stranger.id],
    ['root', () => root.id],
    ['an account there is not', () => 2_147_000_000],
  ] as [string, () => number][])(
    'does not allow %s: the right is an admin one',
    async (_who, targetId) => {
      const outcome = await inRolledBackTx(async (db) => {
        await db.as(ROOT());
        return db.attempt(SET, targetId(), true);
      });

      expect(outcome).toMatchObject({
        ok: false,
        message: expect.stringContaining('MONEY_TARGET_NOT_ADMIN'),
      });
    },
  );

  it('does not allow an admin whose account was deleted, but takes the right away from one', async () => {
    const outcome = await inOwnerTx(async (db) => {
      await db.as(ROOT());
      await db.rows(
        `update cartlify.users set "deletedAt" = now() at time zone 'UTC' where id = $1`,
        plainAdmin.id,
      );
      const allow = await db.attempt(SET, plainAdmin.id, true);
      await db.rows(
        `update cartlify.users set "deletedAt" = now() at time zone 'UTC' where id = $1`,
        manager.id,
      );
      const takeAway = await db.attempt<{ changed: boolean }>(SET, manager.id, false);
      return { allow, takeAway };
    });

    expect(outcome.allow).toMatchObject({
      ok: false,
      message: expect.stringContaining('MONEY_TARGET_NOT_ADMIN'),
    });
    expect(outcome.takeAway).toEqual({ ok: true, rows: [{ changed: true }] });
  });

  it('answers false when taking the right away from an account there is not', async () => {
    const changed = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      return db.rows<{ changed: boolean }>(SET, 2_147_000_000, false);
    });

    expect(changed).toEqual([{ changed: false }]);
  });
});

describe('the right of the money, on the account', () => {
  it('goes off by itself when root takes the role of admin away, together with the right of the newsletters', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    await giveMoneyRight(root.id, admin.id);
    await giveNewsletterRight(root.id, admin.id);

    const after = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      await db.rows(`update cartlify.users set role = 'USER' where id = $1`, admin.id);
      const [row] = await db.rows<Record<string, unknown>>(
        `select "canManageMoney" as money, "canManageNewsletters" as newsletters, role::text as role
         from cartlify.users where id = $1`,
        admin.id,
      );
      return row;
    });

    expect(after).toEqual({ money: false, newsletters: false, role: 'USER' });
    expect(await moneyRightOf(admin.id)).toBe(true);
    expect(await newsletterRightOf(admin.id)).toBe(true);
  });

  it('is not given back when the role comes back: root allows an admin anew', async () => {
    const after = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      await db.rows(`update cartlify.users set role = 'USER' where id = $1`, manager.id);
      await db.rows(`update cartlify.users set role = 'ADMIN' where id = $1`, manager.id);
      const [row] = await db.rows<{ flag: boolean; role: string }>(FLAG_OF, manager.id);
      await db.as(MANAGER());
      const [asked] = await db.rows<{ manager: boolean }>(ASK);
      return { row, asked };
    });

    expect(after).toEqual({ row: { flag: false, role: 'ADMIN' }, asked: { manager: false } });
  });

  it.each([
    ['root, in a statement of their own', ROOT, () => plainAdmin.id],
    ['the admin, on their own account', PLAIN_ADMIN, () => plainAdmin.id],
    ['an admin that has it, taking it off themselves', MANAGER, () => manager.id],
  ] as [string, () => Actor, () => number][])(
    'is not set by %s: only the function of the database for root takes this step',
    async (_who, actor, targetId) => {
      const outcome = await inRolledBackTx(async (db) => {
        await db.as(actor());
        return db.attempt(
          `update cartlify.users set "canManageMoney" = not "canManageMoney" where id = $1 returning id`,
          targetId(),
        );
      });

      expect(outcome).toMatchObject({
        ok: false,
        code: '42501',
        message: expect.stringContaining('USER_UPDATE_FORBIDDEN'),
      });
    },
  );

  it('does not come with a new role: an account that becomes an admin does not get it with the role', async () => {
    const buyer = await newUser();

    const outcome = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      return db.attempt(
        `update cartlify.users set role = 'ADMIN', "canManageMoney" = true where id = $1 returning id`,
        buyer.id,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '42501' });
  });

  const INSERT_USER = `insert into cartlify.users (email, role, "canManageMoney")
    values ($1, $2::cartlify."Role", $3::boolean) returning id`;
  const freshEmail = () => `money-${Math.random().toString(16).slice(2, 14)}@example.com`;

  it.each([
    ['root inserting an admin', ROOT, 'ADMIN'],
    ['the system inserting a buyer', () => SYSTEM, 'USER'],
  ] as [string, () => Actor, string][])(
    'is not part of a new account: %s with the right is refused',
    async (_who, actor, role) => {
      const outcome = await inRolledBackTx(async (db) => {
        await db.as(actor());
        return db.attempt(INSERT_USER, freshEmail(), role, true);
      });

      expect(outcome).toMatchObject({
        ok: false,
        code: '42501',
        message: expect.stringContaining('USER_INSERT_FORBIDDEN'),
      });
    },
  );

  it('lets root insert an admin without it, and the account has no right then', async () => {
    const created = await inRolledBackTx(async (db) => {
      await db.as(ROOT());
      const outcome = await db.attempt<{ id: number }>(INSERT_USER, freshEmail(), 'ADMIN', false);
      const rows = outcome.ok ? await db.rows<{ flag: boolean }>(FLAG_OF, outcome.rows[0]!.id) : [];
      return { outcome: resultOf(outcome), rows };
    });

    expect(created).toEqual({ outcome: 'row', rows: [{ flag: false, role: 'ADMIN' }] });
  });

  it.each([
    ['an admin', MANAGER],
    ['the system', () => SYSTEM],
  ] as [string, () => Actor][])(
    'is not set by a function that runs for %s, only for root',
    async (_who, actor) => {
      const outcome = await inOwnerTx(async (db) => {
        await db.as(actor());
        return db.attempt(
          `update cartlify.users set "canManageMoney" = true where id = $1 returning id`,
          plainAdmin.id,
        );
      });

      expect(outcome).toMatchObject({ ok: false, code: '42501' });
    },
  );

  it('belongs to an admin only: a buyer cannot have it, whoever sets it', async () => {
    const outcome = await inOwnerTx(async (db) => {
      await db.as(ROOT());
      return db.attempt(
        `update cartlify.users set "canManageMoney" = true where id = $1 returning id`,
        stranger.id,
      );
    });

    expect(outcome).toMatchObject({ ok: false, code: '23514' });
  });
});
