import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import bcrypt from 'bcrypt';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import { refuseMail, resetSendGrid, watchMail } from '../../../helpers/mail.js';
import { takeLogs } from '../../../helpers/logs.js';
import { asAdmin } from '../../../helpers/db.js';
import { moveClock } from '../../../helpers/payments.js';
import {
  failCaptcha,
  resetTurnstile,
  watchCaptcha,
  withCaptcha,
} from '../../../helpers/turnstile.js';

// the limits of the routes a script would abuse: the login, the registration, the mails of a
// password reset and of a verification, the payment page, a review. The server sits behind the proxy of
// railway: the address of a client is the one the proxy names in x-forwarded-for, one hop
// (TRUST_PROXY_HOPS). Each test comes from addresses of its own, so the counts do not mix. The
// other integration files raise every limit a thousand times (their requests all come from
// 127.0.0.1); this one checks them as the server has them, the limits read the scale on each request

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];
let clock: { restore: () => void } | null = null;
let addresses = 0;

// an address of the documentation range (rfc 5737), a new one for each call
const nextAddress = () => `203.0.113.${(addresses += 1)}`;

const unique = (name: string) =>
  `limits-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}@shop.example.com`;

const post = (url: string, payload: Record<string, unknown>, from: string, cookie?: string) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...withCsrf(csrf, cookie), 'x-forwarded-for': from },
    payload,
  });

const login = (email: string, password: string, from: string) =>
  post('/api/auth/login', { email, password }, from);

const scale = env.REQUEST_LIMITS_SCALE;

beforeAll(async () => {
  env.REQUEST_LIMITS_SCALE = 1;
  app = await startApp();
  csrf = await getCsrf(app);
});

afterEach(() => {
  clock?.restore();
  clock = null;
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    env.REQUEST_LIMITS_SCALE = scale;
    await stopApp();
  }
});

describe('the address of a client', () => {
  // with one hop trusted, the counts are of the client, not of the proxy that serves them all
  it('counts the requests of each address the proxy names on their own', async () => {
    const first = nextAddress();
    const second = nextAddress();

    const remaining = async (from: string) =>
      Number(
        (await app.inject({ method: 'GET', url: '/api/auth/csrf', headers: { 'x-forwarded-for': from } }))
          .headers['x-ratelimit-remaining'],
      );

    const a1 = await remaining(first);
    const a2 = await remaining(first);
    const b1 = await remaining(second);

    expect(a2).toBe(a1 - 1);
    expect(b1).toBe(a1);
  });
});

describe('POST /api/auth/login', () => {
  it('refuses the 31st login from one address in 10 minutes', async () => {
    const from = nextAddress();
    for (let i = 0; i < 30; i += 1) {
      expect((await login(unique(`ip${i}`), 'wrong-password', from)).statusCode).toBe(401);
    }

    const refused = await login(unique('ip-last'), 'wrong-password', from);

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ errorCode: 'RATE_LIMITED', details: { limit: 'login' } });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('refuses the 11th login of one email in 10 minutes, from any address', async () => {
    const email = unique('email');
    for (let i = 0; i < 10; i += 1) {
      await login(email, 'wrong-password', nextAddress());
    }

    const refused = await login(email, 'wrong-password', nextAddress());

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ errorCode: 'RATE_LIMITED', details: { limit: 'login' } });
  });

  // an account is its address as it is written: a +tag or a dot of Gmail names another account, so the
  // counts of the login (unlike those of the mails) do not fold them together
  it('counts the logins of the ways to write an address apart: they are other accounts', async () => {
    const name = unique('accounts').split('@')[0]!;
    for (let i = 0; i < 10; i += 1) {
      await login(`${name}+a@shop.example.com`, 'wrong-password', nextAddress());
    }

    const other = await login(`${name}+b@shop.example.com`, 'wrong-password', nextAddress());

    expect(other.statusCode).toBe(401);
  });

  // a password guessed at: after 5 wrong passwords the account pauses, longer after each next one
  it('pauses the login of an account after 5 wrong passwords, also for the right one', async () => {
    const user: TestUser = await createUser({ password: 'right-password' });
    userIds.push(user.id);
    for (let i = 0; i < 5; i += 1) {
      expect((await login(user.email, 'wrong-password', nextAddress())).statusCode).toBe(401);
    }

    const paused = await login(user.email, 'right-password', nextAddress());

    expect(paused.statusCode).toBe(429);
    expect(paused.json()).toMatchObject({ errorCode: 'LOGIN_PAUSED' });
    expect(Number(paused.headers['retry-after'])).toBe(60);

    // the pause is over: the right password signs in and the count starts over
    clock = moveClock(61_000);
    expect((await login(user.email, 'right-password', nextAddress())).statusCode).toBe(200);
  });

  it('pauses longer after each wrong password past the fifth', async () => {
    const user: TestUser = await createUser({ password: 'right-password' });
    userIds.push(user.id);
    for (let i = 0; i < 5; i += 1) await login(user.email, 'wrong-password', nextAddress());
    clock = moveClock(61_000);

    // the sixth wrong one pauses for 2 minutes
    expect((await login(user.email, 'wrong-password', nextAddress())).statusCode).toBe(401);
    const paused = await login(user.email, 'right-password', nextAddress());

    expect(paused.statusCode).toBe(429);
    expect(Number(paused.headers['retry-after'])).toBe(120);
  });
});

describe('POST /api/auth/register', () => {
  it('refuses the 11th registration from one address in an hour', async () => {
    const from = nextAddress();
    const calls = watchCaptcha();
    for (let i = 0; i < 10; i += 1) {
      const res = await post(
        '/api/auth/register',
        withCaptcha({ email: unique(`reg${i}`), password: 'secret-pass' }),
        from,
      );
      expect(res.statusCode).toBe(201);
    }

    const refused = await post(
      '/api/auth/register',
      withCaptcha({ email: unique('reg-last'), password: 'secret-pass' }),
      from,
    );

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      errorCode: 'RATE_LIMITED',
      details: { limit: 'register' },
    });
    // the limit comes before the captcha: the refused request costs no call to Cloudflare
    expect(calls).toHaveLength(10);
  });

  // Registering an address that is not verified yet takes the account again and mails a new link, so
  // the email is counted like the email of the other mails: one registration of an email in 3 minutes,
  // after the captcha (the address of the client is counted before it)
  describe('the email of a registration', () => {
    const register = (email: string, from = nextAddress()) =>
      post('/api/auth/register', withCaptcha({ email, password: 'secret-pass' }), from);

    it('takes one registration of an email in 3 minutes, from any address', async () => {
      const email = unique('reg-email');
      const calls = watchCaptcha();

      expect((await register(email)).statusCode).toBe(201);
      const refused = await register(email);

      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({
        errorCode: 'RATE_LIMITED',
        details: { limit: 'register', retryAfterSeconds: expect.any(Number) },
      });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // the count of an email comes after the captcha (the count of an address comes before it): the
      // refused request has been through Cloudflare
      expect(calls).toHaveLength(2);

      clock = moveClock(181_000);
      expect((await register(email)).statusCode).toBe(201);
    });

    it('sends no second mail for the refused registration, and leaves the account as it was', async () => {
      const email = unique('reg-mail');
      const mails = watchMail();

      expect((await register(email)).statusCode).toBe(201);
      const link = mails.length;
      const refused = await post(
        '/api/auth/register',
        withCaptcha({ email, password: 'another-secret' }),
        nextAddress(),
      );

      expect(refused.statusCode).toBe(429);
      expect(mails).toHaveLength(link);
      // the first password is still the one of the account (the refused request did not take it)
      const row = await asAdmin((tx) =>
        tx.user.findUnique({ where: { email }, select: { id: true, passwordHash: true } }),
      );
      userIds.push(row!.id);
      expect(await bcrypt.compare('secret-pass', row!.passwordHash!)).toBe(true);
    });

    it('counts the ways to write one mailbox as one: a +tag, the dots of Gmail', async () => {
      const name = unique('reg-box').split('@')[0]!.replaceAll('-', '');
      const limited = { errorCode: 'RATE_LIMITED', details: { limit: 'register' } };

      expect((await register(`${name}+a@shop.example.com`)).statusCode).toBe(201);
      const tagged = await register(`${name}+b@shop.example.com`);
      expect(tagged.statusCode).toBe(429);
      expect(tagged.json()).toMatchObject(limited);

      expect((await register(`${name}@gmail.com`)).statusCode).toBe(201);
      const dotted = await register(`${name.slice(0, 5)}.${name.slice(5)}@googlemail.com`);
      expect(dotted.statusCode).toBe(429);
      expect(dotted.json()).toMatchObject(limited);

      // the same name on another domain is another mailbox
      expect((await register(`${name}@shop.example.net`)).statusCode).toBe(201);
    });

    // a script without a captcha must not be able to use up the one registration a person may make
    // in 3 minutes: a request that fails the captcha spends no count of the email
    it('does not spend the count of an email on a request whose captcha fails', async () => {
      const email = unique('reg-captcha');

      failCaptcha();
      const failed = await register(email);
      const failedAgain = await register(email);
      resetTurnstile();

      expect(failed.statusCode).toBe(400);
      expect(failed.json()).toMatchObject({ errorCode: 'CAPTCHA_INVALID' });
      expect(failedAgain.statusCode).toBe(400);
      expect((await register(email)).statusCode).toBe(201);
      expect((await register(email)).statusCode).toBe(429);
    });

    // The count of an email is spent by a registration that succeeds. A request the service refuses after
    // the captcha (the account is there, the password is short) leaves it as it was, so the person
    // corrects the form and sends it again at once
    it('does not spend the count of an email on a registration that is refused', async () => {
      const taken = await createUser();
      userIds.push(taken.id);

      for (let i = 0; i < 3; i += 1) {
        const refused = await register(taken.email);
        expect(refused.statusCode).toBe(409);
        expect(refused.json()).toMatchObject({ errorCode: 'EMAIL_ALREADY_IN_USE' });
      }

      const email = unique('reg-short');
      const short = await post(
        '/api/auth/register',
        withCaptcha({ email, password: '   abc   ' }),
        nextAddress(),
      );
      expect(short.statusCode).toBe(400);
      expect(short.json()).toMatchObject({ errorCode: 'PASSWORD_TOO_SHORT' });

      // the corrected form goes through, and this one is what is counted
      expect((await register(email)).statusCode).toBe(201);
      const again = await register(email);
      expect(again.statusCode).toBe(429);
      expect(again.json()).toMatchObject({
        errorCode: 'RATE_LIMITED',
        details: { limit: 'register' },
      });
    });

    it('does not spend the count of an email on a mail that did not go, and sends the mail on the next try', async () => {
      const email = unique('reg-mail-fail');

      refuseMail('orders');
      const failed = await register(email);
      resetSendGrid();
      const calls = watchMail();

      expect(failed.statusCode).toBe(502);
      expect(failed.json()).toMatchObject({ errorCode: 'VERIFY_EMAIL_SEND_FAILED' });
      expect(
        takeLogs({ msg: 'request failed', errorCode: 'VERIFY_EMAIL_SEND_FAILED' }),
      ).toHaveLength(1);

      // the account is made but unverified: registering again takes it and mails the new link
      expect((await register(email)).statusCode).toBe(201);
      expect(calls.filter((mail) => mail.to[0] === email)).toHaveLength(1);
      expect((await register(email)).statusCode).toBe(429);
    });

    it('lets one of two registrations of an email at the same time through', async () => {
      const email = unique('reg-both');
      const calls = watchMail();

      const answers = await Promise.all([register(email), register(email)]);
      const statuses = answers.map((res) => res.statusCode).sort();

      expect(statuses).toEqual([201, 429]);
      // one mail to the mailbox, not two
      expect(calls.filter((mail) => mail.to[0] === email)).toHaveLength(1);
    });

    it('counts a request whose captcha fails against its address', async () => {
      const from = nextAddress();
      failCaptcha();
      for (let i = 0; i < 10; i += 1) {
        expect((await register(unique(`reg-bad${i}`), from)).statusCode).toBe(400);
      }
      const calls = watchCaptcha();

      const refused = await register(unique('reg-bad-last'), from);
      resetTurnstile();

      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ details: { limit: 'register' } });
      expect(calls).toHaveLength(0);
    });

    // the registration has a count of its own: a person who registers and asks for the mail again, or
    // who finds the account is there and asks for a new password, is not refused for the mails
    it.each(['/api/auth/verify/resend', '/api/auth/password/forgot'])(
      'is apart from the mails of %s',
      async (url) => {
        const email = unique('reg-apart');

        expect((await register(email)).statusCode).toBe(201);
        expect((await post(url, withCaptcha({ email }), nextAddress())).statusCode).toBe(200);

        // and the mail does not use up the registration either
        const other = unique('reg-apart2');
        expect((await post(url, withCaptcha({ email: other }), nextAddress())).statusCode).toBe(
          200,
        );
        expect((await register(other)).statusCode).toBe(201);
      },
    );

    it('follows the limit the setting names', async () => {
      const before = env.LIMIT_REGISTER_PER_EMAIL;
      expect(before).toBe(1);
      env.LIMIT_REGISTER_PER_EMAIL = 2;
      const email = unique('reg-setting');

      try {
        expect((await register(email)).statusCode).toBe(201);
        expect((await register(email)).statusCode).toBe(201);
        expect((await register(email)).statusCode).toBe(429);
      } finally {
        env.LIMIT_REGISTER_PER_EMAIL = before;
      }
    });
  });
});

describe.each(['/api/auth/password/forgot', '/api/auth/verify/resend'])('POST %s', (url) => {
  // a script would empty the mail plan with one address: one mail to an address in 3 minutes,
  // the same answer for an address with an account or without one
  it('sends one mail to an address in 3 minutes', async () => {
    const email = unique('mail');
    const calls = watchCaptcha();

    expect((await post(url, withCaptcha({ email }), nextAddress())).statusCode).toBe(200);
    const refused = await post(url, withCaptcha({ email }), nextAddress());

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ errorCode: 'RATE_LIMITED', details: { limit: 'mail' } });
    // the limit of an email comes after the captcha (the limit of an address comes before it): the
    // refused request has been through Cloudflare
    expect(calls).toHaveLength(2);

    clock = moveClock(181_000);
    expect((await post(url, withCaptcha({ email }), nextAddress())).statusCode).toBe(200);
  });

  // the mailbox is what is mailed: a +tag, and the dots of a Gmail name, write the same one another way
  it('counts the ways to write one mailbox as one mail: a +tag, the dots of Gmail', async () => {
    const name = unique('mailbox').split('@')[0]!.replaceAll('-', '');
    const ask = (email: string) => post(url, withCaptcha({ email }), nextAddress());
    const limited = { errorCode: 'RATE_LIMITED', details: { limit: 'mail' } };

    expect((await ask(`${name}+a@shop.example.com`)).statusCode).toBe(200);
    const tagged = await ask(`${name}+b@shop.example.com`);
    expect(tagged.statusCode).toBe(429);
    expect(tagged.json()).toMatchObject(limited);

    expect((await ask(`${name}@gmail.com`)).statusCode).toBe(200);
    const dotted = await ask(`${name.slice(0, 5)}.${name.slice(5)}@googlemail.com`);
    expect(dotted.statusCode).toBe(429);
    expect(dotted.json()).toMatchObject(limited);

    // the same name on another domain is another mailbox
    expect((await ask(`${name}@shop.example.net`)).statusCode).toBe(200);
  });

  // a script without a captcha must not be able to use up the one mail a person may ask for in 3
  // minutes: a request that fails the captcha spends no count of the email
  it('does not spend the count of an email on a request whose captcha fails', async () => {
    const email = unique('mail-captcha');

    failCaptcha();
    const failed = await post(url, withCaptcha({ email }), nextAddress());
    const failedAgain = await post(url, withCaptcha({ email }), nextAddress());
    resetTurnstile();

    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toMatchObject({ errorCode: 'CAPTCHA_INVALID' });
    expect(failedAgain.statusCode).toBe(400);
    expect((await post(url, withCaptcha({ email }), nextAddress())).statusCode).toBe(200);
    expect((await post(url, withCaptcha({ email }), nextAddress())).statusCode).toBe(429);
  });

  // the count of an address stays in front of the captcha: a script cannot make Cloudflare answer
  // for it without end
  it('counts a request whose captcha fails against its address', async () => {
    const from = nextAddress();
    failCaptcha();

    for (let i = 0; i < 10; i += 1) {
      const res = await post(url, withCaptcha({ email: unique(`mail-bad${i}`) }), from);
      expect(res.statusCode).toBe(400);
    }
    const calls = watchCaptcha();
    const refused = await post(url, withCaptcha({ email: unique('mail-bad-last') }), from);
    resetTurnstile();

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ errorCode: 'RATE_LIMITED', details: { limit: 'mail' } });
    expect(calls).toHaveLength(0);
  });

  it('refuses the 11th mail from one address in 15 minutes', async () => {
    const from = nextAddress();
    for (let i = 0; i < 10; i += 1) {
      expect((await post(url, withCaptcha({ email: unique(`mail${i}`) }), from)).statusCode).toBe(200);
    }

    const refused = await post(url, withCaptcha({ email: unique('mail-last') }), from);

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ errorCode: 'RATE_LIMITED', details: { limit: 'mail' } });
  });
});

describe('POST /api/products/:productId/reviews', () => {
  // a refused comment writes nothing and can come again, each one asks the model of openai
  it('refuses the 31st review of a user in an hour', async () => {
    const user: TestUser = await createUser();
    userIds.push(user.id);
    const review = () =>
      post('/api/products/2147483000/reviews', { rating: 4 }, nextAddress(), accessCookie(user));
    for (let i = 0; i < 30; i += 1) expect((await review()).statusCode).toBe(404);

    const refused = await review();

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      errorCode: 'RATE_LIMITED',
      details: { limit: 'review' },
    });
  });

  // a shop sets the most of each limit (LIMIT_*); the server reads it on each request
  it('refuses the review past the limit the setting names', async () => {
    const user: TestUser = await createUser();
    userIds.push(user.id);
    const before = env.LIMIT_REVIEW_PER_USER;
    env.LIMIT_REVIEW_PER_USER = 2;

    try {
      const review = () =>
        post('/api/products/2147483000/reviews', { rating: 4 }, nextAddress(), accessCookie(user));
      for (let i = 0; i < 2; i += 1) expect((await review()).statusCode).toBe(404);

      expect((await review()).statusCode).toBe(429);
    } finally {
      env.LIMIT_REVIEW_PER_USER = before;
    }
  });
});

describe('POST /api/payments/checkout/sessions', () => {
  // a page is opened at the provider: a script would open them by the hundred
  it('refuses the 11th payment page of a user in a minute', async () => {
    const user: TestUser = await createUser();
    userIds.push(user.id);
    for (let i = 0; i < 10; i += 1) {
      const res = await post(
        '/api/payments/checkout/sessions',
        { orderId: 2_147_483_000, provider: 'stripe' },
        nextAddress(),
        accessCookie(user),
      );
      expect(res.statusCode).toBe(404);
    }

    const refused = await post(
      '/api/payments/checkout/sessions',
      { orderId: 2_147_483_000, provider: 'stripe' },
      nextAddress(),
      accessCookie(user),
    );

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      errorCode: 'RATE_LIMITED',
      details: { limit: 'checkout' },
    });
  });
});
