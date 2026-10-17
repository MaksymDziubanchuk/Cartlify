import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { logIn, sessionCookie, signIn } from '../../../helpers/actors.js';
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
import { itWithMail, linkToken, mailedToken, watchMail } from '../../../helpers/mail.js';

// the tests that mail go to SendGrid in sandbox mode: they need a SendGrid key in the test
// environment and the app sending in sandbox mode, until then they fail

let app: FastifyInstance;
let csrf: Csrf;
const emails: string[] = [];
const products: TestProduct[] = [];

const register = (body: Record<string, unknown>, cookie = '') =>
  app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: withCsrf(csrf, cookie),
    payload: body,
  });

const newEmail = () => {
  const email = uniqueEmail('register');
  emails.push(email);
  return email;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    const users = await asAdmin((tx) =>
      tx.user.findMany({ where: { email: { in: emails } }, select: { id: true } }),
    );
    await closeSessions(users.map((u) => u.id));
    await removeProducts(products);
  } finally {
    await stopApp();
  }
});

describe('POST /api/auth/register', () => {
  itWithMail(
    'creates an unverified user and mails a verification link (SendGrid sandbox)',
    async () => {
      const mails = watchMail();
      const email = newEmail();

      const res = await register({
        email: email.toUpperCase(),
        password: 'password123',
        name: ' Ann ',
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ email, role: 'USER', isVerified: false, name: 'Ann' });
      expect(JSON.stringify(res.json())).not.toMatch(/password/i);
      // registration does not sign in: the email has to be verified first
      expect(setCookies(res).accessToken).toBeUndefined();

      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ to: [email], sandbox: true });
      expect(mails[0]!.status).toBeGreaterThanOrEqual(200);
      expect(mails[0]!.status).toBeLessThan(300);
      expect(mails[0]!.subject).toContain('Verify your email');
      expect(linkToken(mails[0]!, '/web/login')).toEqual(expect.any(String));
    },
  );

  itWithMail(
    'lets the link from the mail verify the email, after which the user logs in',
    async () => {
      const mails = watchMail();
      const email = newEmail();
      await register({ email, password: 'password123' });
      const token = mailedToken(mails, '/web/login');

      const verify = await app.inject({
        method: 'GET',
        url: `/api/auth/verify?token=${encodeURIComponent(token)}`,
      });
      const login = await logIn(app, csrf, { email, password: 'password123' });

      expect(verify.statusCode).toBe(200);
      expect(login.statusCode).toBe(200);
    },
  );

  // a copy of the database must not be enough to verify someone else's email
  itWithMail(
    'keeps the token of the link out of the database in the form it is mailed',
    async () => {
      const mails = watchMail();
      const email = newEmail();
      await register({ email, password: 'password123' });
      const token = mailedToken(mails, '/web/login');

      const stored = await asAdmin((tx) =>
        tx.userToken.findMany({
          where: { user: { email }, type: 'VERIFY_EMAIL' },
          select: { token: true },
        }),
      );

      expect(token).toEqual(expect.any(String));
      expect(stored).toHaveLength(1);
      expect(stored[0]!.token).not.toBe(token);
    },
  );

  itWithMail('moves the favorites of the guest to the new account', async () => {
    const product = await createProduct();
    products.push(product);
    const added = await app.inject({
      method: 'POST',
      url: `/api/favorites/${product.id}`,
      headers: withCsrf(csrf),
    });
    const guest = cookieHeader({ guestId: cookieJar(added).guestId });
    watchMail();
    const email = newEmail();

    const res = await register({ email, password: 'password123' }, guest);

    expect(res.statusCode).toBe(201);
    const favorites = await asAdmin((tx) =>
      tx.favorite.findMany({ where: { productId: product.id }, select: { userId: true } }),
    );
    expect(favorites).toEqual([{ userId: res.json().id }]);
  });

  itWithMail('answers 502 VERIFY_EMAIL_SEND_FAILED when SendGrid refuses the mail', async () => {
    const realFetch = globalThis.fetch;
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) =>
        String(input).startsWith('https://api.sendgrid.com/')
          ? new Response('{"errors":[{"message":"down"}]}', { status: 503 })
          : realFetch(input, init),
      );

    const res = await register({ email: newEmail(), password: 'password123' });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ errorCode: 'VERIFY_EMAIL_SEND_FAILED' });
  });

  it('refuses an email that is already registered, in any case', async () => {
    const user = await createUser({ email: newEmail() });

    const same = await register({ email: user.email, password: 'password123' });
    const upper = await register({ email: user.email.toUpperCase(), password: 'password123' });

    for (const res of [same, upper]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'EMAIL_ALREADY_IN_USE' });
    }
  });

  it.each([
    ['an email that is not an email', { email: 'not-an-email', password: 'password123' }],
    ['no password', { email: 'someone@example.com' }],
    ['a password under 6 characters', { email: 'someone@example.com', password: '12345' }],
    ['a password over 64 characters', { email: 'someone@example.com', password: 'a'.repeat(65) }],
    ['a password with non-ascii letters', { email: 'someone@example.com', password: 'pässwörd' }],
  ])('refuses %s', async (_case, body) => {
    const res = await register(body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('counts the password without the spaces at its edges', async () => {
    const res = await register({ email: newEmail(), password: '   abc   ' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PASSWORD_TOO_SHORT' });
  });

  it('refuses a browser that is already signed in', async () => {
    const user = await createUser({ email: newEmail() });
    const session = await signIn(app, csrf, user);

    const res = await register(
      { email: newEmail(), password: 'password123' },
      sessionCookie(session),
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});
