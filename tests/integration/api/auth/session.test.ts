import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { getMe, refreshWith, sessionCookie, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cookieHeader, setCookies } from '../../../helpers/cookies.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser } from '../../../helpers/factories.js';

// how every request finds its actor (src/middlewares/auth.ts): the access cookie, a silent
// refresh with the refresh cookie when access is gone, otherwise a guest

// JWT_ACCESS_SECRET from tests/setup/isolateEnv.ts
const ACCESS_SECRET = 'test-access-secret';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const newUser = async () => {
  const user = await createUser();
  userIds.push(user.id);
  return user;
};

// a page every visitor may open
const visit = (cookie = '') =>
  app.inject({ method: 'GET', url: '/api/favorites', headers: cookie ? { cookie } : {} });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('guest', () => {
  it('gets a guest cookie on the first visit', async () => {
    const res = await visit();

    const guest = setCookies(res).guestId;
    expect(res.statusCode).toBe(200);
    expect(guest?.value).toMatch(UUID);
    expect(guest?.attributes).toEqual(
      expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/']),
    );
  });

  it('keeps the guest cookie of a returning guest', async () => {
    const guestId = setCookies(await visit()).guestId!.value;

    const res = await visit(cookieHeader({ guestId }));

    expect(setCookies(res).guestId).toBeUndefined();
  });

  it('replaces a guest cookie that is not a guest id', async () => {
    const res = await visit(cookieHeader({ guestId: 'not-a-uuid' }));

    expect(setCookies(res).guestId?.value).toMatch(UUID);
  });
});

describe('signed-in user', () => {
  it('is recognised by the access cookie', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);

    const res = await getMe(app, sessionCookie({ accessToken: session.accessToken }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: user.id });
  });

  // the browser drops the access cookie when it expires
  it('stays signed in when the access cookie is gone: the refresh cookie renews the session', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);

    const res = await getMe(app, sessionCookie({ refreshToken: session.refreshToken }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: user.id });
    const cookies = setCookies(res);
    expect(cookies.accessToken?.cleared).toBe(false);
    expect(cookies.refreshToken?.value).not.toBe(session.refreshToken);
    // the refresh token is rotated, the old one is spent
    expect((await refreshWith(app, csrf, session.refreshToken)).statusCode).not.toBe(204);
  });

  it('renews the session when the access token in the cookie has expired', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);
    const expired = jwt.sign(
      { userId: user.id, role: 'USER', type: 'access', exp: Math.floor(Date.now() / 1000) - 60 },
      ACCESS_SECRET,
    );

    const res = await getMe(
      app,
      sessionCookie({ accessToken: expired, refreshToken: session.refreshToken }),
    );

    expect(res.statusCode).toBe(200);
    expect(setCookies(res).accessToken?.cleared).toBe(false);
  });

  it.each([
    ['a broken access cookie', () => 'not-a-jwt'],
    [
      'an access token signed with another secret',
      () => jwt.sign({ userId: 1, role: 'ADMIN', type: 'access' }, 'someone-elses-secret'),
    ],
    [
      'a refresh token passed off as an access token',
      () => jwt.sign({ userId: 1, role: 'ADMIN', type: 'refresh', jwtId: 1 }, ACCESS_SECRET),
    ],
  ])('refuses %s without a refresh cookie and drops it', async (_case, token) => {
    const res = await getMe(app, sessionCookie({ accessToken: token() }));

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'LOGIN_REQUIRED' });
    expect(setCookies(res).accessToken?.cleared).toBe(true);
  });

  it('refuses a refresh cookie that does not hold a valid token and drops both cookies', async () => {
    const res = await getMe(app, sessionCookie({ refreshToken: 'not-a-jwt' }));

    expect(res.statusCode).toBe(401);
    expect(setCookies(res).refreshToken?.cleared).toBe(true);
  });

  it('gives a guest no way into a page for signed-in users', async () => {
    const res = await getMe(app, '');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});
