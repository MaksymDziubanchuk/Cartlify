import type { FastifyInstance } from 'fastify';

import { signAccessToken } from '@utils/jwt.js';

import { cookieHeader, cookieJar } from './cookies.js';
import { withCsrf, type Csrf } from './csrf.js';
import type { TestUser } from './factories.js';
import { codeOf, newTestApp, postTwoFactor, ticketCookieOf } from './twoFactor.js';

export type Session = { accessToken: string; refreshToken: string };

// a browser logging in with email and password; extra cookies go along (for example a guestId)
export function logIn(
  app: FastifyInstance,
  csrf: Csrf,
  body: { email: string; password: string; rememberMe?: boolean },
  opts: { cookie?: string; userAgent?: string } = {},
) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: {
      ...withCsrf(csrf, opts.cookie),
      ...(opts.userAgent ? { 'user-agent': opts.userAgent } : {}),
    },
    payload: body,
  });
}

// a signed-in session of the user, the two auth cookies; an admin or root goes through the second
// step as a person does
export async function signIn(
  app: FastifyInstance,
  csrf: Csrf,
  user: TestUser,
  opts: { rememberMe?: boolean } = {},
): Promise<Session> {
  const res = await logIn(app, csrf, {
    email: user.email,
    password: user.password,
    ...(opts.rememberMe !== undefined ? { rememberMe: opts.rememberMe } : {}),
  });
  const done = await finishLogin(app, csrf, user, res);
  if (done.statusCode !== 200) {
    throw new Error(`login of ${user.email} answered ${done.statusCode}`);
  }

  const jar = cookieJar(done);
  return { accessToken: jar.accessToken!, refreshToken: jar.refreshToken! };
}

// the answer that opened the session: the login itself, or the second step of an admin or root the
// way the person goes through it: the first login sets the app up with the secret the answer shows
// (the user keeps the app), a later one types its code
export async function finishLogin(
  app: FastifyInstance,
  csrf: Csrf,
  user: TestUser,
  res: Awaited<ReturnType<typeof logIn>>,
  userAgent?: string,
) {
  if (res.statusCode !== 202) return res;
  if (res.json().twoFactor === 'setup') {
    const started = await postTwoFactor(
      app,
      csrf,
      '/setup',
      ticketCookieOf(res),
      undefined,
      userAgent,
    );
    if (started.statusCode !== 200) {
      throw new Error(`the setup of ${user.email} answered ${started.statusCode}`);
    }
    user.twoFactorApp = newTestApp(started.json().secret);

    return postTwoFactor(
      app,
      csrf,
      '/setup/confirm',
      ticketCookieOf(started),
      { code: codeOf(user.twoFactorApp) },
      userAgent,
    );
  }

  if (!user.twoFactorApp) throw new Error(`${user.email} has no app to type a code from`);
  return postTwoFactor(
    app,
    csrf,
    '/verify',
    ticketCookieOf(res),
    { code: codeOf(user.twoFactorApp) },
    userAgent,
  );
}

export const sessionCookie = (session: Partial<Session>) => cookieHeader(session);

// the access cookie of a user without a login: the token the app itself signs for them. For tests
// of a route that need a signed-in user, not the login; a real login costs a request of the 100 a
// minute the rate limit lets one address make, and the time of a password check
export const accessCookie = (user: Pick<TestUser, 'id' | 'role'>) =>
  cookieHeader({
    accessToken: signAccessToken({ userId: user.id, role: user.role, type: 'access' }, false),
  });

// a page for signed-in users: 200 with the profile when the cookies hold a session
export const getMe = (app: FastifyInstance, cookie: string) =>
  app.inject({ method: 'GET', url: '/api/users/me', headers: cookie ? { cookie } : {} });

// the refresh route with only a refresh cookie, the way the frontend renews a session
export const refreshWith = (app: FastifyInstance, csrf: Csrf, refreshToken: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    headers: withCsrf(csrf, cookieHeader({ refreshToken })),
  });
