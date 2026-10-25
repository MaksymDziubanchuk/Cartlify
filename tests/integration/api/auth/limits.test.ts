import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import { moveClock } from '../../../helpers/payments.js';

// the limits of the routes a script would abuse: the login, the registration, the mails of a
// password reset and of a verification, the payment page. The server sits behind the proxy of
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
    for (let i = 0; i < 10; i += 1) {
      const res = await post('/api/auth/register', { email: unique(`reg${i}`), password: 'secret-pass' }, from);
      expect(res.statusCode).toBe(201);
    }

    const refused = await post(
      '/api/auth/register',
      { email: unique('reg-last'), password: 'secret-pass' },
      from,
    );

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      errorCode: 'RATE_LIMITED',
      details: { limit: 'register' },
    });
  });
});

describe.each(['/api/auth/password/forgot', '/api/auth/verify/resend'])('POST %s', (url) => {
  // a script would empty the mail plan with one address: one mail to an address in 3 minutes,
  // the same answer for an address with an account or without one
  it('sends one mail to an address in 3 minutes', async () => {
    const email = unique('mail');

    expect((await post(url, { email }, nextAddress())).statusCode).toBe(200);
    const refused = await post(url, { email }, nextAddress());

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ errorCode: 'RATE_LIMITED', details: { limit: 'mail' } });

    clock = moveClock(181_000);
    expect((await post(url, { email }, nextAddress())).statusCode).toBe(200);
  });

  it('refuses the 11th mail from one address in 15 minutes', async () => {
    const from = nextAddress();
    for (let i = 0; i < 10; i += 1) {
      expect((await post(url, { email: unique(`mail${i}`) }, from)).statusCode).toBe(200);
    }

    const refused = await post(url, { email: unique('mail-last') }, from);

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ errorCode: 'RATE_LIMITED', details: { limit: 'mail' } });
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
