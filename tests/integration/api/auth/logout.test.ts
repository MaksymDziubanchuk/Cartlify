import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { refreshWith, sessionCookie, signIn, type Session } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { setCookies } from '../../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser } from '../../../helpers/factories.js';

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const newUser = async () => {
  const user = await createUser();
  userIds.push(user.id);
  return user;
};

const logout = (cookie: string, body: Record<string, unknown> = {}) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: withCsrf(csrf, cookie),
    payload: body,
  });

// refresh tokens of the user that still renew a session
const openSessions = (userId: number) =>
  asAdmin((tx) =>
    tx.userToken.count({
      where: { userId, type: 'REFRESH_TOKEN', usedAt: null, expiresAt: { gt: new Date() } },
    }),
  );

const stillWorks = async (session: Session) =>
  (await refreshWith(app, csrf, session.refreshToken)).statusCode === 204;

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

describe('POST /api/auth/logout', () => {
  it('ends the session: both cookies cleared and the refresh token closed', async () => {
    const session = await signIn(app, csrf, await newUser());

    const res = await logout(sessionCookie(session));

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(setCookies(res).accessToken?.cleared).toBe(true);
    expect(setCookies(res).refreshToken?.cleared).toBe(true);
    expect(await stillWorks(session)).toBe(false);
  });

  it('ends only this session by default', async () => {
    const user = await newUser();
    const phone = await signIn(app, csrf, user);
    const laptop = await signIn(app, csrf, user);

    await logout(sessionCookie(phone));

    expect(await stillWorks(laptop)).toBe(true);
  });

  it('ends every session of the user with allDevices', async () => {
    const user = await newUser();
    const phone = await signIn(app, csrf, user);
    const laptop = await signIn(app, csrf, user);

    const res = await logout(sessionCookie(phone), { allDevices: true });

    expect(res.statusCode).toBe(204);
    expect(await stillWorks(laptop)).toBe(false);
  });

  // the laptop kept the cookie of a session the logout closed: no stolen token, the session the
  // person opens next goes on
  it('leaves a new session alone when a session the logout of all devices closed comes back', async () => {
    const user = await newUser();
    const laptop = await signIn(app, csrf, user);
    await logout(sessionCookie(await signIn(app, csrf, user)), { allDevices: true });
    const next = await signIn(app, csrf, user);

    const closed = await refreshWith(app, csrf, laptop.refreshToken);

    expect(closed.statusCode).toBe(401);
    expect(closed.json()).toMatchObject({ errorCode: 'REFRESH_TOKEN_REVOKED' });
    expect(await stillWorks(next)).toBe(true);
  });

  it('leaves the other sessions alone when the session it ended comes back', async () => {
    const user = await newUser();
    const phone = await signIn(app, csrf, user);
    const laptop = await signIn(app, csrf, user);
    await logout(sessionCookie(phone));

    expect((await refreshWith(app, csrf, phone.refreshToken)).statusCode).toBe(401);
    expect(await stillWorks(laptop)).toBe(true);
  });

  it('clears the cookies even without a refresh cookie', async () => {
    const session = await signIn(app, csrf, await newUser());

    const res = await logout(sessionCookie({ accessToken: session.accessToken }));

    expect(res.statusCode).toBe(204);
    expect(setCookies(res).accessToken?.cleared).toBe(true);
    expect(setCookies(res).refreshToken?.cleared).toBe(true);
  });

  it('leaves the sessions of others alone', async () => {
    const mine = await signIn(app, csrf, await newUser());
    const someoneElse = await signIn(app, csrf, await newUser());

    // a refresh token of another user next to my own access token
    await logout(
      sessionCookie({ accessToken: mine.accessToken, refreshToken: someoneElse.refreshToken }),
      {
        allDevices: true,
      },
    );

    expect(await stillWorks(someoneElse)).toBe(true);
  });

  // the access cookie lives 20 minutes: someone coming back later logs out with the refresh
  // cookie alone, the guard renews the session first, and logging out still has to end it
  it('ends the session when the access cookie has expired', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);

    const res = await logout(sessionCookie({ refreshToken: session.refreshToken }));

    expect(res.statusCode).toBe(204);
    expect(await openSessions(user.id)).toBe(0);
  });

  it('ends every session with allDevices when the access cookie has expired', async () => {
    const user = await newUser();
    const phone = await signIn(app, csrf, user);
    const laptop = await signIn(app, csrf, user);

    const res = await logout(sessionCookie({ refreshToken: phone.refreshToken }), {
      allDevices: true,
    });

    expect(res.statusCode).toBe(204);
    expect(await stillWorks(laptop)).toBe(false);
    expect(await openSessions(user.id)).toBe(0);
  });

  it('refuses a guest', async () => {
    const res = await logout('');

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});
