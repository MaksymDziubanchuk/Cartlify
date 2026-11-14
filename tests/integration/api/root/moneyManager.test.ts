import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie, getMe } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import {
  giveMoneyRight,
  moneyManagerLinesOf,
  moneyRightOf,
} from '../../../helpers/moneyManager.js';
import { managerLinesOf, newsletterRightOf } from '../../../helpers/newsletterManager.js';

// root gives an admin the right to handle the money the way root does and takes it away: PATCH
// /api/root/admins/:adminId with canManageMoney, next to canManageNewsletters. The right is a column
// root alone changes, through a function of the database; the route writes a line of the admin log
// for every change that really changed it

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

const patchAdmin = (
  adminId: number | string,
  payload: unknown,
  actor: Pick<TestUser, 'id' | 'role'> = root,
) =>
  app.inject({
    method: 'PATCH',
    url: `/api/root/admins/${adminId}`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: payload as Record<string, unknown>,
  });

const setRight = (adminId: number | string, canManageMoney: unknown, actor?: TestUser) =>
  patchAdmin(adminId, { canManageMoney }, actor);

const listed = async (search: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/root/admins?search=${encodeURIComponent(search)}`,
    headers: { cookie: accessCookie(root) },
  });
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<{ id: number; canManageMoney: boolean }>;
};

describe('PATCH /api/root/admins/:adminId with canManageMoney', () => {
  it('gives the right to an admin and answers with the admin; the right of the newsletters stays', async () => {
    const admin = await newUser({ role: 'ADMIN', name: 'Money admin' });

    const res = await setRight(admin.id, true);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: admin.id,
      role: 'ADMIN',
      name: 'Money admin',
      canManageMoney: true,
      canManageNewsletters: false,
      deletedAt: null,
    });
    expect(await moneyRightOf(admin.id)).toBe(true);
    expect(await newsletterRightOf(admin.id)).toBe(false);
  });

  it('takes the right away from an admin', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    await giveMoneyRight(root.id, admin.id);

    const res = await setRight(admin.id, false);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: admin.id, canManageMoney: false });
    expect(await moneyRightOf(admin.id)).toBe(false);
  });

  it('changes both rights in one request, each with its own line of the admin log', async () => {
    const admin = await newUser({ role: 'ADMIN' });

    const res = await patchAdmin(admin.id, { canManageMoney: true, canManageNewsletters: true });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ canManageMoney: true, canManageNewsletters: true });
    expect((await moneyManagerLinesOf(admin.id)).map((line) => line.event)).toEqual([
      'payment.manager_granted',
    ]);
    expect((await managerLinesOf(admin.id)).map((line) => line.event)).toEqual([
      'newsletter.manager_granted',
    ]);
  });

  describe('the line of the admin log', () => {
    it('names root, the admin, the change and the event when the right is given and taken away', async () => {
      const admin = await newUser({ role: 'ADMIN' });

      await setRight(admin.id, true);
      await setRight(admin.id, false);

      expect(await moneyManagerLinesOf(admin.id)).toEqual([
        {
          actorId: root.id,
          actorRole: 'ROOT',
          entityType: 'user',
          entityId: admin.id,
          action: 'MONEY_MANAGER_CHANGE',
          event: 'payment.manager_granted',
          meta: [{ field: 'canManageMoney', old: false, new: true }],
        },
        {
          actorId: root.id,
          actorRole: 'ROOT',
          entityType: 'user',
          entityId: admin.id,
          action: 'MONEY_MANAGER_CHANGE',
          event: 'payment.manager_revoked',
          meta: [{ field: 'canManageMoney', old: true, new: false }],
        },
      ]);
    });

    it('is written once however many times the same value is sent', async () => {
      const admin = await newUser({ role: 'ADMIN' });

      expect((await setRight(admin.id, false)).statusCode).toBe(200);
      for (const sent of [true, true, false, false]) {
        expect((await setRight(admin.id, sent)).statusCode).toBe(200);
      }

      expect((await moneyManagerLinesOf(admin.id)).map((line) => line.event)).toEqual([
        'payment.manager_granted',
        'payment.manager_revoked',
      ]);
    });
  });

  describe('the account that is not an admin', () => {
    it.each([true, false])('is refused with USER_NOT_ADMIN for a user (%s)', async (sent) => {
      const user = await newUser();

      const res = await setRight(user.id, sent);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_ADMIN' });
      expect(await moneyRightOf(user.id)).toBe(false);
      expect(await moneyManagerLinesOf(user.id)).toEqual([]);
    });

    it('is refused with USER_NOT_ADMIN for root, who needs no right', async () => {
      const other = await newUser({ role: 'ROOT' });

      const res = await setRight(other.id, true);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_ADMIN' });
    });

    it('answers 404 USER_NOT_FOUND for an account that does not exist', async () => {
      const res = await setRight(2147483647, true);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
    });
  });

  describe('an admin whose account was deleted', () => {
    const deleteAccount = (userId: number) =>
      app.inject({
        method: 'DELETE',
        url: `/api/users/${userId}`,
        headers: withCsrf(csrf, accessCookie(root)),
      });

    it('cannot be given the right, but loses the one that is taken away', async () => {
      const fresh = await newUser({ role: 'ADMIN' });
      const allowed = await newUser({ role: 'ADMIN' });
      await giveMoneyRight(root.id, allowed.id);
      expect((await deleteAccount(fresh.id)).statusCode).toBe(200);
      expect((await deleteAccount(allowed.id)).statusCode).toBe(200);

      const give = await setRight(fresh.id, true);
      expect(give.statusCode).toBe(404);
      expect(give.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });

      const [before] = (await listed(`deleted+${allowed.id}+`)).filter((a) => a.id === allowed.id);
      expect(before).toMatchObject({ canManageMoney: false });
      const takeAway = await setRight(allowed.id, false);
      expect(takeAway.statusCode).toBe(200);
      expect(await moneyRightOf(allowed.id)).toBe(false);
    });
  });

  describe('who may do it', () => {
    it('refuses an admin, also one who has the right, and a user, and changes nothing', async () => {
      const target = await newUser({ role: 'ADMIN' });
      const plain = await newUser({ role: 'ADMIN' });
      const allowed = await newUser({ role: 'ADMIN' });
      await giveMoneyRight(root.id, allowed.id);
      const user = await newUser();

      for (const actor of [plain, allowed, user]) {
        const res = await setRight(target.id, true, actor);

        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
      }

      expect(await moneyRightOf(target.id)).toBe(false);
      expect(await moneyManagerLinesOf(target.id)).toEqual([]);
    });
  });

  describe('the request', () => {
    it.each([
      ['an empty body', {}],
      ['a string', { canManageMoney: 'true' }],
      ['a number', { canManageMoney: 1 }],
      ['null', { canManageMoney: null }],
    ])('is refused with %s', async (_label, payload) => {
      const admin = await newUser({ role: 'ADMIN' });

      const res = await patchAdmin(admin.id, payload);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      expect(await moneyRightOf(admin.id)).toBe(false);
    });
  });
});

describe('the right of the money and the other answers about an admin', () => {
  it('is a field of the list of admins and of the answer that makes an admin', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    expect((await listed(admin.email)).find((a) => a.id === admin.id)).toMatchObject({
      canManageMoney: false,
    });

    await setRight(admin.id, true);
    expect((await listed(admin.email)).find((a) => a.id === admin.id)).toMatchObject({
      canManageMoney: true,
    });

    const user = await newUser();
    const made = await app.inject({
      method: 'POST',
      url: '/api/root/admins',
      headers: withCsrf(csrf, accessCookie(root)),
      payload: { userId: user.id },
    });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ role: 'ADMIN', canManageMoney: false });
  });

  it('is gone when root takes the role of admin away, and stays gone when root gives it again', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    await setRight(admin.id, true);

    const demoted = await app.inject({
      method: 'DELETE',
      url: `/api/root/admins/${admin.id}`,
      headers: withCsrf(csrf, accessCookie(root)),
    });
    expect(demoted.statusCode).toBe(200);
    expect(await moneyRightOf(admin.id)).toBe(false);

    const again = await app.inject({
      method: 'POST',
      url: '/api/root/admins',
      headers: withCsrf(csrf, accessCookie(root)),
      payload: { userId: admin.id },
    });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toMatchObject({ role: 'ADMIN', canManageMoney: false });
  });

  // the access token holds the role, never the right: the next profile of the open session shows it
  it('shows in the next GET /api/users/me of the admin, with no new login', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const cookie = accessCookie(admin);

    expect((await getMe(app, cookie)).json()).toMatchObject({ canManageMoney: false });
    await setRight(admin.id, true);
    expect((await getMe(app, cookie)).json()).toMatchObject({ canManageMoney: true });
    await setRight(admin.id, false);
    expect((await getMe(app, cookie)).json()).toMatchObject({ canManageMoney: false });
  });
});
