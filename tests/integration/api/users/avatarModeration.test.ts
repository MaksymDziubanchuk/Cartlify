import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import cloudinary from '@config/cloudinary.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser, uniqueTag, type TestUser } from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { refuseMail, watchMail } from '../../../helpers/mail.js';

// DELETE /api/users/:userId/avatar: a moderator takes the avatar of another account away. An admin
// takes it from a user, root from any account, through cartlify.remove_user_avatar. Every removal
// goes to the journal of the admins and mails the person which removal it is; the answer and the
// profile an admin reads count the removals of the account against the limit
// (AVATAR_REMOVALS_LIMIT, 2 in the tests), and past the limit the page tells the admin to ask
// root about the account. The file goes from Cloudinary after the commit, only a file of the
// folder of this environment

const LIMIT = 2;

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const avatarFile = (tag: string) => ({
  avatarUrl: `https://res.cloudinary.com/demo/image/upload/v1/test/users/${tag}/avatar.png`,
  publicId: `test/users/${tag}/avatar`,
});

// an account with an avatar of the test folder
async function userWithAvatar(opts: Parameters<typeof createUser>[0] = {}) {
  const tag = uniqueTag();
  const user = await newUser({ ...avatarFile(tag), ...opts });
  return { user, publicId: avatarFile(tag).publicId };
}

// the account puts a new avatar back, the way root writes a row
const giveAvatarAgain = (id: number) =>
  prisma.$transaction(async (tx) => {
    await setUserContext(tx, { userId: root.id, role: 'ROOT' });
    await tx.user.update({ where: { id }, data: avatarFile(uniqueTag()) });
  });

const removeAvatar = (id: number | string, actor: TestUser | null = admin, sendCsrf = true) =>
  app.inject({
    method: 'DELETE',
    url: `/api/users/${id}/avatar`,
    headers: sendCsrf
      ? withCsrf(csrf, actor ? accessCookie(actor) : undefined)
      : actor
        ? { cookie: accessCookie(actor) }
        : {},
  });

const avatarRowOf = (id: number) =>
  asAdmin((tx) =>
    tx.user.findUniqueOrThrow({ where: { id }, select: { avatarUrl: true, publicId: true } }),
  );

const journalOf = (id: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'user', entityId: id },
      orderBy: { id: 'asc' },
      select: { actorId: true, actorRole: true, action: true, meta: true },
    }),
  );

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('DELETE /api/users/:userId/avatar', () => {
  it('lets an admin take the avatar of a user: the row, the file, the journal, the mail', async () => {
    const { user, publicId } = await userWithAvatar({ name: 'Anna' });
    const destroy = jest.spyOn(cloudinary.uploader, 'destroy');
    const mails = watchMail();

    const res = await removeAvatar(user.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true, avatarRemovals: 1, avatarRemovalsLimit: LIMIT });
    expect(await avatarRowOf(user.id)).toEqual({ avatarUrl: null, publicId: null });
    expect(destroy).toHaveBeenCalledWith(publicId, expect.objectContaining({ invalidate: true }));
    expect(await journalOf(user.id)).toEqual([
      {
        actorId: admin.id,
        actorRole: 'ADMIN',
        action: 'OTHER',
        meta: [{ field: 'avatar', old: publicId, new: null }],
      },
    ]);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      to: [user.email],
      subject: 'Cartlify — Your profile picture was removed',
      accepted: true,
    });
    expect(mails[0]!.text).toContain(`This is removal 1 of the ${LIMIT} the rules allow.`);
  });

  // the person learns where the removals lead; the admin sees when the limit is passed
  it('counts every removal and tells the person when the limit is reached and passed', async () => {
    const { user } = await userWithAvatar();
    const mails = watchMail();
    const counts: number[] = [];

    for (let i = 0; i < LIMIT + 1; i++) {
      if (i) await giveAvatarAgain(user.id);
      const res = await removeAvatar(user.id);
      expect(res.statusCode).toBe(200);
      counts.push(res.json().avatarRemovals);
    }

    expect(counts).toEqual([1, 2, 3]);
    expect(mails.map((mail) => mail.text)).toEqual([
      expect.stringContaining(`This is removal 1 of the ${LIMIT} the rules allow.`),
      expect.stringContaining(`This is the last removal the rules allow, ${LIMIT} of ${LIMIT}.`),
      expect.stringContaining(`This is removal 3, past the ${LIMIT} the rules allow.`),
    ]);
    expect(await journalOf(user.id)).toHaveLength(3);
  });

  it('shows the count and the limit in the profile an admin reads, not to a user', async () => {
    const { user } = await userWithAvatar();
    await removeAvatar(user.id);

    const forAdmin = await app.inject({
      method: 'GET',
      url: `/api/users/${user.id}`,
      headers: { cookie: accessCookie(admin) },
    });
    const forUser = await app.inject({
      method: 'GET',
      url: `/api/users/${user.id}`,
      headers: { cookie: accessCookie(await newUser()) },
    });

    expect(forAdmin.json()).toMatchObject({ avatarRemovals: 1, avatarRemovalsLimit: LIMIT });
    expect(forUser.json()).not.toHaveProperty('avatarRemovals');
    expect(forUser.json()).not.toHaveProperty('avatarRemovalsLimit');
  });

  it('answers removed false and counts, writes and mails nothing for an account without one', async () => {
    const user = await newUser();
    const mails = watchMail();

    const res = await removeAvatar(user.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: false, avatarRemovals: 0, avatarRemovalsLimit: LIMIT });
    expect(await journalOf(user.id)).toEqual([]);
    expect(mails).toEqual([]);
  });

  it.each([
    ['an admin', 'ADMIN'],
    ['root', 'ROOT'],
  ] as const)('keeps an admin from taking the avatar of %s', async (_case, role) => {
    const { user } = await userWithAvatar({ role });
    const mails = watchMail();

    const res = await removeAvatar(user.id);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'USER_AVATAR_REMOVE_FORBIDDEN' });
    expect((await avatarRowOf(user.id)).avatarUrl).not.toBeNull();
    expect(await journalOf(user.id)).toEqual([]);
    expect(mails).toEqual([]);
  });

  // the same count and the same limit for an admin: root moderates the avatars of the admins
  it('lets root take the avatar of an admin, counted and mailed the same way', async () => {
    const { user } = await userWithAvatar({ role: 'ADMIN' });
    const mails = watchMail();

    const res = await removeAvatar(user.id, root);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ removed: true, avatarRemovals: 1, avatarRemovalsLimit: LIMIT });
    expect(await journalOf(user.id)).toEqual([
      expect.objectContaining({ actorId: root.id, actorRole: 'ROOT', action: 'OTHER' }),
    ]);
    expect(mails).toHaveLength(1);
  });

  it.each([
    ['a guest', null],
    ['a user', 'USER'],
  ] as const)('refuses %s', async (_case, role) => {
    const { user } = await userWithAvatar();
    const actor = role ? await newUser() : null;

    const res = await removeAvatar(user.id, actor);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect((await avatarRowOf(user.id)).avatarUrl).not.toBeNull();
  });

  it('refuses a request without the csrf token', async () => {
    const { user } = await userWithAvatar();

    const res = await removeAvatar(user.id, admin, false);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
    expect((await avatarRowOf(user.id)).avatarUrl).not.toBeNull();
  });

  it('answers USER_NOT_FOUND for an account that does not exist', async () => {
    const res = await removeAvatar(2_000_000_000);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
  });

  it('refuses an id that is not a whole number', async () => {
    const res = await removeAvatar('1.5');

    expect(res.statusCode).toBe(400);
  });

  // dev is restored from a copy of prod: its rows can point to the files of prod
  it('takes the avatar from the row but keeps a file of another environment', async () => {
    const user = await newUser({
      avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v1/prod/users/1/avatar.png',
      publicId: 'prod/users/1/avatar',
    });
    const destroy = jest.spyOn(cloudinary.uploader, 'destroy');

    const res = await removeAvatar(user.id);

    expect(res.json()).toMatchObject({ removed: true, avatarRemovals: 1 });
    expect(await avatarRowOf(user.id)).toEqual({ avatarUrl: null, publicId: null });
    expect(destroy).not.toHaveBeenCalled();
  });

  it('takes the avatar even when the mail cannot be sent, and logs it', async () => {
    const { user } = await userWithAvatar();
    refuseMail();

    const res = await removeAvatar(user.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ removed: true, avatarRemovals: 1 });
    // the failed mail goes to the log with the id of the account, never with its address
    const [logged] = takeLogs({ msg: 'avatar removed mail was not sent' });
    expect(logged).toMatchObject({ userId: user.id });
    expect(JSON.stringify(logged)).not.toContain(user.email);
  });

  it('takes the avatar even when Cloudinary does not delete the file, and logs it', async () => {
    const { user, publicId } = await userWithAvatar();
    jest.spyOn(cloudinary.uploader, 'destroy').mockRejectedValue(new Error('cloudinary is down'));

    const res = await removeAvatar(user.id);

    expect(res.statusCode).toBe(200);
    expect(await avatarRowOf(user.id)).toEqual({ avatarUrl: null, publicId: null });
    expect(takeLogs({ msg: 'avatar file was not deleted' })[0]).toMatchObject({ publicId });
  });
});
