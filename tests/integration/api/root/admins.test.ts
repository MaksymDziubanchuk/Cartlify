import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie, refreshWith, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser, uniqueTag } from '../../../helpers/factories.js';

let app: FastifyInstance;
let csrf: Csrf;
let rootCookie: string;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);

  const root = await createUser({ role: 'ROOT' });
  userIds.push(root.id);
  rootCookie = accessCookie(root);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const promote = (userId: number) =>
  app.inject({
    method: 'POST',
    url: '/api/root/admins',
    headers: withCsrf(csrf, rootCookie),
    payload: { userId },
  });

const demote = (adminId: number) =>
  app.inject({
    method: 'DELETE',
    url: `/api/root/admins/${adminId}`,
    headers: withCsrf(csrf, rootCookie),
  });

const deleteAccount = (userId: number) =>
  app.inject({
    method: 'DELETE',
    url: `/api/users/${userId}`,
    headers: withCsrf(csrf, rootCookie),
  });

const adminsListed = async (search: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/root/admins?search=${encodeURIComponent(search)}`,
    headers: { cookie: rootCookie },
  });
  expect(res.statusCode).toBe(200);
  return res.json().items as Array<{
    id: number;
    deletedAt: string | null;
    avatarIsDefault: boolean;
  }>;
};

// a deleted admin keeps the role: the list showed it as a working admin
describe('GET /api/root/admins', () => {
  it('tells a deleted admin from a working one', async () => {
    const working = await newUser({ role: 'ADMIN', name: 'Working admin' });
    const gone = await newUser({ role: 'ADMIN', name: 'Gone admin' });
    await deleteAccount(gone.id);

    const items = [
      ...(await adminsListed(working.email)),
      ...(await adminsListed(`deleted+${gone.id}+`)),
    ];

    expect(items.find((item) => item.id === working.id)).toMatchObject({ deletedAt: null });
    expect(items.find((item) => item.id === gone.id)).toMatchObject({
      deletedAt: expect.any(String),
      avatarIsDefault: true,
    });
  });
});

describe('POST /api/root/admins', () => {
  it('answers 404 for a deleted account and leaves its role', async () => {
    const user = await newUser();
    await deleteAccount(user.id);

    const res = await promote(user.id);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
  });
});

// a session holds the role it was opened with: a new role takes a new login
describe('the sessions of a person whose role changes', () => {
  it('end when root makes the person an admin', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);

    expect((await promote(user.id)).statusCode).toBe(201);

    const res = await refreshWith(app, csrf, session.refreshToken);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'REFRESH_TOKEN_REVOKED' });
  });

  it('end when root takes the role of an admin away', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const session = await signIn(app, csrf, admin);

    expect((await demote(admin.id)).statusCode).toBe(200);

    const res = await refreshWith(app, csrf, session.refreshToken);
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'REFRESH_TOKEN_REVOKED' });
  });

  // the access token names the old role for minutes: the rights of the database refused the
  // change of the profile and the person got 500; the page renews the session and logs in again
  it('answers the access token of the old role, which the database refuses, to renew the session', async () => {
    const user = await newUser();
    const oldCookie = accessCookie(user);
    await promote(user.id);

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/users/me',
      headers: withCsrf(csrf, oldCookie),
      payload: { name: 'New name' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'ACCESS_TOKEN_EXPIRED' });
  });
});

const journalOf = (userId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'user', entityId: userId, action: 'USER_ROLE_CHANGE' },
      select: { actorRole: true, meta: true },
    }),
  );

const roleOf = async (userId: number) =>
  (
    await asAdmin((tx) =>
      tx.user.findUniqueOrThrow({ where: { id: userId }, select: { role: true } }),
    )
  ).role;

describe('the admins of root', () => {
  it('lists the admins that match the search, page by page, with the total', async () => {
    const tag = uniqueTag();
    const ids: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push((await newUser({ role: 'ADMIN', name: `Paged admin ${tag} ${i}` })).id);
    }
    await newUser({ name: `Paged user ${tag}` });

    const seen: number[] = [];
    let cursor: string | null = null;
    let total: number | undefined;
    do {
      const url = `/api/root/admins?search=${encodeURIComponent(tag)}&limit=2${cursor ? `&cursor=${cursor}` : ''}`;
      const res: Awaited<ReturnType<typeof app.inject>> = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: rootCookie },
      });
      expect(res.statusCode).toBe(200);
      seen.push(...(res.json().items as Array<{ id: number }>).map((item) => item.id));
      cursor = res.json().nextCursor ?? null;
      total = res.json().total;
    } while (cursor);

    expect([...seen].sort((a, b) => a - b)).toEqual([...ids].sort((a, b) => a - b));
    expect(total).toBe(3);
  });

  it('makes a user an admin, answers with the profile and writes the change of the role', async () => {
    const user = await newUser();

    const res = await promote(user.id);

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ id: user.id, role: 'ADMIN' });
    expect(await roleOf(user.id)).toBe('ADMIN');
    expect(await journalOf(user.id)).toEqual([
      { actorRole: 'ROOT', meta: [{ field: 'role', old: 'USER', new: 'ADMIN' }] },
    ]);
  });

  it('takes the role of an admin away and writes the change', async () => {
    const admin = await newUser({ role: 'ADMIN' });

    const res = await demote(admin.id);

    expect(res.statusCode).toBe(200);
    expect(await roleOf(admin.id)).toBe('USER');
    expect(await journalOf(admin.id)).toEqual(
      expect.arrayContaining([
        { actorRole: 'ROOT', meta: [{ field: 'role', old: 'ADMIN', new: 'USER' }] },
      ]),
    );
  });

  it.each([
    ['an admin already', () => newUser({ role: 'ADMIN' }), 'USER_ALREADY_ADMIN'],
    ['root', () => newUser({ role: 'ROOT' }), 'USER_IS_ROOT'],
  ])('refuses to make %s an admin and changes nothing', async (_case, target, errorCode) => {
    const user = await target();

    const res = await promote(user.id);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode });
    expect(await journalOf(user.id)).toEqual([]);
  });

  it.each([
    ['a user', () => newUser(), 'USER_NOT_ADMIN'],
    ['root', () => newUser({ role: 'ROOT' }), 'ROOT_CANNOT_BE_DEMOTED'],
  ])('refuses to take the role from %s and changes nothing', async (_case, target, errorCode) => {
    const user = await target();

    const res = await demote(user.id);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode });
  });

  it.each([
    ['promote', () => promote(2_000_000_000)],
    ['demote', () => demote(2_000_000_000)],
  ])('answers 404 to %s of an account that does not exist', async (_case, request) => {
    const res = await request();

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
  });

  it('keeps an admin out of the admins of root', async () => {
    const admin = await newUser({ role: 'ADMIN' });
    const user = await newUser();

    const answers = [
      await app.inject({
        method: 'GET',
        url: '/api/root/admins',
        headers: { cookie: accessCookie(admin) },
      }),
      await app.inject({
        method: 'POST',
        url: '/api/root/admins',
        headers: withCsrf(csrf, accessCookie(admin)),
        payload: { userId: user.id },
      }),
    ];

    for (const res of answers) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    }
    expect(await roleOf(user.id)).toBe('USER');
  });
});
