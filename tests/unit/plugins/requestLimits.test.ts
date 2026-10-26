import { describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import {
  REQUEST_LIMITS,
  clearLoginFailures,
  recordLoginFailure,
  requestLimits,
} from '../../../src/plugins/requestLimits.js';

import { fakeReply, fakeRequest } from '../../helpers/fakeHttp.js';

// the pause of a login: the last preHandler of the login limits
const loginPause = requestLimits.login.at(-1)!;

// the seconds the login of the email waits at the time, 0 when it does not
async function pauseOf(email: string, now: number): Promise<number> {
  const realNow = Date.now;
  Date.now = () => now;

  try {
    await loginPause(Object.assign(fakeRequest(), { body: { email } }), fakeReply().reply);
    return 0;
  } catch (err) {
    return Number((err as { details: { retryAfterSeconds: number } }).details.retryAfterSeconds);
  } finally {
    Date.now = realNow;
  }
}

const emailOf = (name: string) => `${name}-${Math.random().toString(16).slice(2)}@shop.example.com`;

describe('the limits of the routes', () => {
  it('name the counts the server keeps', () => {
    expect(REQUEST_LIMITS.mailPerEmail).toEqual({ max: 1, windowMs: 180_000 });
    expect(REQUEST_LIMITS.loginPerAddress.max).toBe(30);
  });

  // a shop sets the most requests of each limit (LIMIT_*), the windows stay; read on each request
  it('take the most requests of each limit from its setting', () => {
    const settings = {
      LIMIT_LOGIN_PER_ADDRESS: ['loginPerAddress', 31],
      LIMIT_LOGIN_PER_EMAIL: ['loginPerEmail', 11],
      LIMIT_REGISTER_PER_ADDRESS: ['registerPerAddress', 12],
      LIMIT_MAIL_PER_ADDRESS: ['mailPerAddress', 13],
      LIMIT_MAIL_PER_EMAIL: ['mailPerEmail', 2],
      LIMIT_CHECKOUT_PER_USER: ['checkoutPerUser', 14],
      LIMIT_PASSWORD_CHANGE_PER_USER: ['passwordChangePerUser', 15],
      LIMIT_EXPORT_PER_USER: ['exportPerUser', 3],
      LIMIT_REVIEW_PER_USER: ['reviewPerUser', 40],
    } as const;
    const before = Object.fromEntries(
      Object.keys(settings).map((key) => [key, env[key as keyof typeof settings]]),
    );

    try {
      for (const [key, [, value]] of Object.entries(settings)) {
        env[key as keyof typeof settings] = value;
      }

      for (const [limit, value] of Object.values(settings)) {
        expect(REQUEST_LIMITS[limit].max).toBe(value);
      }
      expect(REQUEST_LIMITS.mailPerEmail.windowMs).toBe(180_000);
    } finally {
      Object.assign(env, before);
    }
  });
});

describe('the pause of a login', () => {
  // a minute after the fifth wrong password, doubling with each next one, never over 15 minutes
  it('grows with each wrong password past the fifth and stops at 15 minutes', async () => {
    const email = emailOf('pause');
    const at = 10_000_000;
    const pauses: number[] = [];

    for (let i = 1; i <= 10; i += 1) {
      recordLoginFailure(email, at + i);
      pauses.push(await pauseOf(email, at + i));
    }

    expect(pauses).toEqual([0, 0, 0, 0, 60, 120, 240, 480, 900, 900]);
  });

  it('is gone with the right password', async () => {
    const email = emailOf('clear');
    for (let i = 0; i < 5; i += 1) recordLoginFailure(email, 20_000_000);

    clearLoginFailures(email);

    expect(await pauseOf(email, 20_000_001)).toBe(0);
  });

  it('takes an email in any case and with spaces as the same account', async () => {
    const email = emailOf('case');
    for (let i = 0; i < 5; i += 1) recordLoginFailure(`  ${email.toUpperCase()} `, 30_000_000);

    expect(await pauseOf(email, 30_000_001)).toBe(60);
  });

  // the email names the account: the wrong passwords of one do not pause another
  it('counts the wrong passwords of each email apart', async () => {
    const email = emailOf('one');
    for (let i = 0; i < 5; i += 1) recordLoginFailure(email, 50_000_000);

    expect(await pauseOf(emailOf('other'), 50_000_001)).toBe(0);
  });

  it('answers a paused login with LOGIN_PAUSED and the seconds to wait in retry-after', async () => {
    const email = emailOf('answer');
    for (let i = 0; i < 5; i += 1) recordLoginFailure(email, 60_000_000);
    const { reply, headers } = fakeReply();
    const realNow = Date.now;
    Date.now = () => 60_000_000;

    try {
      await expect(
        loginPause(Object.assign(fakeRequest(), { body: { email } }), reply),
      ).rejects.toMatchObject({
        statusCode: 429,
        errorCode: 'LOGIN_PAUSED',
        details: { retryAfterSeconds: 60 },
      });
    } finally {
      Date.now = realNow;
    }
    expect(headers['retry-after']).toBe('60');
  });

  it('lets a login without a body through to its schema', async () => {
    await expect(loginPause(fakeRequest(), fakeReply().reply)).resolves.toBeUndefined();
  });

  // the setting multiplies the limits: twice as many wrong passwords before the pause
  it('pauses after more wrong passwords when the limits are scaled', async () => {
    const email = emailOf('scaled');
    const scale = env.REQUEST_LIMITS_SCALE;
    env.REQUEST_LIMITS_SCALE = 2;

    try {
      for (let i = 0; i < 9; i += 1) recordLoginFailure(email, 70_000_000);
      expect(await pauseOf(email, 70_000_001)).toBe(0);

      recordLoginFailure(email, 70_000_000);
      expect(await pauseOf(email, 70_000_001)).toBe(60);
    } finally {
      env.REQUEST_LIMITS_SCALE = scale;
    }
  });

  // a shop sets how many wrong passwords pause the login (LOGIN_FAILURES_BEFORE_PAUSE)
  it('pauses after the wrong passwords the setting names', async () => {
    const email = emailOf('setting');
    const before = env.LOGIN_FAILURES_BEFORE_PAUSE;
    env.LOGIN_FAILURES_BEFORE_PAUSE = 3;

    try {
      for (let i = 0; i < 2; i += 1) recordLoginFailure(email, 90_000_000);
      expect(await pauseOf(email, 90_000_001)).toBe(0);

      recordLoginFailure(email, 90_000_000);
      expect(await pauseOf(email, 90_000_001)).toBe(60);
    } finally {
      env.LOGIN_FAILURES_BEFORE_PAUSE = before;
    }
  });

  it('forgets the wrong passwords exactly an hour after the last one', async () => {
    const email = emailOf('hour');
    for (let i = 0; i < 4; i += 1) recordLoginFailure(email, 80_000_000);

    recordLoginFailure(email, 80_000_000 + 3_600_000);

    expect(await pauseOf(email, 80_000_000 + 3_600_001)).toBe(0);
  });

  // the count is forgotten an hour after the last wrong password
  it('forgets the wrong passwords of an hour ago', async () => {
    const email = emailOf('old');
    for (let i = 0; i < 4; i += 1) recordLoginFailure(email, 40_000_000);

    recordLoginFailure(email, 40_000_000 + 3_600_001);

    expect(await pauseOf(email, 40_000_000 + 3_600_002)).toBe(0);
  });
});
