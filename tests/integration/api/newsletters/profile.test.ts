import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import type { Role } from '@prisma/client';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { createUser, type TestUser } from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { breakSpamReportClearing, watchSpamReportClearing } from '../../../helpers/mail.js';
import {
  BASE,
  SUBSCRIPTIONS,
  arrange,
  forget,
  journalOf,
  liveRowOf,
  newsletterApi,
  rowsOf,
} from '../../../helpers/newsletterApi.js';

// The newsletter part of the profile of a signed-in user (any role): the subscription of their own
// address, whether the account or the form made it. The address is the one of the account, which
// must have been verified: a subscription sits on an address, and whoever registered an address they
// did not prove has no say over what it is subscribed to

let app: FastifyInstance;
let csrf: Csrf;
let api: ReturnType<typeof newsletterApi>;
const emails: string[] = [];

const ME = `${BASE}/me`;
const ROLES: Role[] = ['USER', 'ADMIN', 'ROOT'];

async function member(role: Role = 'USER', opts: Parameters<typeof createUser>[0] = {}) {
  const user = await createUser({ role, ...opts });
  emails.push(user.email);
  return { user, cookie: accessCookie(user) };
}

// the state of a subscription as the profile shows it
const stateOf = (fields: Record<string, unknown>) => ({
  subscribed: true,
  subscribedAt: expect.stringMatching(/Z$/),
  ...fields,
});

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

describe.each(ROLES)('the profile of %s', (role) => {
  it('shows no subscription, then the one the person made', async () => {
    const { cookie } = await member(role, { locale: 'uk' });

    const none = await api.get(ME, { cookie });
    await api.post(SUBSCRIPTIONS, {}, { cookie });
    const made = await api.get(ME, { cookie });

    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ subscribed: false });
    expect(made.statusCode).toBe(200);
    expect(made.json()).toEqual(
      stateOf({ source: 'account', status: 'active', locale: 'uk', canChangeLocale: true }),
    );
  });

  it('changes the language of the subscription of the account, with a line in the journal', async () => {
    const { user, cookie } = await member(role);
    await api.post(SUBSCRIPTIONS, { locale: 'en' }, { cookie });

    const res = await api.patch(
      ME,
      { locale: 'es' },
      { cookie, from: '198.51.100.81', userAgent: 'p/1' },
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      stateOf({ source: 'account', status: 'active', locale: 'es', canChangeLocale: true }),
    );
    expect((await journalOf(user.email)).at(-1)).toMatchObject({
      event: 'locale_changed',
      place: 'profile',
      ip: '198.51.100.81',
      userAgent: 'p/1',
      locale: 'es',
    });
  });

  it('unsubscribes, and the profile shows none; a new subscription starts anew', async () => {
    const { user, cookie } = await member(role);
    await api.post(SUBSCRIPTIONS, {}, { cookie });

    const res = await api.delete(ME, { cookie, from: '198.51.100.82' });
    const after = await api.get(ME, { cookie });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unsubscribed: true });
    expect(after.json()).toEqual({ subscribed: false });
    expect((await journalOf(user.email)).at(-1)).toMatchObject({
      event: 'unsubscribed',
      place: 'profile',
      ip: '198.51.100.82',
    });
    expect((await api.post(SUBSCRIPTIONS, {}, { cookie })).statusCode).toBe(201);
  });

  it('puts a subscription a complaint paused back in force', async () => {
    const { user, cookie } = await member(role);
    await arrange({
      email: user.email,
      source: 'account',
      userId: user.id,
      status: 'paused_complaint',
    });
    const cleared = watchSpamReportClearing();

    const shown = await api.get(ME, { cookie });
    const res = await api.post(`${ME}/resume`, undefined, { cookie });

    expect(shown.json()).toMatchObject({ status: 'paused_complaint' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(
      stateOf({ source: 'account', status: 'active', locale: null, canChangeLocale: true }),
    );
    expect(cleared).toEqual([{ email: user.email, stream: 'newsletter', status: 204 }]);
    expect((await journalOf(user.email)).at(-1)).toMatchObject({
      event: 'restored',
      place: 'profile',
    });
  });
});

describe('GET /api/newsletters/me', () => {
  it('shows a subscription of the form on the address too, whose language is changed on its own page', async () => {
    const { user, cookie } = await member();
    await arrange({ email: user.email, locale: 'es' });

    const res = await api.get(ME, { cookie });

    expect(res.json()).toEqual(
      stateOf({ source: 'form', status: 'active', locale: 'es', canChangeLocale: false }),
    );
  });

  it('shows a subscription paused by a complaint with its state', async () => {
    const { user, cookie } = await member();
    await arrange({ email: user.email, status: 'paused_complaint', locale: 'uk' });

    const res = await api.get(ME, { cookie });

    expect(res.json()).toMatchObject({
      subscribed: true,
      status: 'paused_complaint',
      locale: 'uk',
    });
  });

  it.each(['pending', 'ended', 'stopped_bounce'] as const)(
    'shows no subscription when the address only has one that is %s',
    async (status) => {
      const { user, cookie } = await member();
      await arrange({ email: user.email, status });

      const res = await api.get(ME, { cookie });

      expect(res.json()).toEqual({ subscribed: false });
    },
  );

  it('shows a person the subscription of their own address and no one else', async () => {
    const owner = await member();
    const stranger = await member();
    await arrange({ email: owner.user.email, source: 'account', userId: owner.user.id });

    const res = await api.get(ME, { cookie: stranger.cookie });

    expect(res.json()).toEqual({ subscribed: false });
  });

  it('is refused for an account that has not verified its address', async () => {
    const { cookie } = await member('USER', { isVerified: false });

    const res = await api.get(ME, { cookie });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_EMAIL_NOT_VERIFIED' });
  });
});

describe('PATCH /api/newsletters/me', () => {
  it('writes nothing when the language is the one the subscription has', async () => {
    const { user, cookie } = await member();
    await api.post(SUBSCRIPTIONS, { locale: 'es' }, { cookie });
    const lines = (await journalOf(user.email)).length;

    const res = await api.patch(ME, { locale: 'es' }, { cookie });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ locale: 'es' });
    expect(await journalOf(user.email)).toHaveLength(lines);
  });

  it('reads a language with a region as the one it names', async () => {
    const { user, cookie } = await member();
    await api.post(SUBSCRIPTIONS, { locale: 'en' }, { cookie });

    await api.patch(ME, { locale: 'UK-ua' }, { cookie });

    expect((await liveRowOf(user.email))?.locale).toBe('uk');
  });

  it.each([
    ['a language the shop does not answer in', { locale: 'fr' }, 'LOCALE_INVALID'],
    ['a language of the wrong shape', { locale: 'e1' }, 'LOCALE_INVALID'],
    ['an empty language', { locale: '' }, 'LOCALE_INVALID'],
    ['a language over 35 characters', { locale: 'e'.repeat(36) }, 'VALIDATION_ERROR'],
    ['no language', {}, 'VALIDATION_ERROR'],
  ])('refuses %s', async (_case, body, errorCode) => {
    const { user, cookie } = await member();
    await api.post(SUBSCRIPTIONS, { locale: 'en' }, { cookie });

    const res = await api.patch(ME, body, { cookie });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect((await liveRowOf(user.email))?.locale).toBe('en');
  });

  it('leaves the language of a subscription of the form to its own page', async () => {
    const { user, cookie } = await member();
    await arrange({ email: user.email, locale: 'en' });

    const res = await api.patch(ME, { locale: 'uk' }, { cookie });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_LOCALE_NOT_ALLOWED' });
    expect((await liveRowOf(user.email))?.locale).toBe('en');
  });

  it('answers 404 when the address has no subscription in force', async () => {
    const { cookie } = await member();

    const res = await api.patch(ME, { locale: 'uk' }, { cookie });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_NOT_SUBSCRIBED' });
  });

  it('never reaches the subscription of another person', async () => {
    const owner = await member();
    const stranger = await member();
    await api.post(SUBSCRIPTIONS, { locale: 'en' }, { cookie: owner.cookie });

    const res = await api.patch(ME, { locale: 'uk' }, { cookie: stranger.cookie });

    expect(res.statusCode).toBe(404);
    expect((await liveRowOf(owner.user.email))?.locale).toBe('en');
  });

  it('is refused for an account that has not verified its address', async () => {
    const { cookie } = await member('USER', { isVerified: false });

    const res = await api.patch(ME, { locale: 'uk' }, { cookie });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_EMAIL_NOT_VERIFIED' });
  });
});

describe('DELETE /api/newsletters/me', () => {
  it('ends a subscription of the form on the address as well', async () => {
    const { user, cookie } = await member();
    await arrange({ email: user.email, locale: 'en' });

    const res = await api.delete(ME, { cookie });

    expect(res.statusCode).toBe(200);
    expect(await liveRowOf(user.email)).toBeNull();
    expect((await rowsOf(user.email))[0]).toMatchObject({ status: 'ended' });
  });

  it('ends one paused by a complaint', async () => {
    const { user, cookie } = await member();
    await arrange({ email: user.email, status: 'paused_complaint' });

    expect((await api.delete(ME, { cookie })).statusCode).toBe(200);
    expect(await liveRowOf(user.email)).toBeNull();
  });

  it('is harmless when there is nothing to end: the same answer, nothing written', async () => {
    const { user, cookie } = await member();

    const none = await api.delete(ME, { cookie });
    await api.post(SUBSCRIPTIONS, {}, { cookie });
    await api.delete(ME, { cookie });
    const lines = (await journalOf(user.email)).length;
    const again = await api.delete(ME, { cookie });

    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ unsubscribed: true });
    expect(again.statusCode).toBe(200);
    expect(await journalOf(user.email)).toHaveLength(lines);
  });

  it('leaves a request of the form that waits on the address to its three days', async () => {
    const { user, cookie } = await member();
    await arrange({ email: user.email, status: 'pending' });

    await api.delete(ME, { cookie });

    expect((await liveRowOf(user.email))?.status).toBe('pending');
  });

  it('never reaches the subscription of another person', async () => {
    const owner = await member();
    const stranger = await member();
    await api.post(SUBSCRIPTIONS, {}, { cookie: owner.cookie });

    await api.delete(ME, { cookie: stranger.cookie });

    expect((await liveRowOf(owner.user.email))?.status).toBe('active');
  });

  it('is refused for an account that has not verified its address', async () => {
    const { cookie } = await member('USER', { isVerified: false });

    const res = await api.delete(ME, { cookie });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_EMAIL_NOT_VERIFIED' });
  });
});

describe('POST /api/newsletters/me/resume', () => {
  const RESUME = `${ME}/resume`;

  it('touches nothing in a subscription that is in force already', async () => {
    const { user, cookie } = await member();
    await api.post(SUBSCRIPTIONS, {}, { cookie });
    const cleared = watchSpamReportClearing();
    const lines = (await journalOf(user.email)).length;

    const res = await api.post(RESUME, undefined, { cookie });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'active' });
    expect(cleared).toEqual([]);
    expect(await journalOf(user.email)).toHaveLength(lines);
  });

  it('resumes a subscription of the form on the address too', async () => {
    const { user, cookie } = await member();
    await arrange({ email: user.email, status: 'paused_complaint' });

    const res = await api.post(RESUME, undefined, { cookie });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ source: 'form', status: 'active' });
  });

  it.each([
    ['SendGrid refuses the removal', 'refused'],
    ['SendGrid cannot be reached', 'unreachable'],
  ] as const)(
    'still resumes when %s, and only logs it, without the address',
    async (_case, how) => {
      const { user, cookie } = await member();
      await arrange({ email: user.email, status: 'paused_complaint' });
      breakSpamReportClearing(how);

      const res = await api.post(RESUME, undefined, { cookie });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'active' });
      const logged = takeLogs({ msg: 'spam report of the newsletter account was not cleared' });
      expect(logged).toHaveLength(1);
      expect(JSON.stringify(logged)).not.toContain(user.email);
    },
  );

  it('answers 404 when the address has no subscription in force', async () => {
    const { cookie } = await member();

    const res = await api.post(RESUME, undefined, { cookie });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_NOT_SUBSCRIBED' });
  });

  it('is refused for an account that has not verified its address', async () => {
    const { cookie } = await member('USER', { isVerified: false });

    const res = await api.post(RESUME, undefined, { cookie });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'NEWSLETTER_EMAIL_NOT_VERIFIED' });
  });
});

describe('the routes of the profile for someone who is not signed in', () => {
  it.each([
    ['GET', ME, undefined],
    ['PATCH', ME, { locale: 'uk' }],
    ['DELETE', ME, undefined],
    ['POST', `${ME}/resume`, undefined],
  ] as const)('%s %s is for a signed-in user only', async (method, url, payload) => {
    const send = () =>
      method === 'GET'
        ? api.get(url)
        : method === 'PATCH'
          ? api.patch(url, payload!)
          : method === 'DELETE'
            ? api.delete(url)
            : api.post(url, payload);

    const res = await send();

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });

  it('is refused for a session that ran out, as every route of the account is', async () => {
    const res = await app.inject({
      method: 'GET',
      url: ME,
      headers: { cookie: 'accessToken=not-a-token' },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'LOGIN_REQUIRED' });
  });

  it.each([
    ['PATCH', ME],
    ['DELETE', ME],
    ['POST', `${ME}/resume`],
  ] as const)('%s %s is refused without the csrf token', async (method, url) => {
    const user: TestUser = await createUser();
    emails.push(user.email);

    const res = await app.inject({
      method,
      url,
      headers: { cookie: accessCookie(user) },
      ...(method === 'PATCH' ? { payload: { locale: 'uk' } } : {}),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
  });
});
