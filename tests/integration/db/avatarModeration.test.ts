import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../helpers/factories.js';

// cartlify.remove_user_avatar: a moderator takes the avatar of another account away. A signed-in
// admin takes it from a USER account, root from any account; the system, a user and a guest
// cannot. Only the two avatar fields of the row change; the result says whether it took an avatar,
// read under the lock of the row, with the id of its file and its address

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
  db.attempt<{ removed: boolean; public_id: string | null; avatar_url: string | null }>(
    'select * from cartlify.remove_user_avatar($1)',
    id,
  );

// what the function says it took
const took = (id: number) => ({
  removed: true,
  public_id: avatarOf(id).publicId,
  avatar_url: avatarOf(id).avatarUrl,
});

describe('cartlify.remove_user_avatar', () => {
  it('lets a signed-in admin take the avatar of a user and gives the id of its file and its address', () =>
    inRolledBackTx(async (db) => {
      await withAvatar(db, user.id);
      const before = await rowOf(db, user.id);

      await db.as(asAdmin());
      const removed = await removeAvatar(db, user.id);

      expect(removed).toEqual({ ok: true, rows: [took(user.id)] });
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

  // of two moderators at once the second finds the avatar gone: no line, no count, no mail
  it('says it took nothing and changes nothing for an account without an avatar', () =>
    inRolledBackTx(async (db) => {
      const before = await rowOf(db, user.id);

      await db.as(asAdmin());
      const removed = await removeAvatar(db, user.id);

      expect(removed).toEqual({
        ok: true,
        rows: [{ removed: false, public_id: null, avatar_url: null }],
      });
      expect(await rowOf(db, user.id)).toEqual(before);
    }));

  it('says it took the old address of a provider, which has no id of a file', () =>
    inRolledBackTx(async (db) => {
      const address = 'https://lh3.googleusercontent.com/a/old-picture';
      await db.as(asRoot());
      await db.rows('update cartlify.users set "avatarUrl" = $2 where id = $1', user.id, address);

      await db.as(asAdmin());
      const removed = await removeAvatar(db, user.id);

      expect(removed).toEqual({
        ok: true,
        rows: [{ removed: true, public_id: null, avatar_url: address }],
      });
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

      expect(removed).toEqual({ ok: true, rows: [took(otherAdmin.id)] });
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
