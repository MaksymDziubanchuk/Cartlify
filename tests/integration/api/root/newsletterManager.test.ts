import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie, getMe } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import {
  giveNewsletterRight,
  managerLinesOf,
  newsletterRightOf,
} from '../../../helpers/newsletterManager.js';

// root gives an admin the right to run the newsletters and takes it away: PATCH /api/root/admins/:adminId
// with canManageNewsletters. The right is a column root alone changes, through a function of the
// database; the route writes a line of the admin log for every change that really changed it

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await newUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const setRight = (
  adminId: number | string,
  canManageNewsletters: unknown,
  actor: Pick<TestUser, 'id' | 'role'> = root,
) =>
  app.inject({
    method: 'PATCH',
    url: `/api/root/admins/${adminId}`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: { canManageNewsletters },
  });

const listed = async (search: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/root/admins?search=${encodeURIComponent(search)}`,
    headers: { cookie: accessCookie(root) },
  });
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<{ id: number; canManageNewsletters: boolean }>;
};

const promote = (userId: number) =>
  app.inject({
    method: 'POST',
    url: '/api/root/admins',
    headers: withCsrf(csrf, accessCookie(root)),
    payload: { userId },
  });

const demote = (adminId: number) =>
  app.inject({
    method: 'DELETE',
    url: `/api/root/admins/${adminId}`,
    headers: withCsrf(csrf, accessCookie(root)),
  });

const deleteAccount = (userId: number) =>
  app.inject({
    method: 'DELETE',
    url: `/api/users/${userId}`,
    headers: withCsrf(csrf, accessCookie(root)),
  });

describe('PATCH /api/root/admins/:adminId', () => {
  it('gives the right to an admin and answers with the admin', async () => {
    const admin = await newUser({ role: 'ADMIN', name: 'Newsletter admin' });

    const res = await setRight(admin.id, true);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: admin.id,
      email: admin.email,
      role: 'ADMIN',
      name: 'Newsletter admin',
      canManageNewsletters: true,
      deletedAt: null,
    });
    expect(await newsletterRightOf(admin.id)).toBe(true);
  });

  it('takes the right away from an admin', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    await giveNewsletterRight(root.id, admin.id);

    const res = await setRight(admin.id, false);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: admin.id, canManageNewsletters: false });
    expect(await newsletterRightOf(admin.id)).toBe(false);
  });

  describe('the line of the admin log', () => {
    it('names root, the admin, the change and the event when the right is given', async () => {
      const admin = await newUser({ role: 'ADMIN' });

      await setRight(admin.id, true);

      expect(await managerLinesOf(admin.id)).toEqual([
        {
          actorId: root.id,
          actorRole: 'ROOT',
          entityType: 'user',
          entityId: admin.id,
          action: 'NEWSLETTER_MANAGER_CHANGE',
          event: 'newsletter.manager_granted',
          meta: [{ field: 'canManageNewsletters', old: false, new: true }],
        },
      ]);
    });

    it('names root, the admin, the change and the event when the right is taken away', async () => {
      const admin = await newUser({ role: 'ADMIN' });
      await setRight(admin.id, true);

      await setRight(admin.id, false);

      const lines = await managerLinesOf(admin.id);
      expect(lines.map((line) => line.event)).toEqual([
        'newsletter.manager_granted',
        'newsletter.manager_revoked',
      ]);
      expect(lines[1]).toMatchObject({
        actorId: root.id,
        actorRole: 'ROOT',
        meta: [{ field: 'canManageNewsletters', old: true, new: false }],
      });
    });

    it('is written once however many times the same value is sent', async () => {
      const admin = await newUser({ role: 'ADMIN' });

      // taking away a right the admin never had changes nothing
      expect((await setRight(admin.id, false)).statusCode).toBe(200);
      expect(await managerLinesOf(admin.id)).toEqual([]);

      for (const sent of [true, true, true]) {
        const res = await setRight(admin.id, sent);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ canManageNewsletters: true });
      }
      expect((await managerLinesOf(admin.id)).map((line) => line.event)).toEqual([
        'newsletter.manager_granted',
      ]);

      for (const sent of [false, false]) {
        const res = await setRight(admin.id, sent);
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ canManageNewsletters: false });
      }
      expect((await managerLinesOf(admin.id)).map((line) => line.event)).toEqual([
        'newsletter.manager_granted',
        'newsletter.manager_revoked',
      ]);
    });
  });

  describe('the account that is not an admin', () => {
    it.each([true, false])(
      'is refused with USER_NOT_ADMIN when the right is set to %s for a user',
      async (sent) => {
        const user = await newUser();

        const res = await setRight(user.id, sent);

        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_ADMIN' });
        expect(await newsletterRightOf(user.id)).toBe(false);
        expect(await managerLinesOf(user.id)).toEqual([]);
      },
    );

    it.each([true, false])(
      'is refused with USER_NOT_ADMIN when the right is set to %s for root',
      async (sent) => {
        const other = await newUser({ role: 'ROOT' });

        const res = await setRight(other.id, sent);

        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_ADMIN' });
        expect(await newsletterRightOf(other.id)).toBe(false);
        expect(await managerLinesOf(other.id)).toEqual([]);
      },
    );

    it.each([true, false])(
      'answers 404 USER_NOT_FOUND when the right is set to %s for an account that does not exist',
      async (sent) => {
        // the largest id the route takes: no account has it
        const res = await setRight(2147483647, sent);

        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
      },
    );
  });

  describe('an admin whose account was deleted', () => {
    it('cannot be given the right: 404 USER_NOT_FOUND, as when a deleted account is made an admin', async () => {
      const admin = await newUser({ role: 'ADMIN' });
      expect((await deleteAccount(admin.id)).statusCode).toBe(200);

      const res = await setRight(admin.id, true);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
      expect(await newsletterRightOf(admin.id)).toBe(false);
    });

    it('loses the right that is taken away, and is listed without it', async () => {
      const admin = await newUser({ role: 'ADMIN' });
      await giveNewsletterRight(root.id, admin.id);
      expect((await deleteAccount(admin.id)).statusCode).toBe(200);

      // the account is gone, so the right does not work, whatever the column keeps
      const [before] = (await listed(`deleted+${admin.id}+`)).filter((a) => a.id === admin.id);
      expect(before).toMatchObject({ canManageNewsletters: false });

      const res = await setRight(admin.id, false);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ canManageNewsletters: false });
      expect(await newsletterRightOf(admin.id)).toBe(false);
    });
  });

  describe('who may do it', () => {
    it('refuses an admin, also one who has the right, and a user, and changes nothing', async () => {
      const target = await newUser({ role: 'ADMIN' });
      const plain = await newUser({ role: 'ADMIN' });
      const allowed = await newUser({ role: 'ADMIN' });
      await giveNewsletterRight(root.id, allowed.id);
      const user = await newUser();

      for (const actor of [plain, allowed, user]) {
        const res = await setRight(target.id, true, actor);

        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
      }

      expect(await newsletterRightOf(target.id)).toBe(false);
      expect(await managerLinesOf(target.id)).toEqual([]);
    });

    it('refuses a visitor without a login', async () => {
      const target = await newUser({ role: 'ADMIN' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/root/admins/${target.id}`,
        headers: withCsrf(csrf),
        payload: { canManageNewsletters: true },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
      expect(await newsletterRightOf(target.id)).toBe(false);
    });

    it('wants the csrf token', async () => {
      const target = await newUser({ role: 'ADMIN' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/root/admins/${target.id}`,
        headers: { cookie: accessCookie(root) },
        payload: { canManageNewsletters: true },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
      expect(await newsletterRightOf(target.id)).toBe(false);
    });
  });

  describe('the request', () => {
    it.each([
      ['a body without the field', undefined],
      ['a string', 'true'],
      ['a number', 1],
      ['null', null],
    ])('is refused with %s', async (_label, sent) => {
      const admin = await newUser({ role: 'ADMIN' });

      const res = await setRight(admin.id, sent);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      expect(await newsletterRightOf(admin.id)).toBe(false);
    });

    // the server drops a field the schema does not name: it changes the right and nothing else
    it('changes nothing but the right when the body has more', async () => {
      const admin = await newUser({ role: 'ADMIN' });

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/root/admins/${admin.id}`,
        headers: withCsrf(csrf, accessCookie(root)),
        payload: { canManageNewsletters: true, role: 'ROOT', isVerified: false },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ role: 'ADMIN', isVerified: true });
      expect(
        await asAdmin((tx) =>
          tx.user.findUniqueOrThrow({
            where: { id: admin.id },
            select: { role: true, isVerified: true },
          }),
        ),
      ).toEqual({ role: 'ADMIN', isVerified: true });
    });

    it.each(['0', 'abc', '-3'])('is refused with the id %s', async (id) => {
      const res = await setRight(id, true);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    });

    it('is refused with an id no row can have', async () => {
      const res = await setRight('2147483648', true);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'INVALID_ID_PARAM' });
    });
  });

  // nobody but root changes the right; the database refuses the rest
  it('is the only way the right changes: a statement of the app cannot', async () => {
    const admin = await newUser({ role: 'ADMIN' });

    await expect(
      asAdmin((tx) =>
        tx.user.update({ where: { id: admin.id }, data: { canManageNewsletters: true } }),
      ),
    ).rejects.toThrow();
    expect(await newsletterRightOf(admin.id)).toBe(false);
  });
});

describe('the right and the other answers of root about an admin', () => {
  it('is a field of the list of admins, false until root gives it', async () => {
    const admin = await newUser({ role: 'ADMIN' });

    expect((await listed(admin.email)).find((a) => a.id === admin.id)).toMatchObject({
      canManageNewsletters: false,
    });

    await setRight(admin.id, true);
    expect((await listed(admin.email)).find((a) => a.id === admin.id)).toMatchObject({
      canManageNewsletters: true,
    });

    await setRight(admin.id, false);
    expect((await listed(admin.email)).find((a) => a.id === admin.id)).toMatchObject({
      canManageNewsletters: false,
    });
  });

  it('is false in the answer of the route that makes an admin', async () => {
    const user = await newUser();

    const res = await promote(user.id);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ role: 'ADMIN', canManageNewsletters: false });
  });

  // 112.4: a person who stops being an admin loses the right, and does not get it back
  // with the role
  it('is gone when root takes the role of admin away, and stays gone when root gives it again', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    await setRight(admin.id, true);
    expect(await newsletterRightOf(admin.id)).toBe(true);

    expect((await demote(admin.id)).statusCode).toBe(200);
    expect(await newsletterRightOf(admin.id)).toBe(false);

    const again = await promote(admin.id);
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ role: 'ADMIN', canManageNewsletters: false });
    expect(await newsletterRightOf(admin.id)).toBe(false);
    expect((await listed(admin.email)).find((a) => a.id === admin.id)).toMatchObject({
      canManageNewsletters: false,
    });
  });
});

describe('the right in a session that is open', () => {
  // the access token holds the role, never the right: the right is read from the database at every
  // opening of the page of the profile, so the change reaches an open session at once
  it('shows in the next GET /api/users/me of the admin, with no new login', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const cookie = accessCookie(admin);

    expect((await getMe(app, cookie)).json()).toMatchObject({ canManageNewsletters: false });

    await setRight(admin.id, true);
    expect((await getMe(app, cookie)).json()).toMatchObject({ canManageNewsletters: true });

    await setRight(admin.id, false);
    expect((await getMe(app, cookie)).json()).toMatchObject({ canManageNewsletters: false });
  });
});
