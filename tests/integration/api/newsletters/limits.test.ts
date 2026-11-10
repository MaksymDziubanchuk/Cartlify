import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { createUser, uniqueEmail } from '../../../helpers/factories.js';
import { watchNewsletterMail } from '../../../helpers/mail.js';
import { BASE, SUBSCRIPTIONS, forget, newsletterApi } from '../../../helpers/newsletterApi.js';
import {
  failCaptcha,
  resetTurnstile,
  watchCaptcha,
  withCaptcha,
} from '../../../helpers/turnstile.js';

// The limits of the public routes of the newsletters, as the server has them (the other files of the
// integration tests raise every limit a thousand times). The form that mails anybody counts the
// requests of an address (before the captcha) and of an email (after it) like the other forms that
// send a mail; the pages behind a link count the requests of an address together (60 in 10 minutes
// unless LIMIT_NEWSLETTER_LINK_PER_ADDRESS names another number); the unsubscribe button of the
// mails (the one-click POST and the GET of its link) counts apart
// (LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS, 1000 in 10 minutes)

let app: FastifyInstance;
let csrf: Csrf;
let api: ReturnType<typeof newsletterApi>;
const emails: string[] = [];
const scale = env.REQUEST_LIMITS_SCALE;
let addresses = 0;

// an address of the documentation range (rfc 5737), a new one for each call
const nextAddress = () => `203.0.113.${(addresses += 1)}`;

const fresh = () => {
  const email = uniqueEmail('limit');
  emails.push(email);
  return email;
};

const ask = (email: string, from: string) =>
  api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }), { from });

beforeAll(async () => {
  env.REQUEST_LIMITS_SCALE = 1;
  app = await startApp();
  csrf = await getCsrf(app);
  api = newsletterApi(app, csrf);
});

afterAll(async () => {
  try {
    await forget(emails);
  } finally {
    env.REQUEST_LIMITS_SCALE = scale;
    await stopApp();
  }
});

describe('POST /api/newsletters/subscriptions', () => {
  it('refuses the 11th request from one address in 15 minutes, with no call to the captcha', async () => {
    const from = nextAddress();
    for (let i = 0; i < 10; i += 1) {
      expect((await ask(fresh(), from)).statusCode).toBe(202);
    }
    const calls = watchCaptcha();
    const mails = watchNewsletterMail();
    const email = fresh();

    const refused = await ask(email, from);

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      errorCode: 'RATE_LIMITED',
      details: { limit: 'newsletterRequest' },
    });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });

  it('refuses a second request for one email within 3 minutes, from any address', async () => {
    const email = fresh();
    const first = await ask(email, nextAddress());
    const mails = watchNewsletterMail();

    const second = await ask(email, nextAddress());
    const other = await ask(fresh(), nextAddress());

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({
      errorCode: 'RATE_LIMITED',
      details: { limit: 'newsletterRequest' },
    });
    expect(other.statusCode).toBe(202);
    expect(mails).toHaveLength(1);
  });

  // The count of an email comes after the captcha. Before it, a script without one could ask once for
  // the address of a person and the request of the person, 3 minutes long, would be refused.
  it('does not spend the count of an email on a request whose captcha fails', async () => {
    const email = fresh();

    failCaptcha();
    const failed = await ask(email, nextAddress());
    const failedAgain = await ask(email, nextAddress());
    resetTurnstile();

    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toMatchObject({ errorCode: 'CAPTCHA_INVALID' });
    expect(failedAgain.statusCode).toBe(400);
    expect((await ask(email, nextAddress())).statusCode).toBe(202);
    expect((await ask(email, nextAddress())).statusCode).toBe(429);
  });

  // The count of an address stays in front of the captcha: a script cannot make Cloudflare answer for
  // it without end, and a captcha that fails still counts for the address
  it('counts a request whose captcha fails against its address', async () => {
    const from = nextAddress();
    failCaptcha();
    for (let i = 0; i < 10; i += 1) {
      expect((await ask(fresh(), from)).statusCode).toBe(400);
    }
    const calls = watchCaptcha();

    const refused = await ask(fresh(), from);
    resetTurnstile();

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ details: { limit: 'newsletterRequest' } });
    expect(calls).toHaveLength(0);
  });

  // the cheap checks come first: a request refused for its shape costs no count and no call
  it('spends no count of an email on a request refused before the captcha', async () => {
    const email = fresh();
    const calls = watchCaptcha();

    const noLocale = await api.post(SUBSCRIPTIONS, withCaptcha({ email }), { from: nextAddress() });

    expect(noLocale.statusCode).toBe(400);
    expect(noLocale.json()).toMatchObject({ errorCode: 'LOCALE_INVALID' });
    expect(calls).toHaveLength(0);
    expect((await ask(email, nextAddress())).statusCode).toBe(202);
  });

  it('counts an email in any case as one', async () => {
    const email = fresh();
    await ask(email, nextAddress());

    const second = await ask(email.toUpperCase(), nextAddress());

    expect(second.statusCode).toBe(429);
  });

  // the mailbox is what is mailed, so the count is of the mailbox, the way the blocklist knows it: a
  // +tag, and the dots of a Gmail name, write the same one another way
  it('counts the ways to write one mailbox as one: a +tag, the dots of Gmail, googlemail', async () => {
    const name = fresh().split('@')[0]!.replaceAll('-', '');
    const mailbox = `${name}@gmail.com`;
    const variants = [
      `${name}+sale@example.net`,
      `${name.slice(0, 4)}.${name.slice(4)}@gmail.com`,
      `${name}+one@googlemail.com`,
      `${name.toUpperCase()}+TWO@GMAIL.COM`,
    ];
    emails.push(mailbox, ...variants);

    expect((await ask(mailbox, nextAddress())).statusCode).toBe(202);
    const mails = watchNewsletterMail();
    const refused = [];
    for (const variant of variants.slice(1)) refused.push(await ask(variant, nextAddress()));

    for (const res of refused) {
      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({ details: { limit: 'newsletterRequest' } });
    }
    expect(mails).toHaveLength(0);
  });

  it('counts a +tag as the same mailbox on any domain, and apart from the mailbox of the other name', async () => {
    const name = fresh().split('@')[0]!;
    const other = fresh();
    emails.push(`${name}+a@example.org`, `${name}+b@example.org`);

    expect((await ask(`${name}+a@example.org`, nextAddress())).statusCode).toBe(202);

    expect((await ask(`${name}+b@example.org`, nextAddress())).statusCode).toBe(429);
    // the same name on another domain is another mailbox, and so is another name
    expect((await ask(`${name}@example.net`, nextAddress())).statusCode).toBe(202);
    emails.push(`${name}@example.net`);
    expect((await ask(other, nextAddress())).statusCode).toBe(202);
  });

  // a signed-in user who subscribes their own address names none, and the others who do the same
  // must not share a count; and what is not mailed counts nothing
  it('does not count the requests of signed-in users for their own address together', async () => {
    for (let i = 0; i < 3; i += 1) {
      const user = await createUser();
      emails.push(user.email);

      const res = await api.post(
        SUBSCRIPTIONS,
        {},
        { cookie: accessCookie(user), from: nextAddress() },
      );

      expect(res.statusCode).toBe(201);
    }
  });

  it('counts a signed-in user about another address like a guest, after the captcha', async () => {
    const user = await createUser();
    emails.push(user.email);
    const email = fresh();
    const cookie = accessCookie(user);

    failCaptcha();
    const failed = await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }), {
      cookie,
      from: nextAddress(),
    });
    resetTurnstile();

    expect(failed.statusCode).toBe(400);
    expect(failed.json()).toMatchObject({ errorCode: 'CAPTCHA_INVALID' });
    const first = await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }), {
      cookie,
      from: nextAddress(),
    });
    const second = await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }), {
      cookie,
      from: nextAddress(),
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(429);
  });
});

describe('the pages behind the links of the mails', () => {
  const pages = [
    ['confirm', `${SUBSCRIPTIONS}/confirm`],
    ['decline', `${SUBSCRIPTIONS}/decline`],
    ['manage', `${BASE}/manage`],
    ['manage/locale', `${BASE}/manage/locale`],
    ['manage/unsubscribe', `${BASE}/manage/unsubscribe`],
    ['manage/resume', `${BASE}/manage/resume`],
    ['manage/export', `${BASE}/manage/export`],
  ] as const;

  it('refuse the 61st request from one address in 10 minutes, all of them counted together', async () => {
    expect(env.LIMIT_NEWSLETTER_LINK_PER_ADDRESS).toBe(60);
    const from = nextAddress();

    for (let i = 0; i < 60; i += 1) {
      const [, url] = pages[i % pages.length]!;
      const res = await api.post(
        url,
        { token: 'a-token-nobody-was-given', locale: 'uk' },
        { from },
      );
      expect(res.statusCode).toBe(400);
    }

    const refused = await api.post(
      `${SUBSCRIPTIONS}/confirm`,
      { token: 'a-token-nobody-was-given' },
      { from },
    );
    const other = await api.post(
      `${SUBSCRIPTIONS}/confirm`,
      { token: 'a-token-nobody-was-given' },
      { from: nextAddress() },
    );

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      errorCode: 'RATE_LIMITED',
      details: { limit: 'newsletterLink' },
    });
    expect(other.statusCode).toBe(400);
  });

  it('follow the limit the setting names, and the unsubscribe button does not spend them', async () => {
    const before = env.LIMIT_NEWSLETTER_LINK_PER_ADDRESS;
    env.LIMIT_NEWSLETTER_LINK_PER_ADDRESS = 3;
    const from = nextAddress();

    try {
      // the button of the mails is another count: it does not use up the pages of the same address
      for (let i = 0; i < 5; i += 1) {
        const res = await app.inject({
          method: 'GET',
          url: `${BASE}/unsubscribe/a-token-nobody-was-given`,
          headers: { 'x-forwarded-for': from },
        });
        expect(res.statusCode).toBe(303);
      }
      for (let i = 0; i < 3; i += 1) {
        const res = await api.post(
          `${SUBSCRIPTIONS}/confirm`,
          { token: 'a-token-nobody-was-given' },
          { from },
        );
        expect(res.statusCode).toBe(400);
      }

      const refused = await api.post(
        `${SUBSCRIPTIONS}/confirm`,
        { token: 'a-token-nobody-was-given' },
        { from },
      );

      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({ details: { limit: 'newsletterLink' } });
    } finally {
      env.LIMIT_NEWSLETTER_LINK_PER_ADDRESS = before;
    }
  });
});

// The unsubscribe button of the mails: a mailbox provider unsubscribes many readers from the few
// addresses of its servers (RFC 8058, the rules of Gmail and Yahoo), so its count is wide and its own
describe('the unsubscribe button of the mails', () => {
  const press = (method: 'GET' | 'POST', from: string) =>
    app.inject({
      method,
      url: `${BASE}/unsubscribe/a-token-nobody-was-given`,
      headers: { 'x-forwarded-for': from },
    });

  it('has a count of its own, 1000 in 10 minutes unless the setting names another number', async () => {
    const before = env.LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS;
    expect(before).toBe(1000);
    env.LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS = 4;
    const from = nextAddress();

    try {
      // the one-click POST and the GET of the link are the one button: one count
      expect((await press('POST', from)).statusCode).toBe(400);
      expect((await press('GET', from)).statusCode).toBe(303);
      expect((await press('POST', from)).statusCode).toBe(400);
      expect((await press('GET', from)).statusCode).toBe(303);

      const refusedPost = await press('POST', from);
      const refusedGet = await press('GET', from);
      const other = await press('POST', nextAddress());

      for (const refused of [refusedPost, refusedGet]) {
        expect(refused.statusCode).toBe(429);
        expect(refused.json()).toMatchObject({
          errorCode: 'RATE_LIMITED',
          details: { limit: 'newsletterUnsubscribe' },
        });
        expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      }
      expect(other.statusCode).toBe(400);
    } finally {
      env.LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS = before;
    }
  });

  // The general limit of the API (RATE_LIMIT_MAX a minute from one address) does not count the button:
  // the mail providers that unsubscribe a crowd from a few addresses would meet it long before the
  // count of the button, which is made for them. Only the count of the button holds
  it('is outside the general limit of the API: more requests a minute than it passes, up to its own count', async () => {
    const general = Number(process.env.RATE_LIMIT_MAX);
    expect(general).toBeGreaterThan(0);
    const before = env.LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS;
    env.LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS = general + 5;
    const from = nextAddress();

    try {
      // the GET of the link goes far past the general limit...
      for (let i = 0; i < general + 3; i += 1) {
        const res = await press('GET', from);
        if (res.statusCode !== 303) {
          throw new Error(`press ${i + 1} of ${general + 3}: ${res.statusCode} ${res.body}`);
        }
      }
      // ...and so does the POST of a mail client, which shares the count
      expect((await press('POST', from)).statusCode).toBe(400);
      expect((await press('POST', from)).statusCode).toBe(400);

      // the count of the button is the one that refuses, not the general one
      const refused = await press('GET', from);
      expect(refused.statusCode).toBe(429);
      expect(refused.json()).toMatchObject({
        errorCode: 'RATE_LIMITED',
        details: { limit: 'newsletterUnsubscribe' },
      });
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      // the general limit did not look at the request, so it set none of its headers
      expect(refused.headers['x-ratelimit-limit']).toBeUndefined();
    } finally {
      env.LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS = before;
    }
  }, 60_000);

  it('does not spend the count of the pages behind the links of the mails', async () => {
    const from = nextAddress();

    for (let i = 0; i < 61; i += 1) expect((await press('GET', from)).statusCode).toBe(303);
    const page = await api.post(
      `${SUBSCRIPTIONS}/confirm`,
      { token: 'a-token-nobody-was-given' },
      { from },
    );

    expect(page.statusCode).toBe(400);
  });
});
