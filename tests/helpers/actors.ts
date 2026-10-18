import type { FastifyInstance } from 'fastify';

import { signAccessToken } from '@utils/jwt.js';

import { cookieHeader, cookieJar } from './cookies.js';
import { withCsrf, type Csrf } from './csrf.js';
import type { TestUser } from './factories.js';

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

// a signed-in session of the user, the two auth cookies
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
  if (res.statusCode !== 200) throw new Error(`login of ${user.email} answered ${res.statusCode}`);

  const jar = cookieJar(res);
  return { accessToken: jar.accessToken!, refreshToken: jar.refreshToken! };
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
