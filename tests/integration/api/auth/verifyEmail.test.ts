import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { logIn, sessionCookie, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createUser,
  createVerifyToken,
  uniqueEmail,
} from '../../../helpers/factories.js';
import { itWithMail, mailedToken, watchMail, type SentMail } from '../../../helpers/mail.js';

// the resent link comes from the mail, which goes to SendGrid in sandbox mode and waits for a
// working account; the verification tests take a link stored the way the registration stores one

const GENERIC_RESEND = 'If the email exists, a verification link was sent.';

let app: FastifyInstance;
let csrf: Csrf;
const emails: string[] = [];

const register = (email: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: withCsrf(csrf),
    payload: { email, password: 'password123' },
  });

const resend = (email: string, cookie = '') =>
  app.inject({
    method: 'POST',
    url: '/api/auth/verify/resend',
    headers: withCsrf(csrf, cookie),
    payload: { email },
  });

const verify = (token: string) =>
  app.inject({ method: 'GET', url: `/api/auth/verify?token=${encodeURIComponent(token)}` });

// a new account and the token of the link in its mail
async function registered(mails: SentMail[]) {
  const email = uniqueEmail('verify');
  emails.push(email);
  await register(email);

  return { email, token: mailedToken(mails, '/web/login') };
}

// an unverified account and its link, stored the way the registration stores one
async function unverified(opts: Parameters<typeof createVerifyToken>[1] = {}) {
  const user = await createUser({ email: uniqueEmail('verify'), isVerified: false });
  emails.push(user.email);

  return { email: user.email, token: await createVerifyToken(user.id, opts) };
}

const isVerified = async (email: string) =>
  (await asAdmin((tx) => tx.user.findUnique({ where: { email }, select: { isVerified: true } })))
    ?.isVerified;

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
  } finally {
    await stopApp();
  }
});

describe('GET /api/auth/verify', () => {
  it('verifies the email with a valid link', async () => {
    const { email, token } = await unverified();

    const res = await verify(token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Email verified' });
    expect(await isVerified(email)).toBe(true);
  });

  it('takes a link only once', async () => {
    const { token } = await unverified();

    const first = await verify(token);
    const second = await verify(token);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ errorCode: 'VERIFY_TOKEN_INVALID_OR_EXPIRED' });
  });

  it('refuses a link past its deadline', async () => {
    const { email, token } = await unverified({
      createdAt: new Date(Date.now() - 2 * 86_400_000),
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await verify(token);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VERIFY_TOKEN_INVALID_OR_EXPIRED' });
    expect(await isVerified(email)).toBe(false);
  });

  // the database keeps only hashes: a code found in it as it is was not stored by us
  it('does not take a code that the database keeps as it is', async () => {
    const { email, token } = await unverified({ stored: 'as-is' });

    const res = await verify(token);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VERIFY_TOKEN_INVALID_OR_EXPIRED' });
    expect(await isVerified(email)).toBe(false);
  });

  it('refuses a made-up token', async () => {
    const res = await verify('made-up-token-0123456789');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VERIFY_TOKEN_INVALID_OR_EXPIRED' });
  });

  it('refuses a request without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/verify' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('POST /api/auth/verify/resend', () => {
  itWithMail(
    'mails a new link to an unverified user, and that link verifies the email',
    async () => {
      const mails = watchMail();
      const { email } = await registered(mails);

      const res = await resend(email.toUpperCase());

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ message: GENERIC_RESEND });
      expect(mails).toHaveLength(2);
      expect(mails[1]).toMatchObject({ to: [email], sandbox: true });

      expect((await verify(mailedToken(mails, '/web/login'))).statusCode).toBe(200);
    },
  );

  // the same answer, so the form does not tell which emails have accounts
  it('answers the same for an unknown email and mails nothing', async () => {
    const mails = watchMail();

    const res = await resend(uniqueEmail('nobody'));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: GENERIC_RESEND });
    expect(mails).toHaveLength(0);
  });

  it('mails nothing to a user whose email is already verified', async () => {
    const user = await createUser({ email: uniqueEmail('verified') });
    emails.push(user.email);
    const mails = watchMail();

    const res = await resend(user.email);

    expect(res.json()).toEqual({ message: GENERIC_RESEND });
    expect(mails).toHaveLength(0);
  });

  it('refuses a browser that is already signed in', async () => {
    const user = await createUser({ email: uniqueEmail('signed-in') });
    emails.push(user.email);
    const session = await signIn(app, csrf, user);

    const res = await resend(user.email, sessionCookie(session));

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('refuses an email that is not an email', async () => {
    const res = await resend('not-an-email');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('verified account', () => {
  it('logs in after the email is verified, not before', async () => {
    const { email, token } = await unverified();

    const before = await logIn(app, csrf, { email, password: 'password123' });
    await verify(token);
    const after = await logIn(app, csrf, { email, password: 'password123' });

    expect(before.json()).toMatchObject({ errorCode: 'EMAIL_NOT_VERIFIED' });
    expect(after.statusCode).toBe(200);
  });
});
