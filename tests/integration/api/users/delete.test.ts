import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import {
  accessCookie,
  getMe,
  logIn,
  refreshWith,
  sessionCookie,
  signIn,
  type Session,
} from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { setCookies } from '../../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser, uniqueTag, type TestUser } from '../../../helpers/factories.js';

// DELETE /api/users/:userId: only root, and it does not drop the row, it empties it: orders,
// reviews and logs keep pointing at an account that no longer holds anything personal

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let rootCookie: string;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const deleteUser = (id: number | string, cookie: string) =>
  app.inject({
    method: 'DELETE',
    url: `/api/users/${id}`,
    headers: withCsrf(csrf, cookie),
  });

const rowOf = (id: number) => asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { id } }));

const sessionOf = async (user: TestUser) => signIn(app, csrf, user);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);

  // nobody makes a root through the api; its password is unique to the run
  root = await createUser({ role: 'ROOT', password: `root-${uniqueTag()}` });
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

describe('who may delete', () => {
  it.each(['USER', 'ADMIN'] as const)('refuses a %s and keeps the account', async (role) => {
    const actor = await newUser({ role });
    const target = await newUser({ name: 'Anna' });
    const cookie = accessCookie(actor);

    const res = await deleteUser(target.id, cookie);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(await rowOf(target.id)).toMatchObject({ email: target.email, name: 'Anna' });
  });

  it('refuses a guest', async () => {
    const target = await newUser();

    const res = await deleteUser(target.id, '');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect((await rowOf(target.id)).email).toBe(target.email);
  });
});

describe('what is refused', () => {
  it('does not let a root delete their own account', async () => {
    const res = await deleteUser(root.id, rootCookie);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ROOT_CANNOT_DELETE_SELF' });
    expect((await rowOf(root.id)).email).toBe(root.email);
  });

  it('answers 404 for a user that does not exist', async () => {
    const res = await deleteUser(2_000_000_000, rootCookie);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
  });

  it.each([
    ['letters', 'abc'],
    ['zero', '0'],
    ['a negative number', '-1'],
    ['an exponent', '1e3'],
  ])('refuses an id that is %s', async (_case, id) => {
    const res = await deleteUser(id, rootCookie);

    expect(res.statusCode).toBe(400);
  });

  // 9999999999 is a safe integer but no id of the database: a missing user, not a server failure
  it('answers with a client error for an id larger than the database holds', async () => {
    const res = await deleteUser(9_999_999_999, rootCookie);

    expect([400, 404]).toContain(res.statusCode);
  });
});

describe('what the deletion does', () => {
  it('answers with a message and empties the account of everything personal', async () => {
    const target = await newUser({
      name: 'Anna',
      locale: 'uk',
      phone: '+380501234567',
      avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v1/users/1/avatar.jpg',
      publicId: 'users/1/avatar',
    });

    const res = await deleteUser(target.id, rootCookie);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'user deleted' });
    const row = await rowOf(target.id);
    // the old address stays readable in the new one, but is not an address of the person any more
    expect(row.email).toMatch(new RegExp(`^deleted\\+${target.id}\\+[a-z0-9_]+@deleted\\.com$`));
    expect(row.email).not.toBe(target.email);
    expect(row).toMatchObject({
      passwordHash: null,
      authProvider: 'LOCAL',
      providerSub: null,
      isVerified: false,
      name: null,
      avatarUrl: null,
      publicId: null,
      locale: null,
      phone: null,
    });
  });

  it('cuts an oauth account from its provider', async () => {
    const target = await newUser({ authProvider: 'GITHUB', providerSub: `gh-${uniqueTag()}` });

    await deleteUser(target.id, rootCookie);

    expect(await rowOf(target.id)).toMatchObject({ authProvider: 'LOCAL', providerSub: null });
  });

  it('frees the email and refuses a login with the old credentials', async () => {
    const target = await newUser();

    await deleteUser(target.id, rootCookie);

    expect(
      await asAdmin((tx) => tx.user.findUnique({ where: { email: target.email } })),
    ).toBeNull();
    const res = await logIn(app, csrf, { email: target.email, password: target.password });
    expect(res.statusCode).toBe(401);
  });

  it('closes every session of the user', async () => {
    const target = await newUser();
    const sessions: Session[] = [await sessionOf(target), await sessionOf(target)];

    await deleteUser(target.id, rootCookie);

    for (const session of sessions) {
      expect((await refreshWith(app, csrf, session.refreshToken)).statusCode).not.toBe(204);
    }
    expect(await asAdmin((tx) => tx.userToken.count({ where: { userId: target.id } }))).toBe(0);
  });

  // the access token is not stored on the server, so it cannot be taken back: a deleted user
  // keeps working until it runs out (its lifetime is the access ttl of the env) and the session
  // is not renewed after that. Accepted: the admin tells the person the account goes within that time
  describe.each(['USER', 'ADMIN'] as const)('a deleted %s', (role) => {
    it('keeps the access cookie only for the lifetime of the access token', async () => {
      const target = await newUser({ role });
      const session = await sessionOf(target);

      await deleteUser(target.id, rootCookie);

      const res = await getMe(app, sessionCookie({ accessToken: session.accessToken }));
      expect(res.statusCode).toBe(200);
      const { iat, exp } = jwt.decode(session.accessToken) as { iat: number; exp: number };
      expect(exp - iat).toBe(Number(env.JWT_ACCESS_TTL_SHORT));
    });

    // once the access cookie has run out the browser sends only the refresh cookie
    it('cannot renew the session once the access cookie is gone', async () => {
      const target = await newUser({ role });
      const session = await sessionOf(target);

      await deleteUser(target.id, rootCookie);

      const res = await getMe(app, sessionCookie({ refreshToken: session.refreshToken }));
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'LOGIN_REQUIRED' });
      const cookies = setCookies(res);
      expect(cookies.accessToken?.cleared).toBe(true);
      expect(cookies.refreshToken?.cleared).toBe(true);
    });
  });

  it('deletes an admin as well', async () => {
    const target = await newUser({ role: 'ADMIN' });

    const res = await deleteUser(target.id, rootCookie);

    expect(res.statusCode).toBe(200);
    expect((await rowOf(target.id)).email).toMatch(/@deleted\.com$/);
  });

  it('leaves the other users alone', async () => {
    const target = await newUser();
    const bystander = await newUser({ name: 'Boris' });

    await deleteUser(target.id, rootCookie);

    expect(await rowOf(bystander.id)).toMatchObject({ email: bystander.email, name: 'Boris' });
    const login = await logIn(app, csrf, { email: bystander.email, password: bystander.password });
    expect(login.statusCode).toBe(200);
  });

  it('leaves nothing of the person in the public profile of the account', async () => {
    const target = await newUser({
      name: 'Anna',
      avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v1/x.jpg',
    });

    await deleteUser(target.id, rootCookie);

    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${target.id}`,
      headers: { cookie: rootCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('name');
    expect(res.json()).not.toHaveProperty('avatarUrls');
  });
});
