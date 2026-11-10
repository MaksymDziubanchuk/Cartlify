import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';
import { arrange, forget } from '../../../helpers/newsletterApi.js';
import { createNewsletterStaff, closeStaff } from '../../../helpers/newsletterStaff.js';

import type { NewsletterStaff } from '../../../helpers/newsletterStaff.js';
import type { SubscriptionStatus } from '../../../helpers/newsletterDb.js';

// GET /api/root/shop-settings/locale-counts: how many accounts and how many subscriptions of the
// newsletters have each language, for the warning root is shown before turning a language off
// (these people are left with no language and are mailed in the language of the shop). Root alone.
// *.shopwide.test.ts: the numbers are those of the whole shop, and the file that turns a language
// off for the check at its end must not meet the files that make accounts next to it
// (tests/setup/integration.shopState.ts)

const URL = '/api/root/shop-settings/locale-counts';
// a language no other file gives to a person: the numbers of it are exactly the ones this file made
const ODD = 'qa';

type Row = { locale: string; accounts: number; subscriptions: number };

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
const userIds: number[] = [];
const emails: string[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

const get = (cookie?: string) =>
  app.inject({ method: 'GET', url: URL, headers: cookie ? { cookie } : {} });

const countsOf = async (): Promise<Row[]> => {
  const res = await get(accessCookie(staff.root));
  expect(res.statusCode).toBe(200);
  return res.json().items as Row[];
};

const rowOf = (rows: Row[], locale: string) => rows.find((row) => row.locale === locale);

const account = async (locale: string): Promise<TestUser> => {
  const user = await createUser({ locale });
  userIds.push(user.id);
  return user;
};

const formSubscription = async (locale: string | null, status: SubscriptionStatus = 'active') => {
  const made = await arrange({ source: 'form', locale, status });
  emails.push(made.email);
  return made;
};

describe('who may ask', () => {
  it('answers root', async () => {
    const res = await get(accessCookie(staff.root));

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });

  it.each([
    ['a visitor with no login', () => undefined],
    ['a user', () => accessCookie(staff.user)],
    ['an admin', () => accessCookie(staff.plainAdmin)],
    ['an admin who runs the newsletters', () => accessCookie(staff.manager)],
  ])('refuses %s', async (_who, cookie) => {
    const res = await get(cookie());

    expect(res.statusCode).toBe(403);
  });
});

describe('the numbers', () => {
  it('count the accounts that are not deleted and the subscriptions that did not end, for each language', async () => {
    await account(ODD);
    await account(ODD);
    await account(ODD);
    await formSubscription(ODD, 'active');
    await formSubscription(ODD, 'pending');
    await formSubscription(ODD, 'paused_complaint');
    await formSubscription(ODD, 'stopped_bounce');
    // an ended subscription is the proof of a consent, it is not counted
    await formSubscription(ODD, 'ended');

    expect(rowOf(await countsOf(), ODD)).toEqual({ locale: ODD, accounts: 3, subscriptions: 4 });
  });

  it('say nothing of the people who have no language', async () => {
    const before = await countsOf();
    await account(ODD);
    await formSubscription(null);
    const person = await createUser();
    userIds.push(person.id);

    const after = await countsOf();

    expect(after.map((row) => row.locale)).not.toContain('');
    expect(after.every((row) => /^[a-z]{2}$/.test(row.locale))).toBe(true);
    expect(rowOf(after, ODD)!.accounts).toBe(rowOf(before, ODD)!.accounts + 1);
  });

  it('name the languages in the order of their codes, turned on or not', async () => {
    await account('uk');
    await account(ODD);

    const rows = await countsOf();
    const codes = rows.map((row) => row.locale);

    expect(codes).toEqual([...codes].sort());
    expect(codes).toEqual(expect.arrayContaining(['uk', ODD]));
    // the language of the shop is not a special case: it is a row like the others, when anyone has it
    for (const row of rows) {
      expect(row.accounts).toBeGreaterThanOrEqual(0);
      expect(row.subscriptions).toBeGreaterThanOrEqual(0);
      expect(row.accounts + row.subscriptions).toBeGreaterThan(0);
    }
  });

  it('grow with the people who take a language and are the numbers the turning off moves', async () => {
    const before = rowOf(await countsOf(), 'uk');
    await account('uk');
    await account('uk');
    await formSubscription('uk');

    const after = rowOf(await countsOf(), 'uk')!;

    expect(after.accounts).toBe((before?.accounts ?? 0) + 2);
    expect(after.subscriptions).toBe((before?.subscriptions ?? 0) + 1);

    // turning the language off leaves no one with it, so its row is gone
    const values = (
      await app.inject({
        method: 'GET',
        url: '/api/admin/shop-settings',
        headers: { cookie: accessCookie(staff.root) },
      })
    ).json();
    const { logoUrl: _logoUrl, ...writable } = values;
    const off = await app.inject({
      method: 'PUT',
      url: '/api/root/shop-settings',
      headers: withCsrf(csrf, accessCookie(staff.root)),
      payload: { ...writable, enabledLocales: ['en', 'es'] },
    });
    expect(off.statusCode).toBe(200);
    expect(rowOf(await countsOf(), 'uk')).toBeUndefined();

    const on = await app.inject({
      method: 'PUT',
      url: '/api/root/shop-settings',
      headers: withCsrf(csrf, accessCookie(staff.root)),
      payload: { ...writable, enabledLocales: values.enabledLocales },
    });
    expect(on.statusCode).toBe(200);
    // the language that came back has no one
    expect(rowOf(await countsOf(), 'uk')).toBeUndefined();
  });
});

// The subscriptions of the file go in a test, not in afterAll: the lock of the shop is let go before
// the afterAll of a file, and the file after it that counts every subscription would meet rows that
// vanish while it counts
describe('the end of the file', () => {
  it('removes the subscriptions it made', async () => {
    await forget(emails);
  });
});
