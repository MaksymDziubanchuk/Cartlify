import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createUser,
  uniqueEmail,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { watchMail } from '../../../helpers/mail.js';
import {
  breakTurnstile,
  CAPTCHA_TOKEN,
  failCaptcha,
  spendCaptcha,
  useCaptchaSecret,
  watchCaptcha,
  withCaptcha,
  type TurnstileOutage,
} from '../../../helpers/turnstile.js';
import { TURNSTILE_TEST_SECRETS } from '../../../setup/isolateEnv.js';

// The captcha (Cloudflare Turnstile) on the three routes that send a mail or open an account for
// anybody: the registration, the mail of a password reset, the mail of a verification. The field
// captchaToken of the body carries the answer of the widget. A refused captcha is checked before
// the route does anything: no account, no mail, no token. Cloudflare answers from the mock of
// tests/helpers/turnstile.ts (the real service with service:turnstile, the dummy secrets of
// Cloudflare either way)

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
const emails: string[] = [];

// one request, from an address of its own the proxy names (one hop is trusted)
let addresses = 0;
const nextAddress = () => `198.51.100.${(addresses += 1)}`;

const post = (url: string, payload: unknown, from = nextAddress(), cookie = '') =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...withCsrf(csrf, cookie), 'x-forwarded-for': from },
    payload: payload as Record<string, unknown>,
  });

const countOf = (email: string) =>
  asAdmin(async (tx) => {
    const user = await tx.user.findUnique({ where: { email }, select: { id: true } });
    return {
      users: user ? 1 : 0,
      tokens: user ? await tx.userToken.count({ where: { userId: user.id } }) : 0,
    };
  });

type Scenario = {
  name: string;
  url: string;
  // the status the route answers when the captcha passes
  ok: number;
  // a body without the answer of the captcha, and the address the route works on
  prepare: () => Promise<{ body: Record<string, unknown>; email: string }>;
};

const SCENARIOS: Scenario[] = [
  {
    name: 'POST /api/auth/register',
    url: '/api/auth/register',
    ok: 201,
    prepare: async () => {
      const email = uniqueEmail('captcha-register');
      emails.push(email);
      return { body: { email, password: 'password123' }, email };
    },
  },
  {
    name: 'POST /api/auth/password/forgot',
    url: '/api/auth/password/forgot',
    ok: 200,
    prepare: async () => {
      const user: TestUser = await createUser({ email: uniqueEmail('captcha-forgot') });
      userIds.push(user.id);
      emails.push(user.email);
      return { body: { email: user.email }, email: user.email };
    },
  },
  {
    name: 'POST /api/auth/verify/resend',
    url: '/api/auth/verify/resend',
    ok: 200,
    prepare: async () => {
      const user: TestUser = await createUser({
        email: uniqueEmail('captcha-resend'),
        isVerified: false,
      });
      userIds.push(user.id);
      emails.push(user.email);
      return { body: { email: user.email }, email: user.email };
    },
  },
];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    const users = await asAdmin((tx) =>
      tx.user.findMany({ where: { email: { in: emails } }, select: { id: true } }),
    );
    await closeSessions([...userIds, ...users.map((user) => user.id)]);
  } finally {
    await stopApp();
  }
});

describe.each(SCENARIOS)('$name', ({ url, ok, prepare }) => {
  it('works as before when the captcha passes, and asks Cloudflare once about this visitor', async () => {
    const { body, email } = await prepare();
    const mails = watchMail();
    const calls = watchCaptcha();
    const from = nextAddress();

    const res = await post(url, withCaptcha(body), from);

    expect(res.statusCode).toBe(ok);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: [email], accepted: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      secret: env.TURNSTILE_SECRET_KEY,
      response: CAPTCHA_TOKEN,
      remoteip: from,
      status: 200,
    });
    // the answer of the captcha is no part of what the route answers
    expect(res.body).not.toContain(CAPTCHA_TOKEN);
  });

  describe('a request the schema of the route refuses', () => {
    // a body that fails the schema never costs a call to Cloudflare
    it.each([
      ['no captchaToken', (body: Record<string, unknown>) => body],
      ['an empty captchaToken', (body: Record<string, unknown>) => ({ ...body, captchaToken: '' })],
      [
        'a captchaToken of 2049 characters',
        (body: Record<string, unknown>) => ({ ...body, captchaToken: 'x'.repeat(2049) }),
      ],
      [
        'a captchaToken that is null',
        (body: Record<string, unknown>) => ({ ...body, captchaToken: null }),
      ],
      [
        'a captchaToken that is an object',
        (body: Record<string, unknown>) => ({ ...body, captchaToken: { token: CAPTCHA_TOKEN } }),
      ],
    ])('is refused with %s, with no call to Cloudflare and no effect', async (_case, shape) => {
      const { body, email } = await prepare();
      const before = await countOf(email);
      const mails = watchMail();
      const calls = watchCaptcha();

      const res = await post(url, shape(body));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'VALIDATION_ERROR',
        details: [
          expect.objectContaining({ in: 'body', field: expect.stringMatching(/captchaToken/) }),
        ],
      });
      expect(calls).toHaveLength(0);
      expect(mails).toHaveLength(0);
      expect(await countOf(email)).toEqual(before);
    });

    it('is refused with a wrong email even though the captcha is good, with no call to Cloudflare', async () => {
      const { body } = await prepare();
      const calls = watchCaptcha();

      const res = await post(url, withCaptcha({ ...body, email: 'not-an-email' }));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
      expect(calls).toHaveLength(0);
    });

    // a token of Turnstile is up to 2048 characters
    it('takes the answer of the captcha at its length limit, 2048 characters', async () => {
      const { body } = await prepare();
      const calls = watchCaptcha();

      const res = await post(url, { ...body, captchaToken: 'x'.repeat(2048) });

      expect(res.statusCode).toBe(ok);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.response).toHaveLength(2048);
    });
  });

  describe('a captcha Cloudflare refuses (400 CAPTCHA_INVALID)', () => {
    it.each([
      ['an answer that fails', failCaptcha],
      ['an answer that was used before', spendCaptcha],
    ])(
      'refuses %s, and does nothing else: no account, no mail, no token',
      async (_case, refuse) => {
        const { body, email } = await prepare();
        const before = await countOf(email);
        const mails = watchMail();
        const calls = watchCaptcha();
        refuse();

        const res = await post(url, withCaptcha(body));

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code: 400, errorCode: 'CAPTCHA_INVALID' });
        expect(calls).toHaveLength(1);
        expect(mails).toHaveLength(0);
        expect(await countOf(email)).toEqual(before);
      },
    );

    // the answer is the same whether the email has an account or not: the captcha says nothing about it
    it('answers the same for an email that has an account and one that has not', async () => {
      const known = await prepare();
      const unknown = { body: { ...known.body, email: uniqueEmail('captcha-unknown') } };
      failCaptcha();

      const first = await post(url, withCaptcha(known.body));
      const second = await post(url, withCaptcha(unknown.body));

      expect(first.statusCode).toBe(400);
      expect(second.statusCode).toBe(400);
      const withoutReqId = (res: typeof first) => ({
        ...(res.json() as Record<string, unknown>),
        reqId: null,
      });
      expect(withoutReqId(first)).toEqual(withoutReqId(second));
    });
  });

  describe('a Cloudflare that cannot say (503 CAPTCHA_UNAVAILABLE)', () => {
    it.each<[string, TurnstileOutage]>([
      ['does not answer the request at all', 'unreachable'],
      ['answers with a failure of its server', 'server-error'],
      ['answers with a page that is no json', 'not-json'],
    ])('refuses when Cloudflare %s, and does nothing else', async (_case, outage) => {
      const { body, email } = await prepare();
      const before = await countOf(email);
      const mails = watchMail();
      const calls = watchCaptcha();
      breakTurnstile(outage);

      const res = await post(url, withCaptcha(body));

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 503, errorCode: 'CAPTCHA_UNAVAILABLE' });
      expect(calls).toHaveLength(1);
      expect(mails).toHaveLength(0);
      expect(await countOf(email)).toEqual(before);
      // the server says it: a warning with the reason, and the failed request
      expect(takeLogs({ msg: 'captcha could not be checked' })).toHaveLength(1);
      expect(takeLogs({ errorCode: 'CAPTCHA_UNAVAILABLE' })).toHaveLength(1);
    });

    // the secret of the shop is wrong: the visitor cannot mend that by solving the widget again
    it('refuses with 503, not 400, when Cloudflare does not know the secret of the shop', async () => {
      const { body, email } = await prepare();
      const mails = watchMail();
      useCaptchaSecret('a-secret-cloudflare-does-not-know');

      const res = await post(url, withCaptcha(body));

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ errorCode: 'CAPTCHA_UNAVAILABLE' });
      expect(mails).toHaveLength(0);
      expect((await countOf(email)).tokens).toBe(0);
      const warned = takeLogs({ msg: 'captcha could not be checked' });
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatchObject({
        reason: 'SITEVERIFY_FAULT',
        errorCodes: ['invalid-input-secret'],
      });
      takeLogs({ errorCode: 'CAPTCHA_UNAVAILABLE' });
    });
  });

  describe('what goes in the logs', () => {
    // the answer of the visitor and the secret of the shop are in no line, whatever went wrong
    it.each<[string, () => void]>([
      ['a failed captcha', failCaptcha],
      ['an unreachable Cloudflare', () => breakTurnstile('unreachable')],
      ['a failure of Cloudflare', () => breakTurnstile('server-error')],
      ['an unknown secret', () => useCaptchaSecret('a-secret-cloudflare-does-not-know')],
    ])('hold neither the token nor the secret after %s', async (_case, refuse) => {
      const { body } = await prepare();
      const secret = env.TURNSTILE_SECRET_KEY;
      const token = `${CAPTCHA_TOKEN}.${Math.random().toString(16).slice(2)}`;
      refuse();

      const res = await post(url, { ...body, captchaToken: token });

      expect([400, 503]).toContain(res.statusCode);
      const lines = takeLogs({});
      const text = JSON.stringify(lines);
      expect(text).not.toContain(token);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(env.TURNSTILE_SECRET_KEY);
      expect(res.body).not.toContain(token);
    });
  });
});

// the captcha is the last thing the route asks, after the guards and the limits: a request those
// refuse costs no call to Cloudflare
describe('the captcha comes after the guards of the route', () => {
  it('does not ask Cloudflare when a signed-in user registers (403 INSUFFICIENT_ROLE)', async () => {
    const user = await createUser({ email: uniqueEmail('captcha-signed-in') });
    userIds.push(user.id);
    const calls = watchCaptcha();

    const res = await post(
      '/api/auth/register',
      withCaptcha({ email: uniqueEmail('captcha-late'), password: 'password123' }),
      nextAddress(),
      accessCookie(user),
    );

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(calls).toHaveLength(0);
  });
});

// Cloudflare that holds the request till the app gives up: five seconds of the real clock, once
describe('a Cloudflare that does not answer in time', () => {
  it('refuses the registration after 5 seconds with 503 CAPTCHA_UNAVAILABLE, and creates nothing', async () => {
    const { body, email } = await SCENARIOS[0]!.prepare();
    const mails = watchMail();
    breakTurnstile('hangs');

    const started = Date.now();
    const res = await post('/api/auth/register', withCaptcha(body));
    const took = Date.now() - started;

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errorCode: 'CAPTCHA_UNAVAILABLE' });
    expect(took).toBeGreaterThanOrEqual(4_900);
    expect(took).toBeLessThan(10_000);
    expect(mails).toHaveLength(0);
    expect(await countOf(email)).toEqual({ users: 0, tokens: 0 });
    expect(takeLogs({ msg: 'captcha could not be checked' })).toHaveLength(1);
    expect(takeLogs({ errorCode: 'CAPTCHA_UNAVAILABLE' })).toHaveLength(1);
  });
});

// the routes that have no captcha: the login, the end of a reset, the verification link
describe('the routes without a captcha', () => {
  it('lets the login, the reset of the password and the verification link through without it', async () => {
    const user = await createUser({ email: uniqueEmail('captcha-none') });
    userIds.push(user.id);
    const calls = watchCaptcha();

    const login = await post('/api/auth/login', { email: user.email, password: user.password });
    const reset = await post('/api/auth/password/reset', {
      token: 'made-up-token-of-no-user',
      newPassword: 'password123',
    });
    const verify = await post('/api/auth/verify', { token: 'made-up-token' });

    expect(login.statusCode).toBe(200);
    expect(reset.statusCode).toBe(400);
    expect(verify.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

// the dummy secrets the tests start with are what the file expects; a change there shows here first
describe('the secret of the tests', () => {
  it('is the dummy secret of Cloudflare that passes every answer', () => {
    expect(env.TURNSTILE_SECRET_KEY).toBe(TURNSTILE_TEST_SECRETS.pass);
  });
});
