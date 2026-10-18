import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { logIn, refreshWith, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { takeLogs } from '../../../helpers/logs.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createResetToken,
  createUser,
  uniqueEmail,
} from '../../../helpers/factories.js';
import { itWithMail, linkToken, watchMail } from '../../../helpers/mail.js';

// the mail itself goes to SendGrid in sandbox mode, that test waits for a working account;
// the reset tests take a link made the way /password/forgot stores one (createResetToken)

const GENERIC_FORGOT = 'If account exists, reset email will be sent';

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser({ email: uniqueEmail('reset'), ...opts });
  userIds.push(user.id);
  return user;
};

const forgot = (email: string) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/password/forgot',
    headers: withCsrf(csrf),
    payload: { email },
  });

const reset = (token: string, newPassword: string) =>
  app.inject({
    method: 'POST',
    url: `/api/auth/password/reset?token=${encodeURIComponent(token)}`,
    headers: withCsrf(csrf),
    payload: { newPassword },
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('POST /api/auth/password/forgot', () => {
  itWithMail('mails a reset link to the owner of a local account (SendGrid sandbox)', async () => {
    const user = await newUser();
    const mails = watchMail();

    const res = await forgot(user.email.toUpperCase());

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: GENERIC_FORGOT });
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: [user.email], sandbox: true });
    expect(mails[0]!.subject).toContain('Reset your password');
    expect(linkToken(mails[0]!, '/web/auth/reset')).toEqual(expect.any(String));
  });

  // the same answer, so the form does not tell which emails have accounts
  it('answers the same for an unknown email and mails nothing', async () => {
    const mails = watchMail();

    const res = await forgot(uniqueEmail('nobody'));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: GENERIC_FORGOT });
    expect(mails).toHaveLength(0);
  });

  it('mails nothing for an account that signs in through oauth', async () => {
    const user = await newUser({ authProvider: 'GITHUB', providerSub: `github-${Date.now()}` });
    const mails = watchMail();

    const res = await forgot(user.email);

    expect(res.json()).toEqual({ message: GENERIC_FORGOT });
    expect(mails).toHaveLength(0);
  });

  // anyone can ask for a link for any email: until the password really changes,
  // the owner must stay signed in on their devices
  it('leaves the sessions of the account alone', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);
    watchMail();

    // without a working SendGrid the mail fails with a server error, the sessions are the point here
    await forgot(user.email);

    expect((await refreshWith(app, csrf, session.refreshToken)).statusCode).toBe(204);
    expect(takeLogs({ msg: 'request failed', reason: 'SENDGRID_API_KEY_REQUIRED' })).toHaveLength(
      1,
    );
  });

  it('refuses an email that is not an email', async () => {
    const res = await forgot('not-an-email');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('POST /api/auth/password/reset', () => {
  it('sets the new password with a reset link', async () => {
    const user = await newUser();
    const token = await createResetToken(user.id);

    const res = await reset(token, 'new-password-1');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'Password reset successful' });
    expect(
      (await logIn(app, csrf, { email: user.email, password: 'new-password-1' })).statusCode,
    ).toBe(200);
    expect(
      (await logIn(app, csrf, { email: user.email, password: user.password })).statusCode,
    ).toBe(401);
  });

  it('ends every session of the account', async () => {
    const user = await newUser();
    const session = await signIn(app, csrf, user);
    const token = await createResetToken(user.id);

    await reset(token, 'new-password-2');

    expect((await refreshWith(app, csrf, session.refreshToken)).statusCode).not.toBe(204);
  });

  it('takes a link only once', async () => {
    const user = await newUser();
    const token = await createResetToken(user.id);

    const first = await reset(token, 'new-password-3');
    const second = await reset(token, 'new-password-4');

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(second.json()).toMatchObject({ errorCode: 'RESET_TOKEN_INVALID_OR_EXPIRED' });
  });

  it('refuses a link past its deadline', async () => {
    const user = await newUser();
    const token = await createResetToken(user.id, {
      createdAt: new Date(Date.now() - 7_200_000),
      expiresAt: new Date(Date.now() - 1000),
    });

    const res = await reset(token, 'new-password-5');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'RESET_TOKEN_INVALID_OR_EXPIRED' });
  });

  it('refuses a made-up token', async () => {
    const res = await reset('made-up-token-0123456789', 'new-password-6');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'RESET_TOKEN_INVALID_OR_EXPIRED' });
  });

  it('counts the new password without the spaces at its edges', async () => {
    const res = await reset('made-up-token-0123456789', '   abc   ');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PASSWORD_TOO_SHORT' });
  });

  it.each([
    ['a password under 6 characters', '12345'],
    ['a password over 64 characters', 'a'.repeat(65)],
    ['a password with non-ascii letters', 'pässwörd'],
  ])('refuses %s', async (_case, newPassword) => {
    const res = await reset('made-up-token-0123456789', newPassword);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});
