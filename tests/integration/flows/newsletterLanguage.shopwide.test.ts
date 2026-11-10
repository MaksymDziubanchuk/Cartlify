import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie, sessionCookie, signIn, type Session } from '../../helpers/actors.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../helpers/csrf.js';
import { dictionaryText } from '../../helpers/dictionary.js';
import { closeSessions, createUser, uniqueEmail, type TestUser } from '../../helpers/factories.js';
import { watchMail, watchNewsletterMail } from '../../helpers/mail.js';
import { BASE, SUBSCRIPTIONS, forget, newsletterApi } from '../../helpers/newsletterApi.js';
import {
  greetingOf,
  newsletterDesk,
  signInAccepting,
  subjectOf,
  subscribeOnPage,
} from '../../helpers/newsletterFlow.js';
import { withCaptcha } from '../../helpers/turnstile.js';

// Root turns a language of the shop off and what the people of the shop see. Root asks how many
// accounts and subscriptions have the language and sees the numbers; the accounts that have it get
// their password mail in it. Then root turns it off: the accounts and the subscriptions of the form
// that had it have no language any more (the profile of an account does not name one), the next mail
// of an account is in the language of the shop. A manager who wrote two campaigns with texts in
// English and in that language earlier sees the language marked as off on them, still edits the
// name, schedules them: they go out with no mail in the language that is off. A person who had the
// language gets the mail in the language of the shop, whatever the campaign does with the readers
// whose own language it has no text for (one campaign sends them the shop's language, the other
// skips them). Root turns the language on again: nobody gets it back and no mail goes out. A campaign
// that is already going out when root turns the language off sends what is left in the language the
// reader had when it started. The refusals of the routes of the settings and of the campaigns, and
// what a campaign does for each state of a subscription, are the tests of the routes
// (api/shopSettings, api/newsletters) and of the database. *.shopwide: the languages of the shop and
// the mail of every subscription are those of the whole shop.

const ALL = ['en', 'uk', 'es'];

let app: FastifyInstance;
let csrf: Csrf;
let root: TestUser;
let manager: TestUser;
const emails: string[] = [];
const userIds: number[] = [];
// the campaigns this file leaves scheduled when it breaks half way: they are called off at the end
const planned: number[] = [];
let foundShopLocale: string;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  root = await createUser({ role: 'ROOT', name: 'Language Root' });
  manager = await createUser({ role: 'ADMIN', name: 'Language Manager' });
  userIds.push(root.id, manager.id);

  const values = await currentValues();
  foundShopLocale = values.shopLocale;
  // the rows hold what this file sees (the baseline of the tests is in its memory only), with every
  // language turned on
  expect((await putAll(ALL)).statusCode).toBe(200);
});

// every language is on again after each test, whatever the test did, and nothing stays scheduled
afterEach(async () => {
  for (const id of planned.splice(0)) {
    await app.inject({
      method: 'POST',
      url: `${BASE}/campaigns/${id}/cancel`,
      headers: withCsrf(csrf, accessCookie(root)),
    });
  }
  await putAll(ALL);
  await forget(emails.splice(0));
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const as = (session: Session) => ({ cookie: sessionCookie(session) });

const currentValues = async () =>
  (
    await app.inject({
      method: 'GET',
      url: '/api/admin/shop-settings',
      headers: { cookie: accessCookie(root) },
    })
  ).json();

// every current value but the logo, as PUT takes them, with the languages given
const putAll = async (enabledLocales: string[]) => {
  const { logoUrl: _logoUrl, ...rest } = await currentValues();

  return app.inject({
    method: 'PUT',
    url: '/api/root/shop-settings',
    headers: withCsrf(csrf, accessCookie(root)),
    payload: { ...rest, enabledLocales, shopLocale: foundShopLocale },
  });
};

// a campaign with a text in English and in Ukrainian only, so a reader of any other language is left
// with the rule of the campaign
const twoLanguages = (tag: string) => ({
  subject: { en: subjectOf('en', tag), uk: subjectOf('uk', tag) },
  preview: { en: 'The best prices' },
  blocks: [
    { type: 'text', text: { en: greetingOf('en', tag), uk: greetingOf('uk', tag) } },
    { type: 'button', kind: 'sale', url: '/sale' },
  ],
});

// the subject of the password mail in a language, as the shop (the baseline of the tests names it
// Cartlify) writes it
const resetSubject = (locale: string) =>
  dictionaryText(locale, 'resetPassword.subject').replace('{{appName}}', 'Cartlify');

describe('root turns a language of the shop off', () => {
  it('leaves the people with no language, mails them in the shop language and sends nothing in the language that is off', async () => {
    // the shop speaks English, the language the campaigns below have a text in besides Ukrainian
    expect(foundShopLocale).toBe('en');
    const api = newsletterApi(app, csrf);
    const rootSession = await signIn(app, csrf, root);
    const managerSession = await signIn(app, csrf, manager);
    const get = (session: Session, url: string) => api.get(url, as(session));
    const post = (session: Session, url: string, body?: Record<string, unknown>) =>
      api.post(url, body, as(session));
    const turnOff = (languages: string[]) =>
      app.inject({
        method: 'PUT',
        url: '/api/root/shop-settings/enabledLocales',
        headers: withCsrf(csrf, sessionCookie(rootSession)),
        payload: { value: languages },
      });
    const forgot = async (user: TestUser) => {
      const mails = watchMail();
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/password/forgot',
        headers: withCsrf(csrf),
        payload: withCaptcha({ email: user.email }),
      });
      expect(res.statusCode).toBe(200);
      expect(mails).toHaveLength(1);
      return mails[0]!;
    };

    // root gives the manager the right, and the manager writes two campaigns with texts in English and
    // in Ukrainian: the one answers a reader who has no text with the language of the shop, the other
    // skips the reader
    const given = await api.patch(
      `/api/root/admins/${manager.id}`,
      { canManageNewsletters: true },
      as(rootSession),
    );
    expect(given.statusCode).toBe(200);
    const desk = newsletterDesk(app, csrf, sessionCookie(managerSession));
    const campaigns: Record<'shop_locale' | 'skip', number> = { shop_locale: 0, skip: 0 };
    for (const rule of ['shop_locale', 'skip'] as const) {
      const made = await post(managerSession, `${BASE}/campaigns`, {
        name: `Language ${rule}`,
        missingLocale: rule,
        content: twoLanguages(rule === 'skip' ? 'Y' : 'X'),
      });
      expect(made.statusCode).toBe(201);
      expect(made.json().disabledLocales).toEqual([]);
      campaigns[rule] = made.json().id as number;
    }

    // the people: two accounts that speak Ukrainian (one of them is subscribed), an account that speaks
    // Spanish and is subscribed, and two guests of the form, one in each language
    const baseline = await createUser({ name: 'Ula Baseline', locale: 'uk' });
    const uma = await createUser({ name: 'Uma Subscribed', locale: 'uk' });
    const dan = await createUser({ name: 'Dan Subscribed', locale: 'es' });
    userIds.push(baseline.id, uma.id, dan.id);
    emails.push(uma.email, dan.email);
    const gita = uniqueEmail('gita');
    const hal = uniqueEmail('hal');
    emails.push(gita, hal);

    const umaSession = await signInAccepting(app, csrf, uma);
    const danSession = await signInAccepting(app, csrf, dan);
    expect((await post(umaSession, SUBSCRIPTIONS, {})).statusCode).toBe(201);
    expect((await post(danSession, SUBSCRIPTIONS, {})).statusCode).toBe(201);
    await subscribeOnPage(app, csrf, gita, 'uk');
    await subscribeOnPage(app, csrf, hal, 'es');
    expect(await desk.subscribers(uma.email)).toEqual([expect.objectContaining({ locale: 'uk' })]);
    expect(await desk.subscribers(gita)).toEqual([expect.objectContaining({ locale: 'uk' })]);

    // before the language is off an account that speaks it gets its mail in it
    const before = await forgot(baseline);
    expect(before.subject).toBe(resetSubject('uk'));

    // root asks how many people have each language and sees both accounts and both subscriptions of
    // Ukrainian (the shop may hold more of them from other files)
    const counts = await get(rootSession, '/api/root/shop-settings/locale-counts');
    expect(counts.statusCode).toBe(200);
    const rows = counts.json().items as {
      locale: string;
      accounts: number;
      subscriptions: number;
    }[];
    const ukrainian = rows.find((row) => row.locale === 'uk')!;
    expect(ukrainian.accounts).toBeGreaterThanOrEqual(2);
    expect(ukrainian.subscriptions).toBeGreaterThanOrEqual(2);
    const spanish = rows.find((row) => row.locale === 'es')!;

    // root turns Ukrainian off
    expect((await turnOff(['en', 'es'])).statusCode).toBe(200);

    // nobody has Ukrainian any more; Spanish has not changed
    const after = (await get(rootSession, '/api/root/shop-settings/locale-counts')).json()
      .items as typeof rows;
    expect(after.find((row) => row.locale === 'uk')).toBeUndefined();
    expect(after.find((row) => row.locale === 'es')).toEqual(spanish);

    // the profile of an account that had it names no language; the one of Spanish still does
    const umaMe = await get(umaSession, '/api/users/me');
    expect(umaMe.statusCode).toBe(200);
    expect(umaMe.json().locale ?? null).toBeNull();
    expect((await get(danSession, '/api/users/me')).json()).toMatchObject({ locale: 'es' });

    // the manager sees the subscriptions: Ukrainian ones with no language, Spanish ones as they were
    const listed = (email: string) => desk.subscribers(email);
    expect(await listed(uma.email)).toEqual([expect.objectContaining({ locale: null })]);
    expect(await listed(gita)).toEqual([expect.objectContaining({ locale: null })]);
    expect(await listed(hal)).toEqual([expect.objectContaining({ locale: 'es' })]);

    // the next mail of an account that had Ukrainian is in the language of the shop
    const next = await forgot(uma);
    expect(next.subject).toBe(resetSubject(foundShopLocale));
    expect(next.subject).not.toBe(resetSubject('uk'));

    // the campaigns still have their Ukrainian texts and say that the language is off; the manager
    // renames one, which is allowed, and schedules both
    for (const id of Object.values(campaigns)) {
      const read = await get(managerSession, `${BASE}/campaigns/${id}`);
      expect(read.json().disabledLocales).toEqual(['uk']);
      expect(read.json().content.subject.uk).toEqual(expect.any(String));
    }
    const renamed = await api.patch(
      `${BASE}/campaigns/${campaigns.shop_locale}`,
      { name: 'Language renamed' },
      as(managerSession),
    );
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: 'Language renamed', disabledLocales: ['uk'] });

    const days: Record<number, Date> = {};
    for (const id of Object.values(campaigns)) {
      days[id] = desk.slot();
      const scheduled = await post(managerSession, `${BASE}/campaigns/${id}/schedule`, {
        scheduledAt: days[id]!.toISOString(),
      });
      expect(scheduled.statusCode).toBe(200);
      planned.push(id);
    }

    // the campaign that sends the shop language to the readers it has no text for: everybody gets
    // English, the people who had Ukrainian and the guest of Spanish alike, and no mail is in Ukrainian
    const sheltered = await desk.pass([campaigns.shop_locale], days[campaigns.shop_locale]!);
    expect(sheltered.summary).toMatchObject({ reason: 'done', launched: 1, finished: 1 });
    for (const email of [uma.email, dan.email, gita, hal]) {
      const own = sheltered.mails.filter((mail) => mail.to[0] === email);
      expect(own).toHaveLength(1);
      expect(own[0]!.subject).toBe(subjectOf('en', 'X'));
    }
    expect(sheltered.mails.some((mail) => mail.subject === subjectOf('uk', 'X'))).toBe(false);

    // the campaign that skips them: the people with no language still get English (the language of
    // the shop is the one they have now), the readers of Spanish, who have no text, get nothing
    const skipping = await desk.pass([campaigns.skip], days[campaigns.skip]!);
    expect(skipping.summary).toMatchObject({ reason: 'done', launched: 1, finished: 1 });
    for (const email of [uma.email, gita]) {
      const own = skipping.mails.filter((mail) => mail.to[0] === email);
      expect(own).toHaveLength(1);
      expect(own[0]!.subject).toBe(subjectOf('en', 'Y'));
    }
    for (const email of [dan.email, hal]) {
      expect(skipping.mails.filter((mail) => mail.to[0] === email)).toEqual([]);
    }
    expect(skipping.mails.some((mail) => mail.subject === subjectOf('uk', 'Y'))).toBe(false);
    planned.splice(0);

    // root turns Ukrainian on again: nobody gets it back and no mail goes out; the campaigns no
    // longer call the language off
    const quiet = [watchMail(), watchNewsletterMail()];
    expect((await turnOff(ALL)).statusCode).toBe(200);
    expect(quiet.flat()).toEqual([]);
    expect((await get(umaSession, '/api/users/me')).json().locale ?? null).toBeNull();
    expect(await listed(uma.email)).toEqual([expect.objectContaining({ locale: null })]);
    expect(await listed(gita)).toEqual([expect.objectContaining({ locale: null })]);
    expect(
      (await get(managerSession, `${BASE}/campaigns/${campaigns.skip}`)).json().disabledLocales,
    ).toEqual([]);

    // a person gets the language by choosing it again
    const chosen = await api.patch('/api/users/me', { locale: 'uk' }, as(umaSession));
    expect(chosen.statusCode).toBe(200);
    expect((await get(umaSession, '/api/users/me')).json()).toMatchObject({ locale: 'uk' });
    expect(desk.problems()).toEqual([]);
  });

  it('sends what is left of a campaign that is going out in the language the readers had when it started', async () => {
    const api = newsletterApi(app, csrf);
    const rootSession = await signIn(app, csrf, root);
    const managerSession = await signIn(app, csrf, manager);
    const post = (session: Session, url: string, body?: Record<string, unknown>) =>
      api.post(url, body, as(session));

    const given = await api.patch(
      `/api/root/admins/${manager.id}`,
      { canManageNewsletters: true },
      as(rootSession),
    );
    expect(given.statusCode).toBe(200);
    const desk = newsletterDesk(app, csrf, sessionCookie(managerSession));

    // three guests of the form in Ukrainian
    const readers = [uniqueEmail('first'), uniqueEmail('second'), uniqueEmail('third')];
    for (const email of readers) {
      emails.push(email);
      await subscribeOnPage(app, csrf, email, 'uk');
    }

    // the campaign goes out; the daily limit lets one mail go, and the rest wait
    const day = desk.slot();
    const made = await post(managerSession, `${BASE}/campaigns`, {
      name: 'Language going out',
      content: twoLanguages('W'),
    });
    expect(made.statusCode).toBe(201);
    const id = made.json().id as number;
    expect(
      (
        await post(managerSession, `${BASE}/campaigns/${id}/schedule`, {
          scheduledAt: day.toISOString(),
        })
      ).statusCode,
    ).toBe(200);
    planned.push(id);

    const half = await desk.pass([id], day, { dailyLimit: 1 });
    expect(half.summary).toMatchObject({ reason: 'daily_limit', launched: 1, sent: 1 });
    expect((await desk.campaign(id)).status).toBe('sending');
    const waiting = readers.filter((email) => !half.mails.some((mail) => mail.to[0] === email));
    expect(waiting.length).toBeGreaterThanOrEqual(2);

    // root turns Ukrainian off while the campaign is going out: the readers have no language now
    const off = await app.inject({
      method: 'PUT',
      url: '/api/root/shop-settings/enabledLocales',
      headers: withCsrf(csrf, sessionCookie(rootSession)),
      payload: { value: ['en', 'es'] },
    });
    expect(off.statusCode).toBe(200);
    for (const email of waiting) {
      expect(await desk.subscribers(email)).toEqual([expect.objectContaining({ locale: null })]);
    }

    // the pass sends the rest in the language they had when the campaign started
    const rest = await desk.pass([id], day);
    expect(rest.summary).toMatchObject({ reason: 'done', finished: 1 });
    for (const email of waiting) {
      const own = rest.mails.filter((mail) => mail.to[0] === email);
      expect(own).toHaveLength(1);
      expect(own[0]!.subject).toBe(subjectOf('uk', 'W'));
    }
    // and nobody gets a second mail
    for (const email of readers) {
      const total = [...half.mails, ...rest.mails].filter((mail) => mail.to[0] === email);
      expect(total).toHaveLength(1);
    }
    const finished = await desk.campaign(id);
    expect(finished.status).toBe('finished');
    expect(finished.counters.sent).toBe(finished.counters.planned);
    planned.splice(0);
    expect(desk.problems()).toEqual([]);
  });
});
