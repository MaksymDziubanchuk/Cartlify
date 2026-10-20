import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// cartlify.users_get_public_profile: the profile of a user by id. It acts as the owner, since a
// user cannot read another row of users. A user gets the name, the avatar and the dates, no
// email; an admin or root gets the whole profile. The password, the provider id and the id of the
// avatar file nobody gets. A deleted account is gone for everybody but an admin

const AVATAR = 'https://res.cloudinary.com/demo/image/upload/v1/test/users/1/avatar.jpg';

// what the function gives to an admin and only to an admin
const ADMIN_FIELDS = {
  email: null,
  role: null,
  auth_provider: null,
  is_verified: null,
  locale: null,
  phone: null,
};

let viewer: TestUser;
let target: TestUser;
let admin: TestUser;

const profileOf = async (db: DbSession, userId: number) =>
  db.rows<Record<string, unknown>>(
    `select id, name, avatar_url, email, role::text as role, auth_provider::text as auth_provider,
            is_verified, locale, phone, deleted_at is not null as deleted,
            created_at is not null as dated
     from cartlify.users_get_public_profile($1::int)`,
    userId,
  );

const deleteAccountOf = async (db: DbSession, userId: number) => {
  await db.as({ role: 'ROOT', userId: admin.id });
  await db.rows('update cartlify.users set "deletedAt" = now() where id = $1 returning 1', userId);
};

beforeAll(async () => {
  viewer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  target = await createUser({
    name: 'Anna',
    locale: 'uk',
    phone: '+380501234567',
    avatarUrl: AVATAR,
    publicId: 'test/users/1/avatar',
  });
});

afterAll(async () => {
  try {
    await closeSessions([viewer.id, admin.id, target.id]);
  } finally {
    await prisma.$disconnect();
  }
});

describe('cartlify.users_get_public_profile', () => {
  it('gives a user the name, the avatar and the dates of another user, no email and no field of an admin', async () => {
    const rows = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: viewer.id });
      return profileOf(db, target.id);
    });

    expect(rows).toEqual([
      {
        id: target.id,
        name: 'Anna',
        avatar_url: AVATAR,
        ...ADMIN_FIELDS,
        deleted: false,
        dated: true,
      },
    ]);
  });

  it('gives a user no email of their own account either', async () => {
    const rows = await inRolledBackTx(async (db) => {
      await db.as({ role: 'USER', userId: target.id });
      return profileOf(db, target.id);
    });

    expect(rows).toEqual([expect.objectContaining({ id: target.id, email: null, phone: null })]);
  });

  it.each(['ADMIN', 'ROOT'] as const)('gives an %s the whole profile', async (role) => {
    const rows = await inRolledBackTx(async (db) => {
      await db.as({ role, userId: admin.id });
      return profileOf(db, target.id);
    });

    expect(rows).toEqual([
      {
        id: target.id,
        name: 'Anna',
        avatar_url: AVATAR,
        email: target.email,
        role: 'USER',
        auth_provider: 'LOCAL',
        is_verified: true,
        locale: 'uk',
        phone: '+380501234567',
        deleted: false,
        dated: true,
      },
    ]);
  });

  it('gives nobody the password, the provider id or the id of the avatar file', async () => {
    const [result] = await inRolledBackTx((db) =>
      db.rows<{ columns: string }>(
        `select pg_get_function_result(
           to_regprocedure('cartlify.users_get_public_profile(integer)')) as columns`,
      ),
    );

    expect(result!.columns).toMatch(/^TABLE\(/);
    expect(result!.columns).not.toMatch(/password|provider_sub|public_id/);
  });

  it('hides a deleted account from a user', async () => {
    const rows = await inRolledBackTx(async (db) => {
      await deleteAccountOf(db, target.id);
      await db.as({ role: 'USER', userId: viewer.id });
      return profileOf(db, target.id);
    });

    expect(rows).toEqual([]);
  });

  it('gives an admin a deleted account with the time it was deleted', async () => {
    const rows = await inRolledBackTx(async (db) => {
      await deleteAccountOf(db, target.id);
      await db.as({ role: 'ADMIN', userId: admin.id });
      return db.rows<{ id: number; deleted_at: Date | null }>(
        'select id, deleted_at from cartlify.users_get_public_profile($1::int)',
        target.id,
      );
    });

    expect(rows).toEqual([{ id: target.id, deleted_at: expect.any(Date) }]);
  });

  it('gives no row for a user that does not exist', async () => {
    const rows = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: admin.id });
      return profileOf(db, 2_000_000_000);
    });

    expect(rows).toEqual([]);
  });

  it('refuses a guest', async () => {
    const outcome = await inRolledBackTx(async (db) => {
      await db.as({ role: 'GUEST', guestId: randomUUID() });
      return db.attempt('select * from cartlify.users_get_public_profile($1::int)', target.id);
    });

    expect(outcome).toMatchObject({
      ok: false,
      message: expect.stringContaining('USER_PROFILE_READ_FORBIDDEN'),
    });
  });
});
