import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { createUser } from '../../../helpers/factories.js';
import { arrange, forget } from '../../../helpers/newsletterApi.js';
import type { SubscriptionOpts } from '../../../helpers/newsletterDb.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../../helpers/newsletterStaff.js';

// The numbers for the people who run the newsletters, GET /api/newsletters/subscribers/summary: they
// count the whole table, so the file runs when no other file works on it (shopwide) and holds the
// answer against the answer before the file's own rows, whatever other rows the table has

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
const emails: string[] = [];

const SUMMARY = '/api/newsletters/subscribers/summary';

type Summary = {
  active: number;
  byLocale: { locale: string | null; count: number }[];
  bySource: { form: number; account: number };
  pending: number;
  pausedComplaint: number;
  stoppedBounce: number;
};

const summary = async (cookie = accessCookie(staff.manager)): Promise<Summary> => {
  const res = await app.inject({ method: 'GET', url: SUMMARY, headers: { cookie } });
  expect(res.statusCode).toBe(200);
  return res.json() as Summary;
};

const countOf = (answer: Summary, locale: string | null) =>
  answer.byLocale.find((bucket) => bucket.locale === locale)?.count ?? 0;

async function made(opts: SubscriptionOpts): Promise<number> {
  const email = `summary-${randomUUID()}@example.com`;
  emails.push(email);
  return (await arrange({ ...opts, email })).id;
}

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
});

afterAll(async () => {
  try {
    await forget(emails);
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

describe('GET /api/newsletters/subscribers/summary', () => {
  it('counts the subscriptions in force, by language and by source, and the ones in other states', async () => {
    const before = await summary();
    const accountUser = await createUser();
    const secondUser = await createUser();

    // in force: four of the form (two in Ukrainian, one in Spanish, one without a language) and two of
    // accounts (one in Ukrainian, one in a language only this file uses)
    await made({ source: 'form', status: 'active', locale: 'uk' });
    await made({ source: 'form', status: 'active', locale: 'uk' });
    await made({ source: 'form', status: 'active', locale: 'es' });
    await made({ source: 'form', status: 'active', locale: null });
    await made({ source: 'account', status: 'active', locale: 'uk', userId: accountUser.id });
    await made({ source: 'account', status: 'active', locale: 'zq', userId: secondUser.id });
    // not in force: they are counted by their state only, never in the numbers of the active ones
    for (let n = 0; n < 2; n += 1) await made({ status: 'pending', locale: 'uk' });
    await made({ status: 'paused_complaint', locale: 'uk' });
    for (let n = 0; n < 3; n += 1) await made({ status: 'stopped_bounce', locale: 'uk' });
    for (let n = 0; n < 4; n += 1) await made({ status: 'ended', locale: 'uk' });

    const after = await summary();

    expect(after.active - before.active).toBe(6);
    expect(after.bySource.form - before.bySource.form).toBe(4);
    expect(after.bySource.account - before.bySource.account).toBe(2);
    expect(countOf(after, 'uk') - countOf(before, 'uk')).toBe(3);
    expect(countOf(after, 'es') - countOf(before, 'es')).toBe(1);
    expect(countOf(after, null) - countOf(before, null)).toBe(1);
    expect(countOf(after, 'zq') - countOf(before, 'zq')).toBe(1);
    expect(after.pending - before.pending).toBe(2);
    expect(after.pausedComplaint - before.pausedComplaint).toBe(1);
    expect(after.stoppedBounce - before.stoppedBounce).toBe(3);
  });

  it('gives the languages as buckets that add up to the active ones, the subscriptions without a language as their own', async () => {
    await made({ source: 'form', status: 'active', locale: null });
    await made({ source: 'form', status: 'active', locale: 'uk' });

    const answer = await summary();

    expect(answer.byLocale.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(answer.active);
    expect(answer.bySource.form + answer.bySource.account).toBe(answer.active);
    // a bucket for no language has locale null, a bucket of a language two letters; none is empty
    expect(answer.byLocale.filter((bucket) => bucket.locale === null)).toHaveLength(1);
    for (const bucket of answer.byLocale) {
      expect(bucket.locale === null || /^[a-z]{2}$/.test(bucket.locale)).toBe(true);
      expect(bucket.count).toBeGreaterThan(0);
    }
  });

  it('orders the buckets by size, the largest first, equal ones by language, none last', async () => {
    const answer = await summary();
    const sizes = answer.byLocale.map((bucket) => bucket.count);

    expect(sizes).toEqual([...sizes].sort((x, y) => y - x));
    for (let n = 1; n < answer.byLocale.length; n += 1) {
      const [previous, current] = [answer.byLocale[n - 1]!, answer.byLocale[n]!];
      if (previous.count !== current.count) continue;

      expect(
        current.locale === null || (previous.locale !== null && previous.locale < current.locale),
      ).toBe(true);
    }
  });

  it('gives the fields of the numbers and nothing else, no address and no secret', async () => {
    await made({ source: 'form', status: 'active', locale: 'uk' });
    const res = await app.inject({
      method: 'GET',
      url: SUMMARY,
      headers: { cookie: accessCookie(staff.root) },
    });
    const answer = res.json() as Summary;

    expect(Object.keys(answer).sort()).toEqual(
      ['active', 'byLocale', 'bySource', 'pending', 'pausedComplaint', 'stoppedBounce'].sort(),
    );
    expect(Object.keys(answer.bySource).sort()).toEqual(['account', 'form']);
    for (const bucket of answer.byLocale) {
      expect(Object.keys(bucket).sort()).toEqual(['count', 'locale']);
    }
    expect(res.body).not.toContain('@');
    for (const field of ['manageSalt', 'manageHash', 'confirmHash', 'emailHmac']) {
      expect(res.body).not.toContain(field);
    }
  });

  it('follows a subscriber an admin erases', async () => {
    const id = await made({ source: 'form', status: 'active', locale: 'zq' });
    const before = await summary();

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/newsletters/subscribers/${id}`,
      headers: withCsrf(csrf, accessCookie(staff.manager)),
    });
    expect(removed.statusCode).toBe(200);

    const after = await summary();
    expect(before.active - after.active).toBe(1);
    expect(before.bySource.form - after.bySource.form).toBe(1);
    expect(countOf(before, 'zq') - countOf(after, 'zq')).toBe(1);
  });
});
