import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';
import { hashToken } from '@helpers/tokenHash.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createResetToken,
  createUser,
  createVerifyToken,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../helpers/factories.js';

// the functions of the accounts, each acts as the owner and checks the actor first. The guest
// ones: auth_get_user_for_login (what the login compares), auth_verify_email (the link of the
// mail, kept only as its hash), auth_resend_verify (a new link that closes the open ones). The
// one of a user that just signed in: migrate_guest_data_to_user (favorites and chats of the guest)

const DAY = 86_400_000;

let verified: TestUser;
let pending: TestUser;
let admin: TestUser;
let first: TestProduct;
let second: TestProduct;

beforeAll(async () => {
  verified = await createUser();
  pending = await createUser({ isVerified: false });
  admin = await createUser({ role: 'ADMIN' });
  first = await createProduct();
  second = await createProduct();
});

afterAll(async () => {
  try {
    await closeSessions([verified.id, pending.id, admin.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asGuest = (guestId: string = randomUUID()): Actor => ({ role: 'GUEST', guestId });
const asUser = (user: TestUser): Actor => ({ role: 'USER', userId: user.id });

async function call(db: DbSession, actor: Actor, statement: string, ...values: unknown[]) {
  await db.as(actor);
  const outcome = await db.attempt<Record<string, unknown>>(statement, ...values);
  return outcome.ok ? { ok: true, rows: outcome.rows } : { ok: false, error: outcome.message };
}

const verifiedOf = async (db: DbSession, userId: number) => {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const [row] = await db.rows<{ isVerified: boolean }>(
    'select "isVerified" from cartlify.users where id = $1',
    userId,
  );
  return row!.isVerified;
};

const verify = (db: DbSession, rawToken: string) =>
  call(db, asGuest(), 'select cartlify.auth_verify_email($1) as verified', hashToken(rawToken));

const resend = (db: DbSession, email: string, rawToken: string, expiresIn = '1 day') =>
  call(
    db,
    asGuest(),
    `select user_id as "userId", token from cartlify.auth_resend_verify($1, $2, now() + $3::interval)`,
    email,
    hashToken(rawToken),
    expiresIn,
  );

describe('cartlify.auth_get_user_for_login', () => {
  const lookUp = (db: DbSession, actor: Actor, email: string) =>
    call(
      db,
      actor,
      `select id, role::text as role, is_verified as "isVerified",
              auth_provider::text as "authProvider", password_hash is not null as "hasPassword"
       from cartlify.auth_get_user_for_login($1)`,
      email,
    );

  it('gives a guest what the login compares, also for an email in other letters and spaces', async () => {
    const outcome = await inRolledBackTx((db) =>
      lookUp(db, asGuest(), `  ${verified.email.toUpperCase()} `),
    );

    expect(outcome).toEqual({
      ok: true,
      rows: [
        {
          id: verified.id,
          role: 'USER',
          isVerified: true,
          authProvider: 'LOCAL',
          hasPassword: true,
        },
      ],
    });
  });

  it('gives no row for an email nobody has', async () => {
    const outcome = await inRolledBackTx((db) =>
      lookUp(db, asGuest(), `nobody-${uniqueTag()}@example.com`),
    );

    expect(outcome).toEqual({ ok: true, rows: [] });
  });

  it.each([
    ['a user', (): Actor => asUser(verified)],
    ['an admin', (): Actor => ({ role: 'ADMIN', userId: admin.id })],
    ['root', (): Actor => ({ role: 'ROOT', userId: admin.id })],
  ])('refuses %s', async (_who, actor) => {
    const outcome = await inRolledBackTx((db) => lookUp(db, actor(), verified.email));

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('LOGIN_LOOKUP_FORBIDDEN'),
    });
  });
});

describe('cartlify.auth_verify_email', () => {
  it('verifies the email with an open link, and the link is used up', async () => {
    const token = await createVerifyToken(pending.id);

    const {
      first: firstTry,
      again,
      isVerified,
    } = await inRolledBackTx(async (db) => {
      const firstTry = await verify(db, token);
      const again = await verify(db, token);
      return { first: firstTry, again, isVerified: await verifiedOf(db, pending.id) };
    });

    expect(firstTry).toEqual({ ok: true, rows: [{ verified: true }] });
    expect(again).toEqual({ ok: true, rows: [{ verified: false }] });
    expect(isVerified).toBe(true);
  });

  it.each([
    [
      'a link whose time is over',
      () =>
        createVerifyToken(pending.id, {
          createdAt: new Date(Date.now() - 2 * DAY),
          expiresAt: new Date(Date.now() - DAY),
        }),
    ],
    ['the link of a password reset', () => createResetToken(pending.id)],
    ['a link nobody got', async () => `never-sent-${uniqueTag()}`],
  ])('does not verify with %s', async (_case, linkOf) => {
    const token = await linkOf();

    const { outcome, isVerified } = await inRolledBackTx(async (db) => ({
      outcome: await verify(db, token),
      isVerified: await verifiedOf(db, pending.id),
    }));

    expect(outcome).toEqual({ ok: true, rows: [{ verified: false }] });
    expect(isVerified).toBe(false);
  });

  // the database keeps only the hash: the code of the link itself is no hash of any link
  it('does not verify with the hash of a link given as the link', async () => {
    const token = await createVerifyToken(pending.id);

    const outcome = await inRolledBackTx((db) =>
      call(
        db,
        asGuest(),
        'select cartlify.auth_verify_email($1) as verified',
        hashToken(hashToken(token)),
      ),
    );

    expect(outcome).toEqual({ ok: true, rows: [{ verified: false }] });
  });

  it('refuses a user', async () => {
    const token = await createVerifyToken(pending.id);

    const outcome = await inRolledBackTx((db) =>
      call(db, asUser(pending), 'select cartlify.auth_verify_email($1)', hashToken(token)),
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('VERIFY_EMAIL_FORBIDDEN'),
    });
  });
});

describe('cartlify.auth_resend_verify', () => {
  it('gives an unverified user a new link and closes the open one', async () => {
    const before = await createVerifyToken(pending.id);
    const after = `resent-${uniqueTag()}`;

    const { outcome, oldLink, newLink } = await inRolledBackTx(async (db) => {
      const outcome = await resend(db, pending.email, after);
      return { outcome, oldLink: await verify(db, before), newLink: await verify(db, after) };
    });

    expect(outcome).toEqual({ ok: true, rows: [{ userId: pending.id, token: hashToken(after) }] });
    expect(oldLink).toEqual({ ok: true, rows: [{ verified: false }] });
    expect(newLink).toEqual({ ok: true, rows: [{ verified: true }] });
  });

  // the answer is the same for a verified account and for no account: nobody learns which
  // emails have an account
  it.each([
    ['a verified user', () => verified.email],
    ['an email nobody has', () => `nobody-${uniqueTag()}@example.com`],
  ])('gives no link to %s', async (_case, emailOf) => {
    const raw = `resent-${uniqueTag()}`;

    const { outcome, written } = await inRolledBackTx(async (db) => {
      const outcome = await resend(db, emailOf(), raw);
      await db.as({ role: 'ADMIN', userId: admin.id });
      const written = await db.rows(
        'select id from cartlify.user_tokens where token = $1',
        hashToken(raw),
      );
      return { outcome, written };
    });

    expect(outcome).toEqual({ ok: true, rows: [] });
    expect(written).toEqual([]);
  });

  it('gives no link whose time is over already', async () => {
    const outcome = await inRolledBackTx((db) =>
      resend(db, pending.email, `resent-${uniqueTag()}`, '-1 minute'),
    );

    expect(outcome).toEqual({ ok: true, rows: [] });
  });

  it('refuses a user', async () => {
    const outcome = await inRolledBackTx((db) =>
      call(
        db,
        asUser(pending),
        `select * from cartlify.auth_resend_verify($1, $2, now() + interval '1 day')`,
        pending.email,
        hashToken(`resent-${uniqueTag()}`),
      ),
    );

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('VERIFY_RESEND_FORBIDDEN'),
    });
  });
});

describe('cartlify.migrate_guest_data_to_user', () => {
  // what the guest did before the login: two favorites and an open chat with the bot
  async function guestWithData(db: DbSession, guestId: string) {
    await db.as(asGuest(guestId));
    for (const product of [first, second]) {
      await db.rows(
        'insert into cartlify.favorites ("guestId", "productId") values ($1::uuid, $2) returning id',
        guestId,
        product.id,
      );
    }
    const threadId = randomUUID();
    await db.rows(
      `insert into cartlify.chat_threads (id, "guestId", type, status)
       values ($1::uuid, $2::uuid, 'bot', 'open') returning id`,
      threadId,
      guestId,
    );
    return threadId;
  }

  const migrate = (db: DbSession, actor: Actor, guestId: string, userId: number) =>
    call(
      db,
      actor,
      'select 1 as done from cartlify.migrate_guest_data_to_user($1::uuid, $2::int)',
      guestId,
      userId,
    );

  const stateOf = async (db: DbSession, guestId: string, userId: number, threadId: string) => {
    await db.as({ role: 'ADMIN', userId: admin.id });
    const favorites = await db.rows<{ productId: number }>(
      'select "productId" from cartlify.favorites where "userId" = $1 order by "productId"',
      userId,
    );
    const leftToGuest = await db.rows(
      'select id from cartlify.favorites where "guestId" = $1::uuid',
      guestId,
    );
    const [thread] = await db.rows<{
      userId: number | null;
      guestId: string | null;
      status: string;
    }>(
      `select "userId", "guestId"::text as "guestId", status::text as status
       from cartlify.chat_threads where id = $1::uuid`,
      threadId,
    );
    return { favorites: favorites.map((row) => row.productId), leftToGuest, thread };
  };

  it('gives the user the favorites and the open chat of the guest, a favorite once', async () => {
    const user = await createUser();
    const guestId = randomUUID();

    const { outcome, state } = await inRolledBackTx(async (db) => {
      const threadId = await guestWithData(db, guestId);
      await db.as(asUser(user));
      await db.rows(
        'insert into cartlify.favorites ("userId", "productId") values ($1, $2) returning id',
        user.id,
        first.id,
      );
      const outcome = await migrate(db, asUser(user), guestId, user.id);
      return { outcome, state: await stateOf(db, guestId, user.id, threadId) };
    });

    expect(outcome.ok).toBe(true);
    expect(state).toEqual({
      favorites: [first.id, second.id].sort((a, b) => a - b),
      leftToGuest: [],
      thread: { userId: user.id, guestId: null, status: 'open' },
    });
  });

  // a user has one open chat: the one of the guest comes closed
  it('closes the chat of the guest when the user has an open chat already', async () => {
    const user = await createUser();
    const guestId = randomUUID();

    const state = await inRolledBackTx(async (db) => {
      const threadId = await guestWithData(db, guestId);
      await db.as(asUser(user));
      await db.rows(
        `insert into cartlify.chat_threads (id, "userId", type, status)
         values ($1::uuid, $2, 'bot', 'open') returning id`,
        randomUUID(),
        user.id,
      );
      await migrate(db, asUser(user), guestId, user.id);
      return stateOf(db, guestId, user.id, threadId);
    });

    expect(state.thread).toEqual({ userId: user.id, guestId: null, status: 'closed' });
  });

  it.each([
    ['a user for another user', (): Actor => asUser(verified), () => pending.id],
    ['a guest', (): Actor => asGuest(), () => pending.id],
  ])('refuses %s', async (_case, actor, userIdOf) => {
    const outcome = await inRolledBackTx((db) => migrate(db, actor(), randomUUID(), userIdOf()));

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining('GUEST_MIGRATION_FORBIDDEN'),
    });
  });
});
