import type { FastifyReply } from 'fastify';
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

  // a registration of an address that is not verified yet mails a new link each time, so the email of the
  // registration is counted like the email of the other mails (after the captcha) but on its own: a person
  // who registers and asks for the mail again, or who finds the account is there and resets the password,
  // is not refused for the registration
  it('count the registrations of an email apart from the mails of a reset and of a verification', () => {
    expect(REQUEST_LIMITS.registerPerEmail).toEqual({ max: 1, windowMs: 180_000 });
    expect(requestLimits.register).toHaveLength(1);
    expect(requestLimits.registerToEmail).toHaveLength(1);
    expect(requestLimits.registerToEmail[0]).not.toBe(requestLimits.mailToEmail[0]);
    expect(requestLimits.registerToEmail[0]).not.toBe(requestLimits.register[0]);
  });

  // the pages behind the links of the newsletter mails and the unsubscribe button are two counts
  it('keep the pages behind the links of the newsletters and their unsubscribe button apart', () => {
    expect(REQUEST_LIMITS.newsletterLinkPerAddress).toEqual({ max: 60, windowMs: 600_000 });
    expect(REQUEST_LIMITS.newsletterUnsubscribePerAddress).toEqual({
      max: 1000,
      windowMs: 600_000,
    });
    expect(requestLimits.newsletterLink).toHaveLength(1);
    expect(requestLimits.newsletterUnsubscribe).toHaveLength(1);
    expect(requestLimits.newsletterUnsubscribe[0]).not.toBe(requestLimits.newsletterLink[0]);
  });

  // a shop sets the most requests of each limit (LIMIT_*), the windows stay; read on each request
  it('take the most requests of each limit from its setting', () => {
    const settings = {
      LIMIT_LOGIN_PER_ADDRESS: ['loginPerAddress', 31],
      LIMIT_LOGIN_PER_EMAIL: ['loginPerEmail', 11],
      LIMIT_REGISTER_PER_ADDRESS: ['registerPerAddress', 12],
      LIMIT_REGISTER_PER_EMAIL: ['registerPerEmail', 2],
      LIMIT_MAIL_PER_ADDRESS: ['mailPerAddress', 13],
      LIMIT_MAIL_PER_EMAIL: ['mailPerEmail', 2],
      LIMIT_CHECKOUT_PER_USER: ['checkoutPerUser', 14],
      LIMIT_PASSWORD_CHANGE_PER_USER: ['passwordChangePerUser', 15],
      LIMIT_EXPORT_PER_USER: ['exportPerUser', 3],
      LIMIT_REVIEW_PER_USER: ['reviewPerUser', 40],
      LIMIT_NEWSLETTER_LINK_PER_ADDRESS: ['newsletterLinkPerAddress', 61],
      LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS: ['newsletterUnsubscribePerAddress', 1001],
      LIMIT_CHAT_CALL_ADMIN_PER_USER: ['chatCallAdminPerUser', 6],
      LIMIT_WITHDRAWAL_PER_USER: ['withdrawalPerUser', 9],
      LIMIT_WITHDRAWAL_FORM_PER_ADDRESS: ['withdrawalFormPerAddress', 8],
      LIMIT_WITHDRAWAL_FORM_PER_ORDER: ['withdrawalFormPerOrder', 4],
      LIMIT_WITHDRAWAL_FORM_PER_DATA: ['withdrawalFormPerData', 7],
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
      expect(REQUEST_LIMITS.registerPerEmail.windowMs).toBe(180_000);
    } finally {
      Object.assign(env, before);
    }
  });
});

// the button "call an admin" of a chat the bot could not answer: a script would fill the queue of
// the admins, so a user may press it a few times an hour
describe('the limit of the button "call an admin"', () => {
  const [limit, ...rest] = requestLimits.chatCallAdmin;
  const callBy = (id: number) =>
    limit!(Object.assign(fakeRequest(), { user: { id } }), fakeReply().reply);

  it('is one count of a user in a window of an hour', () => {
    expect(rest).toEqual([]);
    expect(REQUEST_LIMITS.chatCallAdminPerUser.windowMs).toBe(3_600_000);
    expect(REQUEST_LIMITS.chatCallAdminPerUser.max).toBe(env.LIMIT_CHAT_CALL_ADMIN_PER_USER);
  });

  it('refuses a user past the setting with RATE_LIMITED naming chatCallAdmin and the seconds to wait', async () => {
    const before = { max: env.LIMIT_CHAT_CALL_ADMIN_PER_USER, scale: env.REQUEST_LIMITS_SCALE };
    env.LIMIT_CHAT_CALL_ADMIN_PER_USER = 2;
    env.REQUEST_LIMITS_SCALE = 1;
    const { reply, headers } = fakeReply();

    try {
      const user = 910_000_001;
      await expect(callBy(user)).resolves.toBeUndefined();
      await expect(callBy(user)).resolves.toBeUndefined();

      await expect(
        limit!(Object.assign(fakeRequest(), { user: { id: user } }), reply),
      ).rejects.toMatchObject({
        statusCode: 429,
        errorCode: 'RATE_LIMITED',
        details: { limit: 'chatCallAdmin', retryAfterSeconds: expect.any(Number) },
      });
      expect(Number(headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(headers['retry-after'])).toBeLessThanOrEqual(3600);

      // another user has a count of their own
      await expect(callBy(910_000_002)).resolves.toBeUndefined();
    } finally {
      env.LIMIT_CHAT_CALL_ADMIN_PER_USER = before.max;
      env.REQUEST_LIMITS_SCALE = before.scale;
    }
  });

  it('multiplies the setting by the scale of the limits', async () => {
    const before = { max: env.LIMIT_CHAT_CALL_ADMIN_PER_USER, scale: env.REQUEST_LIMITS_SCALE };
    env.LIMIT_CHAT_CALL_ADMIN_PER_USER = 1;
    env.REQUEST_LIMITS_SCALE = 3;

    try {
      const user = 910_000_003;
      for (let i = 0; i < 3; i += 1) await expect(callBy(user)).resolves.toBeUndefined();

      await expect(callBy(user)).rejects.toMatchObject({ errorCode: 'RATE_LIMITED' });
    } finally {
      env.LIMIT_CHAT_CALL_ADMIN_PER_USER = before.max;
      env.REQUEST_LIMITS_SCALE = before.scale;
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

// the count of the email of a registration is by mailbox: a +tag, the dots of a Gmail name and
// googlemail.com write one mailbox another way (the way the blocklist of the newsletters folds it)
describe('the limit of the email of a registration', () => {
  const [limit] = requestLimits.registerToEmail;
  const registerWith = (email: unknown) =>
    limit!(Object.assign(fakeRequest(), { body: { email } }), fakeReply().reply);

  it('counts the ways to write one mailbox as one', async () => {
    const before = env.REQUEST_LIMITS_SCALE;
    env.REQUEST_LIMITS_SCALE = 1;
    const name = emailOf('box').split('@')[0]!.replaceAll('-', '');

    try {
      await expect(registerWith(`${name}@gmail.com`)).resolves.toBeUndefined();

      for (const variant of [
        `${name}+sale@gmail.com`,
        `${name.slice(0, 4)}.${name.slice(4)}@gmail.com`,
        `${name.toUpperCase()}@GOOGLEMAIL.COM`,
        `  ${name}@gmail.com  `,
      ]) {
        await expect(registerWith(variant)).rejects.toMatchObject({
          statusCode: 429,
          errorCode: 'RATE_LIMITED',
          details: { limit: 'register', retryAfterSeconds: expect.any(Number) },
        });
      }

      // another name, and the same name on another domain, are other mailboxes
      await expect(registerWith(`${name}x@gmail.com`)).resolves.toBeUndefined();
      await expect(registerWith(`${name}@example.net`)).resolves.toBeUndefined();
    } finally {
      env.REQUEST_LIMITS_SCALE = before;
    }
  });

  // The count is spent by a registration that succeeds, not by a request that is refused after the
  // captcha (a conflict, a missing consent, a short password, a mail that did not go): the request takes
  // its place before it runs, so requests at the same time cannot all pass, and gives it back when it
  // does not end in 201
  describe('counts the registrations that succeed', () => {
    const [limit] = requestLimits.registerToEmail;
    const finish = requestLimits.registerToEmailDone;
    const reqOf = (email: string) => Object.assign(fakeRequest(), { body: { email } });
    const answerOf = (statusCode: number) =>
      Object.assign(fakeReply().reply, { statusCode }) as unknown as FastifyReply;

    const withScaleOne = async (run: () => Promise<void>) => {
      const before = env.REQUEST_LIMITS_SCALE;
      env.REQUEST_LIMITS_SCALE = 1;
      try {
        await run();
      } finally {
        env.REQUEST_LIMITS_SCALE = before;
      }
    };

    it('gives the place back when the registration ends in anything but 201', async () => {
      await withScaleOne(async () => {
        for (const status of [400, 404, 409, 429, 500, 502]) {
          const email = emailOf(`back${status}`);
          const first = reqOf(email);

          await expect(limit!(first, fakeReply().reply)).resolves.toBeUndefined();
          await finish(first, answerOf(status));

          // the corrected form goes through
          const second = reqOf(email);
          await expect(limit!(second, fakeReply().reply)).resolves.toBeUndefined();
          await finish(second, answerOf(201));

          // and the success is what is counted
          await expect(limit!(reqOf(email), fakeReply().reply)).rejects.toMatchObject({
            statusCode: 429,
            errorCode: 'RATE_LIMITED',
            details: { limit: 'register' },
          });
        }
      });
    });

    it('keeps the place of a registration that ends in 201', async () => {
      await withScaleOne(async () => {
        const email = emailOf('kept');
        const first = reqOf(email);
        await limit!(first, fakeReply().reply);
        await finish(first, answerOf(201));

        await expect(limit!(reqOf(email), fakeReply().reply)).rejects.toMatchObject({
          errorCode: 'RATE_LIMITED',
        });
      });
    });

    it('lets one of two requests at the same time through, the other waits for the answer', async () => {
      await withScaleOne(async () => {
        const email = emailOf('both');
        const first = reqOf(email);
        const second = reqOf(email);

        await expect(limit!(first, fakeReply().reply)).resolves.toBeUndefined();
        await expect(limit!(second, fakeReply().reply)).rejects.toMatchObject({
          errorCode: 'RATE_LIMITED',
        });

        // the refused request had no place to give back: the first still holds its own
        await finish(second, answerOf(429));
        await expect(limit!(reqOf(email), fakeReply().reply)).rejects.toMatchObject({
          errorCode: 'RATE_LIMITED',
        });

        // and once the first ends without success the place is free
        await finish(first, answerOf(409));
        await expect(limit!(reqOf(email), fakeReply().reply)).resolves.toBeUndefined();
      });
    });

    it('gives a place back only once', async () => {
      await withScaleOne(async () => {
        const email = emailOf('once');
        const first = reqOf(email);
        await limit!(first, fakeReply().reply);
        await finish(first, answerOf(409));
        await finish(first, answerOf(409));

        // one place free, not two
        await expect(limit!(reqOf(email), fakeReply().reply)).resolves.toBeUndefined();
        await expect(limit!(reqOf(email), fakeReply().reply)).rejects.toMatchObject({
          errorCode: 'RATE_LIMITED',
        });
      });
    });

    it('does not extend the wait with the requests it refuses', async () => {
      await withScaleOne(async () => {
        const email = emailOf('wait');
        const first = reqOf(email);
        await limit!(first, fakeReply().reply);
        await finish(first, answerOf(201));
        const first429 = fakeReply();

        await expect(limit!(reqOf(email), first429.reply)).rejects.toMatchObject({
          errorCode: 'RATE_LIMITED',
        });
        const asked = Number(first429.headers['retry-after']);
        expect(asked).toBeGreaterThan(0);
        expect(asked).toBeLessThanOrEqual(180);
      });
    });
  });

  it('refuses past the setting and tells the seconds to wait', async () => {
    const before = { max: env.LIMIT_REGISTER_PER_EMAIL, scale: env.REQUEST_LIMITS_SCALE };
    env.LIMIT_REGISTER_PER_EMAIL = 2;
    env.REQUEST_LIMITS_SCALE = 1;
    const email = emailOf('twice');
    const { reply, headers } = fakeReply();

    try {
      await expect(registerWith(email)).resolves.toBeUndefined();
      await expect(registerWith(email)).resolves.toBeUndefined();

      await expect(
        limit!(Object.assign(fakeRequest(), { body: { email } }), reply),
      ).rejects.toMatchObject({ errorCode: 'RATE_LIMITED' });
      expect(Number(headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(headers['retry-after'])).toBeLessThanOrEqual(180);
    } finally {
      env.LIMIT_REGISTER_PER_EMAIL = before.max;
      env.REQUEST_LIMITS_SCALE = before.scale;
    }
  });
});
