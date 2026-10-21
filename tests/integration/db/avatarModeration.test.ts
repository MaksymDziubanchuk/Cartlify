import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// cartlify.remove_user_avatar: a moderator takes the avatar of another account away. A signed-in
// admin takes it from a USER account, root from any account; the system, a user and a guest
// cannot. Only the two avatar fields of the row change, the result is the id of the file the
// account had

const avatarOf = (id: number) => ({
  avatarUrl: `https://res.cloudinary.com/demo/image/upload/v1/test/users/${id}/avatar.png`,
  publicId: `test/users/${id}/avatar`,
});

let user: TestUser;
let admin: TestUser;
let otherAdmin: TestUser;
let root: TestUser;

beforeAll(async () => {
  user = await createUser({ name: 'User' });
  admin = await createUser({ role: 'ADMIN' });
  otherAdmin = await createUser({ role: 'ADMIN', name: 'Other admin' });
  root = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions([user.id, admin.id, otherAdmin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

const asAdmin = (): Actor => ({ role: 'ADMIN', userId: admin.id });
const asRoot = (): Actor => ({ role: 'ROOT', userId: root.id });

type Row = { avatarUrl: string | null; publicId: string | null } & Record<string, unknown>;

// the row as the test reads it: everything of it, to see what the call changed
const rowOf = async (db: DbSession, id: number) => {
  await db.as(asRoot());
  const [row] = await db.rows<Row>('select * from cartlify.users where id = $1', id);
  return row!;
};

// gives the account its avatar the way root writes a row
async function withAvatar(db: DbSession, id: number) {
  const { avatarUrl, publicId } = avatarOf(id);
  await db.as(asRoot());
  await db.rows(
    'update cartlify.users set "avatarUrl" = $2, "publicId" = $3 where id = $1 returning id',
    id,
    avatarUrl,
    publicId,
  );
}

const removeAvatar = (db: DbSession, id: number) =>
  db.attempt<{ publicId: string | null }>(
    'select cartlify.remove_user_avatar($1) as "publicId"',
    id,
  );

describe('cartlify.remove_user_avatar', () => {
  it('lets a signed-in admin take the avatar of a user and gives the id of its file', () =>
    inRolledBackTx(async (db) => {
      await withAvatar(db, user.id);
      const before = await rowOf(db, user.id);

      await db.as(asAdmin());
      const removed = await removeAvatar(db, user.id);

      expect(removed).toEqual({ ok: true, rows: [{ publicId: avatarOf(user.id).publicId }] });
      const after = await rowOf(db, user.id);
      expect(after).toMatchObject({ avatarUrl: null, publicId: null });
      // nothing else of the row changed but the time of the change
      const rest = (row: Row) =>
        Object.fromEntries(
          Object.entries(row).filter(
            ([key]) => !['avatarUrl', 'publicId', 'updatedAt'].includes(key),
          ),
        );
      expect(rest(after)).toEqual(rest(before));
      expect((after.updatedAt as Date).getTime()).toBeGreaterThan(
        (before.updatedAt as Date).getTime(),
      );
    }));

  it('gives null and changes nothing for an account without an avatar', () =>
    inRolledBackTx(async (db) => {
      const before = await rowOf(db, user.id);

      await db.as(asAdmin());
      const removed = await removeAvatar(db, user.id);

      expect(removed).toEqual({ ok: true, rows: [{ publicId: null }] });
      expect(await rowOf(db, user.id)).toEqual(before);
    }));

  it.each([
    ['an admin', () => otherAdmin],
    ['root', () => root],
  ])('keeps an admin from taking the avatar of %s', (_case, target) =>
    inRolledBackTx(async (db) => {
      await withAvatar(db, target().id);

      await db.as(asAdmin());
      const removed = await removeAvatar(db, target().id);

      expect(removed).toMatchObject({ ok: false, message: 'USER_AVATAR_REMOVE_FORBIDDEN' });
      expect(await rowOf(db, target().id)).toMatchObject(avatarOf(target().id));
    }),
  );

  it('lets root take the avatar of an admin', () =>
    inRolledBackTx(async (db) => {
      await withAvatar(db, otherAdmin.id);

      await db.as(asRoot());
      const removed = await removeAvatar(db, otherAdmin.id);

      expect(removed).toEqual({ ok: true, rows: [{ publicId: avatarOf(otherAdmin.id).publicId }] });
      expect(await rowOf(db, otherAdmin.id)).toMatchObject({ avatarUrl: null, publicId: null });
    }));

  // a moderator is someone signed in: the system (an admin without an id) has no say in it
  it.each([
    ['the system', { role: 'ADMIN' } as Actor],
    ['a user', () => ({ role: 'USER', userId: user.id }) as Actor],
    ['a guest', { role: 'GUEST' } as Actor],
    ['no actor', null],
  ])('refuses %s', (_case, actorOf) =>
    inRolledBackTx(async (db) => {
      await withAvatar(db, user.id);
      const actor = typeof actorOf === 'function' ? actorOf() : actorOf;

      await db.as(actor);
      const removed = await removeAvatar(db, user.id);

      expect(removed).toMatchObject({ ok: false, message: 'USER_AVATAR_REMOVE_FORBIDDEN' });
      expect(await rowOf(db, user.id)).toMatchObject(avatarOf(user.id));
    }),
  );

  it('answers USER_NOT_FOUND for an account that does not exist', () =>
    inRolledBackTx(async (db) => {
      await db.as(asAdmin());

      expect(await removeAvatar(db, 2_000_000_000)).toMatchObject({
        ok: false,
        message: 'USER_NOT_FOUND',
      });
    }));

  // the function is the one way: the app role still cannot change another row itself
  it('leaves an admin unable to empty the avatar of a user with a plain update', () =>
    inRolledBackTx(async (db) => {
      await withAvatar(db, user.id);

      await db.as(asAdmin());
      const changed = await db.rows(
        'update cartlify.users set "avatarUrl" = null, "publicId" = null where id = $1 returning id',
        user.id,
      );

      expect(changed).toEqual([]);
      expect(await rowOf(db, user.id)).toMatchObject(avatarOf(user.id));
    }));
});
