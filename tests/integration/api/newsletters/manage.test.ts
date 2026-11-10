import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { createUser, uniqueEmail } from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import {
  breakSpamReportClearing,
  mailedToken,
  watchNewsletterMail,
  watchSpamReportClearing,
} from '../../../helpers/mail.js';
import {
  BASE,
  CONFIRM_PAGE,
  MANAGE_PAGE,
  SUBSCRIPTIONS,
  arrange,
  errorAnswer,
  forget,
  journalOf,
  liveRowOf,
  newsletterApi,
  passTheDay,
  rowsOf,
} from '../../../helpers/newsletterApi.js';
import type { SubscriptionOpts } from '../../../helpers/newsletterDb.js';
import { withCaptcha } from '../../../helpers/turnstile.js';

// The page "Manage the subscription" of the frontend, behind the link of every mail to a
// subscriber. The token is always in the body of the request (never in an address, so no log holds
// it), the action is a button, and a token that opens nothing (nobody was given it, or its
// subscription is gone) gets one and the same refusal

let app: FastifyInstance;
let csrf: Csrf;
let api: ReturnType<typeof newsletterApi>;
const emails: string[] = [];

const MANAGE = `${BASE}/manage`;

// the subscription of a guest made the way a person makes one: the request, the link of the
// confirmation, then a second request a day later whose mail "you are already subscribed" carries
// the link of management
async function viaTheForm(locale = 'uk') {
  const email = uniqueEmail('manage');
  emails.push(email);
  const mails = watchNewsletterMail();

  await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale }), {
    from: '198.51.100.60',
    userAgent: 'form-browser/9',
  });
  await api.post(`${SUBSCRIPTIONS}/confirm`, { token: mailedToken(mails, CONFIRM_PAGE) });
  await passTheDay(email);
  await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'en' }));

  return { email, token: mailedToken(mails, MANAGE_PAGE) };
}

const state = (token: string) => api.post(MANAGE, { token });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  api = newsletterApi(app, csrf);
});

afterAll(async () => {
  try {
    await forget(emails);
  } finally {
    await stopApp();
  }
});

describe('POST /api/newsletters/manage', () => {
  it('shows the subscription behind the link of a mail', async () => {
    const { email, token } = await viaTheForm('es');

    const res = await state(token);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      email,
      source: 'form',
      locale: 'es',
      status: 'active',
      canChangeLocale: true,
    });
  });

  it.each<[string, SubscriptionOpts, boolean, string]>([
    ['of an account', { source: 'account' }, false, 'active'],
    ['paused by a complaint', { status: 'paused_complaint' }, true, 'paused_complaint'],
    ['with no language', { locale: null }, true, 'active'],
  ])('shows a subscription %s', async (_case, opts, canChangeLocale, status) => {
    const user = opts.source === 'account' ? await createUser() : undefined;
    const row = await arrange({
      ...opts,
      ...(user ? { userId: user.id } : {}),
    });
    emails.push(row.email);

    const res = await state(row.manageToken);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ email: row.email, status, canChangeLocale });
  });

  it('works for a guest and for a signed-in user', async () => {
    const { token } = await viaTheForm();
    const user = await createUser();

    const asUser = await api.post(MANAGE, { token }, { cookie: accessCookie(user) });

    expect(asUser.statusCode).toBe(200);
  });

  // one refusal for a token nobody was given and for the token of a subscription that is gone, so
  // the page tells nothing about which links ever existed
  it('refuses every token that opens nothing with one and the same answer', async () => {
    const pending = await arrange({ status: 'pending' });
    const ended = await arrange({ status: 'ended' });
    const stopped = await arrange({ status: 'stopped_bounce' });
    emails.push(pending.email, ended.email, stopped.email);

    const answers = [];
    for (const token of [
      'a-token-nobody-was-given',
      pending.manageToken,
      ended.manageToken,
      stopped.manageToken,
    ]) {
      answers.push(errorAnswer(await state(token)));
    }

    expect(answers[0]).toMatchObject({ status: 400, errorCode: 'NEWSLETTER_LINK_INVALID' });
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
  });

  it('takes the token from the body only', async () => {
    const { token } = await viaTheForm();

    const inQuery = await api.post(`${MANAGE}?token=${encodeURIComponent(token)}`, undefined);
    const inPath = await app.inject({ method: 'GET', url: `${MANAGE}/${token}` });

    expect(inQuery.statusCode).toBe(400);
    expect(inQuery.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    expect(inPath.statusCode).toBe(404);
  });

  it('is refused without the csrf token', async () => {
    const { token } = await viaTheForm();

    const res = await app.inject({ method: 'POST', url: MANAGE, payload: { token } });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
  });
});

describe('POST /api/newsletters/manage/locale', () => {
  const LOCALE = `${MANAGE}/locale`;

  it('changes the language of a subscription of the form and shows the new state', async () => {
    const { email, token } = await viaTheForm('es');

    const res = await api.post(
      LOCALE,
      { token, locale: 'uk' },
      { from: '198.51.100.31', userAgent: 'manage-browser/1' },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      email,
      source: 'form',
      locale: 'uk',
      status: 'active',
      canChangeLocale: true,
    });
    expect((await liveRowOf(email))?.locale).toBe('uk');
    expect((await journalOf(email)).at(-1)).toMatchObject({
      event: 'locale_changed',
      place: 'manage_page',
      ip: '198.51.100.31',
      userAgent: 'manage-browser/1',
      locale: 'uk',
    });
  });

  it('writes nothing when the language is the one the subscription has', async () => {
    const { email, token } = await viaTheForm('es');
    const before = (await journalOf(email)).length;

    const res = await api.post(LOCALE, { token, locale: 'es' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ locale: 'es' });
    expect(await journalOf(email)).toHaveLength(before);
  });

  it('reads a language with a region as the one it names', async () => {
    const { email, token } = await viaTheForm('es');

    await api.post(LOCALE, { token, locale: 'UK-ua' });

    expect((await liveRowOf(email))?.locale).toBe('uk');
  });

  it.each([
    ['a language the shop does not answer in', 'fr'],
    ['a language of the wrong shape', 'e1'],
    ['an empty language', ''],
  ])('refuses %s with LOCALE_INVALID and changes nothing', async (_case, locale) => {
    const { email, token } = await viaTheForm('es');

    const res = await api.post(LOCALE, { token, locale });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'LOCALE_INVALID' });
    expect((await liveRowOf(email))?.locale).toBe('es');
  });

  it('refuses a language over 35 characters and a body without one', async () => {
    const { token } = await viaTheForm();

    for (const body of [{ token, locale: 'e'.repeat(36) }, { token }]) {
      const res = await api.post(LOCALE, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
  });

  it('leaves the language of the subscription of an account to the profile', async () => {
    const user = await createUser();
    const row = await arrange({ source: 'account', userId: user.id, locale: 'en' });
    emails.push(row.email);

    const res = await api.post(LOCALE, { token: row.manageToken, locale: 'uk' });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LOCALE_NOT_ALLOWED' });
    expect((await liveRowOf(row.email))?.locale).toBe('en');
  });

  it('refuses a token that opens nothing', async () => {
    const res = await api.post(LOCALE, { token: 'a-token-nobody-was-given', locale: 'uk' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
  });
});

describe('POST /api/newsletters/manage/unsubscribe', () => {
  const UNSUBSCRIBE = `${MANAGE}/unsubscribe`;

  it('ends the subscription at once, and the link stops opening the page', async () => {
    const { email, token } = await viaTheForm();

    const res = await api.post(
      UNSUBSCRIBE,
      { token },
      { from: '198.51.100.41', userAgent: 'manage-browser/2' },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unsubscribed: true });
    expect(await liveRowOf(email)).toBeNull();
    expect((await rowsOf(email))[0]).toMatchObject({ status: 'ended', endReason: 'unsubscribed' });
    expect((await journalOf(email)).at(-1)).toMatchObject({
      event: 'unsubscribed',
      place: 'manage_page',
      ip: '198.51.100.41',
      userAgent: 'manage-browser/2',
      campaignId: null,
    });

    const page = await state(token);
    expect(page.statusCode).toBe(400);
    expect(page.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
  });

  it('is harmless a second time: the answer is the same and nothing more is written', async () => {
    const { email, token } = await viaTheForm();
    await api.post(UNSUBSCRIBE, { token });
    const lines = (await journalOf(email)).length;

    const again = await api.post(UNSUBSCRIBE, { token });

    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ unsubscribed: true });
    expect(await journalOf(email)).toHaveLength(lines);
  });

  it('ends a subscription of an account and one paused by a complaint', async () => {
    const user = await createUser();
    const account = await arrange({ source: 'account', userId: user.id });
    const paused = await arrange({ status: 'paused_complaint' });
    emails.push(account.email, paused.email);

    for (const row of [account, paused]) {
      const res = await api.post(UNSUBSCRIBE, { token: row.manageToken });
      expect(res.statusCode).toBe(200);
      expect((await rowsOf(row.email))[0]).toMatchObject({ status: 'ended' });
    }
  });

  it('lets the address be asked about anew, with a new confirmation', async () => {
    const { email, token } = await viaTheForm();
    await api.post(UNSUBSCRIBE, { token });
    const mails = watchNewsletterMail();

    await api.post(SUBSCRIPTIONS, withCaptcha({ email, locale: 'uk' }));

    expect(mails).toHaveLength(1);
    expect((await liveRowOf(email))?.status).toBe('pending');
  });

  it('refuses a token nobody was given', async () => {
    const res = await api.post(UNSUBSCRIBE, { token: 'a-token-nobody-was-given' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
  });
});

describe('POST /api/newsletters/manage/resume', () => {
  const RESUME = `${MANAGE}/resume`;

  it('puts a subscription a complaint paused back in force and takes the address off the list of complaints', async () => {
    const row = await arrange({ status: 'paused_complaint', locale: 'es' });
    emails.push(row.email);
    const cleared = watchSpamReportClearing();

    const res = await api.post(
      RESUME,
      { token: row.manageToken },
      { from: '198.51.100.51', userAgent: 'manage-browser/3' },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      email: row.email,
      source: 'form',
      locale: 'es',
      status: 'active',
      canChangeLocale: true,
    });
    expect(cleared).toEqual([{ email: row.email, stream: 'newsletter', status: 204 }]);
    expect((await journalOf(row.email)).at(-1)).toMatchObject({
      event: 'restored',
      place: 'manage_page',
      ip: '198.51.100.51',
    });
  });

  it('touches nothing in a subscription that is in force already', async () => {
    const { email, token } = await viaTheForm();
    const cleared = watchSpamReportClearing();
    const lines = (await journalOf(email)).length;

    const res = await api.post(RESUME, { token });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'active' });
    expect(cleared).toEqual([]);
    expect(await journalOf(email)).toHaveLength(lines);
  });

  it.each([
    ['SendGrid refuses the removal', 'refused'],
    ['SendGrid cannot be reached', 'unreachable'],
  ] as const)(
    'still resumes when %s, and only logs it, without the address',
    async (_case, how) => {
      const row = await arrange({ status: 'paused_complaint' });
      emails.push(row.email);
      breakSpamReportClearing(how);

      const res = await api.post(RESUME, { token: row.manageToken });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'active' });
      expect((await liveRowOf(row.email))?.status).toBe('active');

      const logged = takeLogs({ msg: 'spam report of the newsletter account was not cleared' });
      expect(logged).toHaveLength(1);
      expect(JSON.stringify(logged)).not.toContain(row.email);
    },
  );

  it('refuses a token that opens nothing and removes nothing from the list', async () => {
    const cleared = watchSpamReportClearing();

    const res = await api.post(RESUME, { token: 'a-token-nobody-was-given' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
    expect(cleared).toEqual([]);
  });
});

describe('POST /api/newsletters/manage/export', () => {
  const EXPORT = `${MANAGE}/export`;

  it('gives the data of the subscription and its journal, and no secret of the server', async () => {
    const { email, token } = await viaTheForm('es');
    const row = (await rowsOf(email))[0]!;

    const res = await api.post(EXPORT, { token }, { from: '198.51.100.61' });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data).toEqual({
      subscriptions: [
        {
          email,
          source: 'form',
          locale: 'es',
          status: 'active',
          createdAt: expect.stringMatching(/Z$/),
          confirmedAt: expect.stringMatching(/Z$/),
          endedAt: null,
          endReason: null,
          events: [
            expect.objectContaining({ event: 'requested', place: 'form', locale: 'es' }),
            expect.objectContaining({ event: 'confirmed', place: 'form' }),
          ],
        },
      ],
    });
    expect(data.subscriptions[0].events[0]).toEqual({
      event: 'requested',
      place: 'form',
      ip: '198.51.100.60',
      userAgent: 'form-browser/9',
      locale: 'es',
      campaignId: null,
      privacyVersion: null,
      createdAt: expect.stringMatching(/Z$/),
    });

    // what the server keeps to find or to guess a link is no part of the data of the person
    for (const secret of [row.manageSalt, row.manageHash, row.emailHmac!, token]) {
      expect(res.body).not.toContain(secret);
    }
  });

  it('refuses a token that opens nothing', async () => {
    const res = await api.post(EXPORT, { token: 'a-token-nobody-was-given' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LINK_INVALID' });
  });
});

describe('the routes of the page of management', () => {
  it.each(['/locale', '/unsubscribe', '/resume', '/export', ''])(
    'POST %s is refused without the csrf token',
    async (path) => {
      const res = await app.inject({
        method: 'POST',
        url: `${MANAGE}${path}`,
        payload: { token: 'a-token-nobody-was-given', locale: 'uk' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
    },
  );
});
