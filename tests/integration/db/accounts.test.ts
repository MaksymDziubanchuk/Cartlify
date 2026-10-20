import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { changedRows } from '../../helpers/dbOrders.js';
import {
  closeSessions,
  createResetToken,
  createUser,
  createVerifyToken,
  uniqueEmail,
  uniqueTag,
  type TestUser,
} from '../../helpers/factories.js';

// the rows of users, user_tokens and login_logs under each role. A user reads and changes the
// own profile, never the own role, email, verification or deletion; root changes any account
// and alone deletes one. A user keeps the own sessions; the links of the mails come from the
// system. A login line is written once and stays as it is

let owner: TestUser;
let other: TestUser;
let unverified: TestUser;
let admin: TestUser;
let root: TestUser;

beforeAll(async () => {
  owner = await createUser({ name: 'Owner' });
  other = await createUser({ name: 'Other' });
  unverified = await createUser({ isVerified: false });
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions([owner.id, other.id, unverified.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asUser = (user: TestUser): Actor => ({ role: 'USER', userId: user.id });
const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });
const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });
const asGuest = (): Actor => ({ role: 'GUEST', guestId: randomUUID() });
// the system acts as an admin without an id: the oauth login, the password reset
const asSystem = (): Actor => ({ role: 'ADMIN' });

const usersSeen = async (db: DbSession, ids: number[]) =>
  (
    await db.rows<{ id: number }>(
      'select id from cartlify.users where id = any($1::int[]) order by id',
      ids,
    )
  ).map((row) => row.id);

const updateUser = (db: DbSession, set: string, userId: number, ...values: unknown[]) =>
  db.attempt(`update cartlify.users set ${set} where id = $1 returning id`, userId, ...values);

// without returning: a guest does not see the account it registers, a returned row has to pass
// the read policy too (the registration reads the id with currval)
const insertUser = (db: DbSession, columns: Record<string, unknown>) => {
  const names = Object.keys(columns);
  return db.attempt(
    `insert into cartlify.users (${names.map((name) => `"${name}"`).join(', ')})
     values (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
    ...Object.values(columns),
  );
};

const lastUserId = async (db: DbSession) =>
  (
    await db.rows<{ id: number }>(
      `select currval(pg_get_serial_sequence('cartlify.users', 'id'))::int as id`,
    )
  )[0]!.id;

// a new account the way the registration writes one, under the guest context
const registration = () => ({
  email: uniqueEmail('db-registered'),
  passwordHash: 'hash',
  role: 'USER',
  isVerified: false,
});

describe('users: reading', () => {
  it('shows a user only the own account', async () => {
    const seen = await inRolledBackTx(async (db) => {
      await db.as(asUser(owner));
      return usersSeen(db, [owner.id, other.id]);
    });

    expect(seen).toEqual([owner.id]);
  });

  it.each([
    ['an admin', asAdmin],
    ['root', asRoot],
  ])('shows %s every account', async (_who, actor) => {
    const seen = await inRolledBackTx(async (db) => {
      await db.as(actor());
      return usersSeen(db, [owner.id, other.id]);
    });

    expect(seen).toEqual([owner.id, other.id].sort((a, b) => a - b));
  });

  it('shows a guest no account', async () => {
    const seen = await inRolledBackTx(async (db) => {
      await db.as(asGuest());
      return usersSeen(db, [owner.id]);
    });

    expect(seen).toEqual([]);
  });
});

describe('users: a new account', () => {
  it('lets a guest register an unverified user', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asGuest());
      return insertUser(db, registration());
    });

    expect(outcome.ok).toBe(true);
  });

  it.each([
    ['a verified user', { isVerified: true }],
    ['an admin', { role: 'ADMIN' }],
    ['a root', { role: 'ROOT' }],
  ])('refuses a guest %s', async (_case, change) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asGuest());
      return insertUser(db, { ...registration(), ...change });
    });

    expect(outcome.ok).toBe(false);
  });

  it('lets the system create a verified user, the way an oauth login does', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asSystem());
      return insertUser(db, {
        email: uniqueEmail('db-oauth'),
        role: 'USER',
        isVerified: true,
        authProvider: 'GOOGLE',
        providerSub: `google-${uniqueTag()}`,
      });
    });

    expect(outcome.ok).toBe(true);
  });

  it('lets root create an admin', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asRoot());
      return insertUser(db, { ...registration(), role: 'ADMIN', isVerified: true });
    });

    expect(outcome.ok).toBe(true);
  });

  it.each([
    ['root a root', asRoot, 'ROOT'],
    ['an admin an admin', asAdmin, 'ADMIN'],
  ])('refuses %s', async (_case, actor, role) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(actor());
      return insertUser(db, { ...registration(), role, isVerified: true });
    });

    expect(outcome.ok).toBe(false);
  });

  // the registration and the login write emails in small letters; the database keeps one account
  // per email whatever the letters, or a login by the email finds one of two
  it('keeps one account per email, whatever the letters', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const email = uniqueEmail('db-case');
      await db.as(asGuest());
      await insertUser(db, { ...registration(), email });
      return insertUser(db, { ...registration(), email: email.toUpperCase() });
    });

    expect(outcome.ok).toBe(false);
  });
});

describe('users: the email of an account', () => {
  const emailOf = async (db: DbSession, id: number) => {
    await db.as(asAdmin());
    const [row] = await db.rows<{ email: string }>(
      'select email from cartlify.users where id = $1',
      id,
    );
    return row!.email;
  };

  it('writes the email of a new account in small letters without spaces around', async () => {
    const email = uniqueEmail('db-mixed');

    const stored = await inRolledBackTx(async (db) => {
      await db.as(asGuest());
      await insertUser(db, { ...registration(), email: `  ${email.toUpperCase()} ` });
      return emailOf(db, await lastUserId(db));
    });

    expect(stored).toBe(email);
  });

  it('writes an email root changes in small letters', async () => {
    const email = uniqueEmail('db-changed');

    const stored = await inRolledBackTx(async (db) => {
      await db.as(asRoot());
      await updateUser(db, 'email = $2', other.id, email.toUpperCase());
      return emailOf(db, other.id);
    });

    expect(stored).toBe(email);
  });
});

describe('users: a user changes the own account', () => {
  it('lets a user change the own name, phone, locale and avatar', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser(owner));
      return updateUser(
        db,
        `name = 'Anna', phone = '+380501234567', locale = 'uk',
         "avatarUrl" = 'https://res.cloudinary.com/demo/image/upload/v1/test/a.jpg',
         "publicId" = 'test/users/a'`,
        owner.id,
      );
    });

    expect(changedRows(outcome)).toBe(true);
  });

  it.each([
    ['make themselves an admin', `role = 'ADMIN'`],
    ['make themselves root', `role = 'ROOT'`],
    ['change the email', `email = 'someone.else@example.com'`],
    ['take the verification back', '"isVerified" = false'],
    ['mark the account deleted', '"deletedAt" = now()'],
  ])('does not let a user %s', async (_case, set) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser(owner));
      return updateUser(db, set, owner.id);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it('does not let an unverified local user verify the own email with a plain update', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser(unverified));
      return updateUser(db, '"isVerified" = true', unverified.id);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  // a login with an oauth provider of the same email proves the email: the account becomes the
  // provider's, verified, and loses the password someone else may have set at the registration
  it('lets an unverified local account become the account of an oauth provider', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser(unverified));
      return updateUser(
        db,
        `"authProvider" = 'GOOGLE', "providerSub" = $2, "isVerified" = true, "passwordHash" = null`,
        unverified.id,
        `google-${uniqueTag()}`,
      );
    });

    expect(changedRows(outcome)).toBe(true);
  });

  it('does not let a user change the account of another user', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser(owner));
      return updateUser(db, `name = 'Taken'`, other.id);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  // the access token of a deleted account lives on for some minutes
  it('does not let a user change the own account once it is deleted', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asRoot());
      await updateUser(db, '"deletedAt" = now()', owner.id);
      await db.as(asUser(owner));
      return updateUser(db, `name = 'Back again'`, owner.id);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  // root took the role away; the access token the admin still holds says ADMIN for some minutes
  it('does not let an admin give back the own role that root took away', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asRoot());
      await updateUser(db, `role = 'USER'`, admin.id);
      await db.as(asAdmin());
      return updateUser(db, `role = 'ADMIN'`, admin.id);
    });

    expect(changedRows(outcome)).toBe(false);
  });
});

describe('users: admin and root', () => {
  it.each([
    ['change another account', `name = 'Changed'`],
    ['make a user an admin', `role = 'ADMIN'`],
    ['mark an account deleted', '"deletedAt" = now()'],
  ])('does not let an admin %s', async (_case, set) => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asAdmin());
      return updateUser(db, set, owner.id);
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it('lets root make a user an admin and mark an account deleted', async () => {
    const { promoted, deleted } = await inRolledBackTx(async (db) => {
      await db.as(asRoot());
      return {
        promoted: await updateUser(db, `role = 'ADMIN'`, owner.id),
        deleted: await updateUser(db, '"deletedAt" = now()', other.id),
      };
    });

    expect(changedRows(promoted)).toBe(true);
    expect(changedRows(deleted)).toBe(true);
  });

  it('lets root alone delete the row of an account', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asGuest());
      await insertUser(db, registration());
      const id = await lastUserId(db);
      const removal = (actor: Actor) =>
        db
          .as(actor)
          .then(() => db.attempt('delete from cartlify.users where id = $1 returning id', id));

      return {
        byUser: await removal({ role: 'USER', userId: id }),
        byAdmin: await removal(asAdmin()),
        byRoot: await removal(asRoot()),
      };
    });

    expect(changedRows(outcome.byUser)).toBe(false);
    expect(changedRows(outcome.byAdmin)).toBe(false);
    expect(changedRows(outcome.byRoot)).toBe(true);
  });
});

describe('user tokens', () => {
  const tokensSeen = async (db: DbSession, userIds: number[]) =>
    (
      await db.rows<{ userId: number }>(
        'select distinct "userId" from cartlify.user_tokens where "userId" = any($1::int[]) order by 1',
        userIds,
      )
    ).map((row) => row.userId);

  const insertToken = (db: DbSession, userId: number, type: string, expiresIn = '1 day') =>
    db.attempt(
      `insert into cartlify.user_tokens ("userId", type, token, "expiresAt")
       values ($1, $2::cartlify."UserTokenType", $3, now() + $4::interval) returning id`,
      userId,
      type,
      `db-token-${uniqueTag()}`,
      expiresIn,
    );

  // a session the way a login opens one, under the context of the user
  const sessionOf = async (db: DbSession, user: TestUser) => {
    await db.as(asUser(user));
    const outcome = await insertToken(db, user.id, 'REFRESH_TOKEN');
    if (!outcome.ok) throw new Error(`a session was refused: ${outcome.message}`);
    return (outcome.rows[0] as { id: number }).id;
  };

  it('shows a user only the own tokens, an admin every one, a guest none', async () => {
    const seen = await inRolledBackTx(async (db) => {
      await sessionOf(db, owner);
      await sessionOf(db, other);
      const result: Record<string, number[]> = {};
      for (const [who, actor] of [
        ['owner', asUser(owner)],
        ['admin', asAdmin()],
        ['guest', asGuest()],
      ] as const) {
        await db.as(actor);
        result[who] = await tokensSeen(db, [owner.id, other.id]);
      }
      return result;
    });

    expect(seen).toEqual({
      owner: [owner.id],
      admin: [owner.id, other.id].sort((a, b) => a - b),
      guest: [],
    });
  });

  it('lets a user open a session of their own, not one for another user', async () => {
    const { own, foreign } = await inRolledBackTx(async (db) => {
      await db.as(asUser(owner));
      return {
        own: await insertToken(db, owner.id, 'REFRESH_TOKEN'),
        foreign: await insertToken(db, other.id, 'REFRESH_TOKEN'),
      };
    });

    expect(changedRows(own)).toBe(true);
    expect(foreign.ok).toBe(false);
  });

  // the link of the reset mail comes from /password/forgot: the system writes it, never the user;
  // a link of one's own would reset the password without knowing it, with a stolen session
  it('does not let a user write a password reset link, also not for themselves', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser(owner));
      return insertToken(db, owner.id, 'RESET_PASSWORD');
    });

    expect(outcome.ok).toBe(false);
  });

  // the system writes the reset links, the admin context without an id: a signed-in admin that
  // wrote one for an account would reset its password, the one of root as well
  it.each([
    ['admin', asAdmin],
    ['root', asRoot],
  ])(
    'does not let a signed-in %s write a password reset link for an account',
    async (_who, actor) => {
      const outcome = await inRolledBackTx(async (db) => {
        await db.as(actor());
        return insertToken(db, other.id, 'RESET_PASSWORD');
      });

      expect(outcome.ok).toBe(false);
    },
  );

  it('lets the system write a password reset link for an account', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asSystem());
      return insertToken(db, other.id, 'RESET_PASSWORD');
    });

    expect(outcome.ok).toBe(true);
  });

  it('refuses a guest a token', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asGuest());
      return insertToken(db, owner.id, 'REFRESH_TOKEN');
    });

    expect(outcome.ok).toBe(false);
  });

  it('lets a user close an own session', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await sessionOf(db, owner);
      return db.attempt(
        'update cartlify.user_tokens set "usedAt" = now() where id = $1 returning id',
        id,
      );
    });

    expect(changedRows(outcome)).toBe(true);
  });

  // a session ends with the logout, the rotation or the reset of the password, and stays ended
  it('does not let a user open a closed session again', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await sessionOf(db, owner);
      await db.rows(
        'update cartlify.user_tokens set "usedAt" = now() where id = $1 returning id',
        id,
      );
      return db.attempt(
        'update cartlify.user_tokens set "usedAt" = null where id = $1 returning id',
        id,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it('does not let a user give a token to another user or touch the token of another user', async () => {
    const { moved, foreign, removal } = await inRolledBackTx(async (db) => {
      const own = await sessionOf(db, owner);
      const othersToken = await sessionOf(db, other);
      await db.as(asUser(owner));
      return {
        moved: await db.attempt(
          'update cartlify.user_tokens set "userId" = $2 where id = $1 returning id',
          own,
          other.id,
        ),
        foreign: await db.attempt(
          'update cartlify.user_tokens set "usedAt" = now() where id = $1 returning id',
          othersToken,
        ),
        removal: await db.attempt(
          'delete from cartlify.user_tokens where id = $1 returning id',
          othersToken,
        ),
      };
    });

    expect(changedRows(moved)).toBe(false);
    expect(changedRows(foreign)).toBe(false);
    expect(changedRows(removal)).toBe(false);
  });

  // a session row made into a reset link would be the link a user may not write
  it('does not let a user make an own session into another kind of link', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await sessionOf(db, owner);
      return db.attempt(
        `update cartlify.user_tokens set type = 'RESET_PASSWORD', token = $2 where id = $1 returning id`,
        id,
        `db-token-${uniqueTag()}`,
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });

  // the login makes the row first and writes its hash and deadline next (a fixed deadline)
  it('lets a session of the user get its hash and deadline after it is made', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await sessionOf(db, owner);
      return db.attempt(
        `update cartlify.user_tokens set token = $2, "expiresAt" = now() + interval '30 days'
         where id = $1 returning id`,
        id,
        `db-token-${uniqueTag()}`,
      );
    });

    expect(changedRows(outcome)).toBe(true);
  });

  // an oauth login that takes over an unverified local account closes its verification links
  it('lets a user close an own verification link', async () => {
    await createVerifyToken(owner.id);

    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser(owner));
      return db.attempt(
        `update cartlify.user_tokens set "usedAt" = now()
         where "userId" = $1 and type = 'VERIFY_EMAIL' and "usedAt" is null returning id`,
        owner.id,
      );
    });

    expect(changedRows(outcome)).toBe(true);
  });

  // anyone may ask /password/forgot for a link to any email; its owner sees it and must not
  // put a code of their own into it
  it.each([
    ['the code', 'token = $2', () => [`db-token-${uniqueTag()}`]],
    ['the deadline', `"expiresAt" = now() + interval '1 year'`, () => []],
  ])('does not let a user change %s of an own reset link', async (_case, set, values) => {
    await createResetToken(owner.id);

    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser(owner));
      const [link] = await db.rows<{ id: number }>(
        `select id from cartlify.user_tokens
         where "userId" = $1 and type = 'RESET_PASSWORD' and "usedAt" is null limit 1`,
        owner.id,
      );
      return db.attempt(
        `update cartlify.user_tokens set ${set} where id = $1 returning id`,
        link!.id,
        ...values(),
      );
    });

    expect(changedRows(outcome)).toBe(false);
  });

  it('lets the system use up a reset link, and nobody open it again', async () => {
    await createResetToken(other.id);

    const { used, reopened } = await inRolledBackTx(async (db) => {
      await db.as(asSystem());
      const [link] = await db.rows<{ id: number }>(
        `select id from cartlify.user_tokens
         where "userId" = $1 and type = 'RESET_PASSWORD' and "usedAt" is null limit 1`,
        other.id,
      );
      const used = await db.attempt(
        'update cartlify.user_tokens set "usedAt" = now() where id = $1 returning id',
        link!.id,
      );
      const reopened = await db.attempt(
        'update cartlify.user_tokens set "usedAt" = null where id = $1 returning id',
        link!.id,
      );
      return { used, reopened };
    });

    expect(changedRows(used)).toBe(true);
    expect(changedRows(reopened)).toBe(false);
  });

  it('lets a user delete an own token', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      const id = await sessionOf(db, owner);
      return db.attempt('delete from cartlify.user_tokens where id = $1 returning id', id);
    });

    expect(changedRows(outcome)).toBe(true);
  });

  it('keeps the password reset link of a user away from another user', async () => {
    await createResetToken(other.id);

    const seen = await inRolledBackTx(async (db) => {
      await db.as(asUser(owner));
      return db.rows(
        `select id from cartlify.user_tokens where "userId" = $1 and type = 'RESET_PASSWORD'`,
        other.id,
      );
    });

    expect(seen).toEqual([]);
  });
});

describe('login logs', () => {
  const insertLogin = (db: DbSession, user: TestUser) =>
    db.attempt(
      `insert into cartlify.login_logs ("userId", email, role) values ($1, $2, 'USER') returning id`,
      user.id,
      user.email,
    );

  const loginOf = async (db: DbSession, user: TestUser) => {
    await db.as(asUser(user));
    const outcome = await insertLogin(db, user);
    if (!outcome.ok) throw new Error(`a login line was refused: ${outcome.message}`);
    return (outcome.rows[0] as { id: number }).id;
  };

  it('shows a user only the own logins, an admin every one', async () => {
    const { own, foreign, asOwner, asAdminSeen } = await inRolledBackTx(async (db) => {
      const own = await loginOf(db, owner);
      const foreign = await loginOf(db, other);
      const ids = [own, foreign];
      const seen = async () =>
        (
          await db.rows<{ id: number }>(
            'select id from cartlify.login_logs where id = any($1::int[]) order by id',
            ids,
          )
        ).map((row) => row.id);

      await db.as(asUser(owner));
      const asOwner = await seen();
      await db.as(asAdmin());
      return { own, foreign, asOwner, asAdminSeen: await seen() };
    });

    expect(asOwner).toEqual([own]);
    expect(asAdminSeen).toEqual([own, foreign]);
  });

  it('lets a user write the own login, not one of another user', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as(asUser(owner));
      return insertLogin(db, other);
    });

    expect(outcome.ok).toBe(false);
  });

  it.each([
    ['the user', (user: TestUser): Actor => asUser(user)],
    ['an admin', (): Actor => asAdmin()],
    ['root', (): Actor => asRoot()],
  ])('lets %s change or delete no login line', async (_who, actor) => {
    const { update, removal } = await inRolledBackTx(async (db) => {
      const id = await loginOf(db, owner);
      await db.as(actor(owner));
      return {
        update: await db.attempt(
          `update cartlify.login_logs set "ipAddress" = '203.0.113.1' where id = $1 returning id`,
          id,
        ),
        removal: await db.attempt('delete from cartlify.login_logs where id = $1 returning id', id),
      };
    });

    expect(changedRows(update)).toBe(false);
    expect(changedRows(removal)).toBe(false);
  });
});
