import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { getMe, logIn, sessionCookie, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cookieHeader, cookieJar, setCookies } from '../../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  uniqueEmail,
  type TestProduct,
} from '../../../helpers/factories.js';

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
const products: TestProduct[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const newProduct = async () => {
  const product = await createProduct();
  products.push(product);
  return product;
};

// a guest adding a product to its favorites; returns the guest cookie
async function guestWithFavorite(productId: number, cookie = '') {
  const res = await app.inject({
    method: 'POST',
    url: `/api/favorites/${productId}`,
    headers: withCsrf(csrf, cookie),
  });
  expect(res.statusCode).toBe(200);

  return cookie || cookieHeader({ guestId: cookieJar(res).guestId });
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
    await removeProducts(products);
  } finally {
    await stopApp();
  }
});

describe('POST /api/auth/login', () => {
  it('signs a verified user in: the profile in the body, the session in httpOnly cookies', async () => {
    const user = await newUser({ name: 'Login Test' });

    const res = await logIn(app, csrf, { email: user.email, password: user.password });

    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toMatchObject({
      id: user.id,
      email: user.email,
      role: 'USER',
      isVerified: true,
      name: 'Login Test',
    });
    expect(JSON.stringify(res.json())).not.toMatch(/password/i);

    const cookies = setCookies(res);
    for (const name of ['accessToken', 'refreshToken']) {
      const cookie = cookies[name]!;
      expect(cookie.cleared).toBe(false);
      expect(cookie.attributes).toEqual(
        expect.arrayContaining(['HttpOnly', 'SameSite=Lax', 'Path=/']),
      );
      // the test server is not production: no Secure flag, so the cookies work over http
      expect(cookie.attributes).not.toContain('Secure');
    }
    // the session lives as long as the defaults: 20 minutes and a day
    expect(cookies.accessToken!.maxAge).toBe(1200);
    expect(cookies.refreshToken!.maxAge).toBe(86400);
  });

  it('opens pages for signed-in users with the cookies it sets', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);

    const me = await getMe(app, sessionCookie(session));

    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: user.id, email: user.email });
  });

  it('keeps the session longer with rememberMe', async () => {
    const user = await newUser();

    const res = await logIn(app, csrf, {
      email: user.email,
      password: user.password,
      rememberMe: true,
    });

    expect(res.statusCode).toBe(200);
    expect(setCookies(res).accessToken!.maxAge).toBe(3600);
    expect(setCookies(res).refreshToken!.maxAge).toBe(2592000);
  });

  it('accepts the email in any case and drops the spaces at the edges of the password', async () => {
    const user = await newUser();

    const res = await logIn(app, csrf, {
      email: user.email.toUpperCase(),
      password: `  ${user.password}  `,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: user.id });
  });

  // the same answer, so the login form does not tell which emails have accounts
  it('gives the same answer for a wrong password and for an unknown email', async () => {
    const user = await newUser();

    const wrongPassword = await logIn(app, csrf, { email: user.email, password: 'wrong-password' });
    const unknownEmail = await logIn(app, csrf, {
      email: uniqueEmail('nobody'),
      password: 'password123',
    });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ errorCode: 'INVALID_CREDENTIALS' });
      expect(setCookies(res).accessToken).toBeUndefined();
    }
  });

  it('tells an unverified user to verify the email only after the right password', async () => {
    const user = await newUser({ isVerified: false });

    const wrong = await logIn(app, csrf, { email: user.email, password: 'wrong-password' });
    const right = await logIn(app, csrf, { email: user.email, password: user.password });

    expect(wrong.json()).toMatchObject({ errorCode: 'INVALID_CREDENTIALS' });
    expect(right.statusCode).toBe(403);
    expect(right.json()).toMatchObject({ errorCode: 'EMAIL_NOT_VERIFIED' });
    expect(setCookies(right).accessToken).toBeUndefined();
  });

  it('sends the owner of an oauth account to its provider', async () => {
    const user = await newUser({ authProvider: 'GOOGLE', providerSub: `google-${Date.now()}` });

    const res = await logIn(app, csrf, { email: user.email, password: 'password123' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      errorCode: 'AUTH_PROVIDER_MISMATCH',
      details: { authProvider: 'GOOGLE' },
    });
  });

  it('refuses a browser that is already signed in', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);

    const res = await logIn(
      app,
      csrf,
      { email: user.email, password: user.password },
      { cookie: sessionCookie(session) },
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it.each([
    ['an email that is not an email', { email: 'not-an-email', password: 'password123' }],
    ['no password', { email: 'someone@example.com' }],
    ['a password under 6 characters', { email: 'someone@example.com', password: '12345' }],
  ])('refuses %s', async (_case, body) => {
    const res = await logIn(app, csrf, body as { email: string; password: string });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('writes the login to the login log with the address and the browser', async () => {
    const user = await newUser();

    await logIn(
      app,
      csrf,
      { email: user.email, password: user.password },
      { userAgent: 'login-test-browser/1.0' },
    );

    const logs = await asAdmin((tx) =>
      tx.loginLog.findMany({
        where: { userId: user.id },
        select: { ipAddress: true, userAgent: true },
      }),
    );
    expect(logs).toEqual([{ ipAddress: '127.0.0.1', userAgent: 'login-test-browser/1.0' }]);
  });

  it('writes nothing to the login log for a failed login', async () => {
    const user = await newUser();

    await logIn(app, csrf, { email: user.email, password: 'wrong-password' });

    const count = await asAdmin((tx) => tx.loginLog.count({ where: { userId: user.id } }));
    expect(count).toBe(0);
  });

  it('moves the favorites of the guest to the account and ends the guest cookie', async () => {
    const user = await newUser();
    const product = await newProduct();
    const guest = await guestWithFavorite(product.id);

    const res = await logIn(
      app,
      csrf,
      { email: user.email, password: user.password },
      { cookie: guest },
    );

    expect(res.statusCode).toBe(200);
    expect(setCookies(res).guestId?.cleared).toBe(true);

    const favorites = await asAdmin((tx) =>
      tx.favorite.findMany({
        where: { productId: product.id },
        select: { userId: true, guestId: true },
      }),
    );
    expect(favorites).toEqual([{ userId: user.id, guestId: null }]);
  });

  it('keeps one favorite when the guest and the account liked the same product', async () => {
    const user = await newUser();
    const product = await newProduct();
    const session = await signIn(app, csrf, user);
    await guestWithFavorite(product.id, sessionCookie(session));
    const guest = await guestWithFavorite(product.id);

    await logIn(app, csrf, { email: user.email, password: user.password }, { cookie: guest });

    const favorites = await asAdmin((tx) =>
      tx.favorite.findMany({ where: { productId: product.id }, select: { userId: true } }),
    );
    expect(favorites).toEqual([{ userId: user.id }]);
  });
});
