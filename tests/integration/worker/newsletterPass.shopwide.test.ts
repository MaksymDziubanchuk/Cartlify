import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import { setShopSettingsForTest } from '@config/shopSettings.js';
import { shopDayBounds } from '@helpers/shopDay.js';
import {
  clearSendingHalt,
  markSendingHalted,
  readSendingHalt,
} from '@routes/api/newsletters/services/helpers/sendingHalt.helper.js';
import { FAILURE_STREAK_LIMIT } from '@routes/api/newsletters/services/helpers/sendRecipient.helper.js';
import { startCampaign } from '@routes/api/newsletters/services/helpers/sendingStore.helper.js';
import { manageHashOf } from '@helpers/newsletterTokens.js';

import {
  runNewsletterPass,
  type NewsletterPassOptions,
} from '../../../src/jobs/newsletterPass.job.js';
import { startApp, stopApp } from '../../helpers/app.js';
import { getCsrf, type Csrf } from '../../helpers/csrf.js';
import { asAdmin } from '../../helpers/db.js';
import { deferred } from '../../helpers/interleave.js';
import {
  answerNewsletterMail,
  watchNewsletterMail,
  type NewsletterAnswer,
  type SentMail,
} from '../../helpers/mail.js';
import {
  campaignApi,
  campaignRowOf,
  campaignWithTotals,
  cancelledCampaign,
  draftOf,
  moveTo,
  requestWaitsForScheduleLock,
  SCHEDULE_LOCK,
  type CampaignApi,
} from '../../helpers/newsletterCampaigns.js';
import {
  arrange,
  forget,
  rowsOf as subscriptionsOf,
  type Arranged,
} from '../../helpers/newsletterApi.js';
import { deliverEvents } from '../../helpers/newsletterWebhook.js';
import { READER, callAs } from '../../helpers/newsletterFns.js';
import { campaignIn, utc, type SubscriptionOpts } from '../../helpers/newsletterDb.js';
import {
  closeStaff,
  createNewsletterStaff,
  type NewsletterStaff,
} from '../../helpers/newsletterStaff.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';
import {
  createProduct,
  deleteProductFromCatalog,
  type TestProduct,
} from '../../helpers/factories.js';

// The pass of the newsletters (src/jobs/newsletterPass.job.ts), from a campaign that is scheduled to
// one that is finished, with SendGrid answering the way the test scripts it (tests/helpers/mail.ts).
// Every campaign is made through the routes of the managers and moved to scheduled the way the database
// allows, every reader is a subscription arranged with real tokens, and the pass is told the time: a
// far-off day of its own for each test, so the daily limit of one test never spends another's. A pass
// is narrowed to the campaigns of its test; a campaign starts with a mail for every subscription in
// force in the database, so the tests judge the mails of their own readers, and the numbers that the
// pass counts (the audience) are read from the database. *.shopwide: the audience is the whole table
// of subscriptions, and nothing else may change it meanwhile.

let app: FastifyInstance;
let csrf: Csrf;
let staff: NewsletterStaff;
let api: CampaignApi;
const campaigns: number[] = [];
const addresses: string[] = [];
const products: TestProduct[] = [];

const DAY = 86_400_000;
const SENDER = () => process.env.NEWSLETTER_EMAIL_FROM;

// a day of its own for each test, years apart, in the summer (no clock change within days of it)
let testNumber = 0;
const dayOfTest = () => new Date(Date.UTC(2100 + 2 * testNumber++, 5, 15, 10, 0, 0));
const nextDayOf = (day: Date) => new Date(day.getTime() + DAY);

// what the pass logged: the lines of a level, and the ones a test takes as expected
type Line = { level: 'info' | 'warn' | 'error'; fields: Record<string, unknown>; msg: string };
let lines: Line[] = [];
const log = Object.fromEntries(
  (['info', 'warn', 'error'] as const).map((level) => [
    level,
    (first: unknown, second?: string) => {
      lines.push(
        typeof first === 'string'
          ? { level, fields: {}, msg: first }
          : { level, fields: first as Record<string, unknown>, msg: second ?? '' },
      );
    },
  ]),
) as unknown as NewsletterPassOptions['log'];

const takeLines = (level: Line['level'], msg: string): Line[] => {
  const taken = lines.filter((line) => line.level === level && line.msg === msg);
  lines = lines.filter((line) => !taken.includes(line));
  return taken;
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  staff = await createNewsletterStaff();
  api = campaignApi(app, csrf);
});

beforeEach(async () => {
  lines = [];
  // a stop of one test is not the stop of the next
  await clearSendingHalt();
});

afterEach(async () => {
  // the readers of a test are not the audience of the next one
  await forget(addresses.splice(0));

  // a warning or an error nobody expected fails the test, as in the tests of the routes
  expect(lines.filter((line) => line.level !== 'info')).toEqual([]);
});

afterAll(async () => {
  try {
    await clearSendingHalt();
    await forget(addresses);
    await inOwnerTx(
      async (db) => {
        await db.as({ role: 'ADMIN' });
        // the campaigns that went on stay in the database: a sending one is finished, a scheduled one
        // is called off by the manager, so nothing is left for a pass to take
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'finished', "finishedAt" = (now() at time zone 'utc')
           where id = any($1::int[]) and status = 'sending'`,
          campaigns,
        );
        await db.as({ role: 'ADMIN', userId: staff.manager.id });
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'cancelled', "cancelledAt" = (now() at time zone 'utc'), "updatedById" = $2::int
           where id = any($1::int[]) and status = 'scheduled'`,
          campaigns,
          staff.manager.id,
        );
      },
      { commit: true },
    );
    for (const product of products) await deleteProductFromCatalog(product.id);
    await closeStaff(staff);
  } finally {
    await stopApp();
  }
});

// ---- the data of a test ----

// a reader: a subscription in the state and the language given, with tokens a mail can carry
async function reader(opts: SubscriptionOpts = {}): Promise<Arranged> {
  const made = await arrange(opts);
  addresses.push(made.email);
  return made;
}

const contentOf = (tag: string, over: Record<string, unknown> = {}) => ({
  subject: { en: `Sale ${tag}`, es: `Rebajas ${tag}` },
  preview: { en: 'The best prices' },
  blocks: [
    { type: 'text', text: { en: `Hello ${tag}`, es: `Hola ${tag}` } },
    { type: 'button', kind: 'sale', url: '/sale' },
  ],
  ...over,
});

// a campaign made through the route and scheduled for an hour before `now`
async function scheduled(
  now: Date,
  opts: {
    tag?: string;
    content?: Record<string, unknown>;
    rule?: 'shop_locale' | 'skip';
    at?: Date;
  } = {},
): Promise<number> {
  const id = await draftOf(api, staff.manager, {
    content: opts.content ?? contentOf(opts.tag ?? 'T'),
    missingLocale: opts.rule ?? 'shop_locale',
  });
  campaigns.push(id);
  const at = opts.at ?? new Date(now.getTime() - 3_600_000);
  await moveTo(staff.manager, id, 'scheduled', utc(), { scheduledAt: at.toISOString() });
  return id;
}

// the pass, narrowed to the campaigns of the test and in a hurry
function pass(now: Date, ids: number[], over: Partial<NewsletterPassOptions> = {}) {
  return runNewsletterPass({
    log,
    now,
    pauseMs: 0,
    campaignIds: ids,
    dailyLimit: 1_000_000,
    ...over,
  });
}

type MailRow = {
  id: number;
  email: string;
  status: string;
  attempts: number;
  locale: string;
  messageId: string | null;
  sentAt: Date | null;
};

// the mails of a campaign as the database keeps them
const rowsOf = (campaign: number) =>
  inOwnerTx((db) =>
    callAs<MailRow>(
      db,
      READER,
      `select r.id, s.email, r.status::text as status, r.attempts, r.locale,
              r."providerMessageId" as "messageId", r."sentAt"
       from cartlify.newsletter_recipients r
       join cartlify.newsletter_subscriptions s on s.id = r."subscriptionId"
       where r."campaignId" = $1 order by r.id`,
      campaign,
    ),
  );

const rowOf = async (campaign: number, who: Arranged) =>
  (await rowsOf(campaign)).find((row) => row.email === who.email);

const activeAudience = () =>
  inOwnerTx(async (db) => {
    const [row] = await callAs<{ n: number }>(
      db,
      READER,
      `select count(*)::int as n from cartlify.newsletter_subscriptions where status = 'active'`,
    );
    return row!.n;
  });

// the mails of a campaign in a watcher; to one address
const ofCampaign = (mails: SentMail[], campaign: number) =>
  mails.filter((mail) => mail.customArgs.campaignId === String(campaign));
const toAddress = (mails: SentMail[], email: string) =>
  mails.filter((mail) => mail.to[0] === email);

// the mails of a campaign that a reader of the test got
const gotBy = (mails: SentMail[], campaign: number, who: Arranged) =>
  toAddress(ofCampaign(mails, campaign), who.email);

// the SendGrid answer for the mail of one reader only
const forReader = (
  who: Arranged,
  answer: (index: number) => NewsletterAnswer | Promise<NewsletterAnswer>,
) => {
  const seen = new Map<string, number>();

  answerNewsletterMail((mail) => {
    if (mail.to[0] !== who.email) return undefined;
    const index = seen.get(mail.to[0]) ?? 0;
    seen.set(mail.to[0], index + 1);
    return answer(index);
  });
};

// a lease of the mail that ran out: the next claim takes it again
const letLeaseRunOut = (recipientId: number) =>
  inOwnerTx(
    (db) =>
      db.rows(
        `update cartlify.newsletter_recipients
         set "updatedAt" = "updatedAt" - interval '11 minutes' where id = $1`,
        recipientId,
      ),
    { commit: true },
  );

// The leases of the mails of the campaign that wait run out: the next claim takes them again. Only the
// mails that have used fewer than `below` tries, if it is given: the others are under the lease of
// their last try. A mail given back goes back to the time it was made, which is old enough when a
// campaign has been sending for longer than a lease; the tests make a campaign that old this way
const letLeasesRunOut = (campaign: number, below = 1000) =>
  inOwnerTx(
    (db) =>
      db.rows(
        `update cartlify.newsletter_recipients
         set "updatedAt" = "updatedAt" - interval '11 minutes'
         where "campaignId" = $1 and status = 'queued' and attempts < $2::int`,
        campaign,
        below,
      ),
    { commit: true },
  );

// readers enough for the audience (every subscription in force) to be a multiple of ten, at least
// twenty: a run of refusals then always ends in the tenth, and no pass ends with a few refused mails
// that nothing could judge by a stream
async function audienceOfTens(): Promise<number> {
  while ((await activeAudience()) < 20 || (await activeAudience()) % 10 !== 0) {
    await reader({ locale: 'en' });
  }
  return activeAudience();
}

// a pass that stops on ten refusals one after the other, with the lines it logs taken
async function stoppedPass(now: Date, id: number) {
  const summary = await pass(now, [id], { concurrency: 1 });

  expect(summary.reason).toBe('halted');
  takeLines('warn', 'newsletter mails were not taken by the provider');
  takeLines('error', 'newsletter pass stopped, the mails not tried stay queued');
  return summary;
}

// Every mail of the campaign is tried once more and refused, ten at a time: each pass stops on its ten
// refusals, so each spends one try of ten mails. The leases of the mails that have used fewer than
// `tries` tries run out before each pass, the ones the pass has just tried keep theirs. Ends when every
// mail that waits has used `tries` tries; gives the summaries of the passes
async function refusedRound(now: Date, id: number, tries: number) {
  const stops: Awaited<ReturnType<typeof stoppedPass>>[] = [];

  for (
    let rows = await rowsOf(id);
    rows.some((row) => row.status === 'queued' && row.attempts < tries);
    rows = await rowsOf(id)
  ) {
    expect(stops.length).toBeLessThan(rows.length);
    await letLeasesRunOut(id, tries);
    stops.push(await stoppedPass(now, id));
  }

  return stops;
}

// ---- the whole path ----

describe('a campaign from scheduled to finished', () => {
  it('sends one mail to everyone in force, in their language, with what a mail client needs', async () => {
    const now = dayOfTest();
    const en = await reader({ locale: 'en' });
    const es = await reader({ locale: 'es' });
    const none = await reader({ locale: null });
    const uk = await reader({ locale: 'uk' });
    const others = {
      pending: await reader({ status: 'pending', locale: 'en' }),
      complaint: await reader({ status: 'paused_complaint', locale: 'en' }),
      bounced: await reader({ status: 'stopped_bounce', locale: 'en' }),
      ended: await reader({ status: 'ended', locale: 'en' }),
    };
    const id = await scheduled(now, { tag: 'A' });
    const sent = watchNewsletterMail();

    const summary = await pass(now, [id]);

    // the language of each: their own, the language of the shop for none, and for one the campaign
    // has no text in, the language of the shop (the rule of the campaign)
    expect(gotBy(sent, id, en).map((mail) => mail.subject)).toEqual(['Sale A']);
    expect(gotBy(sent, id, es).map((mail) => mail.subject)).toEqual(['Rebajas A']);
    expect(gotBy(sent, id, none).map((mail) => mail.subject)).toEqual(['Sale A']);
    expect(gotBy(sent, id, uk).map((mail) => mail.subject)).toEqual(['Sale A']);
    for (const who of Object.values(others)) expect(toAddress(sent, who.email)).toEqual([]);

    // the mail itself
    const mail = gotBy(sent, id, es)[0]!;
    expect(mail).toMatchObject({
      stream: 'newsletter',
      from: SENDER(),
      fromName: 'Cartlify',
      replyTo: null,
      categories: ['newsletter'],
      accepted: true,
      status: 202,
    });
    expect(mail.tracking).toMatchObject({
      click_tracking: { enable: false },
      open_tracking: { enable: false },
      subscription_tracking: { enable: false },
      ganalytics: { enable: false },
    });
    expect(mail.text).toContain('Hola A');
    expect(mail.html).toContain('Hola A');

    // the headers of the mail client: the one-click address carries the token of the unsubscribe of
    // this reader and the campaign; it is not the token the link "Manage the subscription" carries
    const unsubscribe = new URL(mail.headers['List-Unsubscribe']!.slice(1, -1));
    expect(unsubscribe.pathname).toBe(`/api/newsletters/unsubscribe/${es.unsubscribeToken}`);
    expect(unsubscribe.pathname).not.toContain(es.manageToken);
    expect(unsubscribe.searchParams.get('c')).toBe(String(id));
    expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(mail.html).toContain(`/newsletter/manage#token=${es.manageToken}`);
    expect(mail.html).not.toContain('?token=');

    // what comes back with the events of SendGrid: the ids as text and the environment the mail was
    // sent from, nothing that names the reader
    const row = (await rowOf(id, es))!;
    expect(mail.customArgs).toEqual({
      campaignId: String(id),
      recipientId: String(row.id),
      environment: 'test',
    });
    expect(JSON.stringify(mail.customArgs)).not.toContain(es.email);
    expect(JSON.stringify(mail.customArgs)).not.toContain(es.manageToken);
    expect(JSON.stringify(mail.customArgs)).not.toContain(es.unsubscribeToken);

    // the rows: sent, with the id SendGrid gave and the time of the pass
    expect(row).toMatchObject({
      status: 'sent',
      attempts: 1,
      locale: 'es',
      messageId: mail.messageId,
    });
    expect(row.messageId).toBeTruthy();
    expect(row.sentAt).not.toBeNull();

    // the summary and the campaign: everything planned went, the campaign is finished
    const campaign = (await campaignRowOf(id))!;
    expect(campaign).toMatchObject({ status: 'finished', rejectedCount: 0 });
    expect(campaign.sentCount).toBe(campaign.plannedCount);
    expect(campaign.sentCount).toBe(ofCampaign(sent, id).length);
    expect(campaign.finishedAt).not.toBeNull();
    expect(summary).toEqual({
      reason: 'done',
      launched: 1,
      cancelled: 0,
      claimed: campaign.plannedCount,
      sent: campaign.plannedCount,
      rejected: 0,
      retried: 0,
      skipped: 0,
      released: 0,
      deferred: 0,
      finished: 1,
    });
  });

  it('sends nobody a second mail of the campaign, however many passes run', async () => {
    const now = dayOfTest();
    const one = await reader({ locale: 'en' });
    const two = await reader({ locale: 'es' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();

    await pass(now, [id]);
    const again = await pass(now, [id]);
    await pass(nextDayOf(now), [id]);

    expect(gotBy(sent, id, one)).toHaveLength(1);
    expect(gotBy(sent, id, two)).toHaveLength(1);
    expect(again).toMatchObject({ reason: 'done', launched: 0, claimed: 0, sent: 0, finished: 0 });
    expect(new Set(ofCampaign(sent, id).map((mail) => mail.to[0])).size).toBe(
      ofCampaign(sent, id).length,
    );
  });

  it('writes the same mail for a reader whatever pass sends it: the id of the mail is theirs', async () => {
    const now = dayOfTest();
    const who = await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();

    await pass(now, [id]);

    const mail = gotBy(sent, id, who)[0]!;
    expect(mail.customArgs.recipientId).toBe(String((await rowOf(id, who))!.id));
  });
});

describe('the language of readers the campaign has no text for', () => {
  it('sends them the text of the shop language when the campaign says so', async () => {
    const now = dayOfTest();
    const uk = await reader({ locale: 'uk' });
    const id = await scheduled(now, { rule: 'shop_locale' });
    const sent = watchNewsletterMail();

    await pass(now, [id]);

    expect(gotBy(sent, id, uk)).toHaveLength(1);
    expect((await rowOf(id, uk))!.locale).toBe('en');
  });

  it('sends them nothing, and makes no row for them, when the campaign says skip', async () => {
    const now = dayOfTest();
    const uk = await reader({ locale: 'uk' });
    const en = await reader({ locale: 'en' });
    const id = await scheduled(now, { rule: 'skip' });
    const sent = watchNewsletterMail();

    await pass(now, [id]);

    expect(gotBy(sent, id, uk)).toEqual([]);
    expect(await rowOf(id, uk)).toBeUndefined();
    expect(gotBy(sent, id, en)).toHaveLength(1);
  });

  it('leaves out a mail that has nothing in it for the language, and counts it in no total', async () => {
    const now = dayOfTest();
    const es = await reader({ locale: 'es' });
    const en = await reader({ locale: 'en' });
    // the campaign has a subject in Spanish but no text: the Spanish mail would be empty
    const id = await scheduled(now, {
      content: {
        subject: { en: 'Sale', es: 'Rebajas' },
        preview: {},
        blocks: [{ type: 'text', text: { en: 'Hello' } }],
      },
    });
    const sent = watchNewsletterMail();

    const summary = await pass(now, [id]);

    expect(gotBy(sent, id, es)).toEqual([]);
    expect(gotBy(sent, id, en)).toHaveLength(1);
    expect((await rowOf(id, es))!.status).toBe('skipped');

    const campaign = (await campaignRowOf(id))!;
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect(campaign.sentCount + campaign.rejectedCount).toBe(
      campaign.plannedCount - summary.skipped,
    );
    expect(campaign.status).toBe('finished');
  });
});

// ---- who is mailed ----

describe('who is mailed', () => {
  it('does not mail a person who subscribed after the campaign started', async () => {
    const now = dayOfTest();
    const early = await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();
    // the day is spent after the first mails: the campaign stays sending
    const audience = await activeAudience();

    await pass(now, [id], { dailyLimit: audience - 1 });
    const late = await reader({ locale: 'en' });
    const second = await pass(nextDayOf(now), [id]);

    expect(second.reason).toBe('done');
    expect(gotBy(sent, id, late)).toEqual([]);
    expect(await rowOf(id, late)).toBeUndefined();
    expect(gotBy(sent, id, early)).toHaveLength(1);
    expect((await campaignRowOf(id))!.plannedCount).toBe(audience);
  });

  it('does not mail a person who unsubscribed after the start and before their turn', async () => {
    const now = dayOfTest();
    const stays = await reader({ locale: 'en' });
    const leaves = await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();
    const audience = await activeAudience();

    // the day's limit leaves the last two readers for the next day
    const first = await pass(now, [id], { dailyLimit: audience - 2 });
    expect(first.reason).toBe('daily_limit');
    expect(gotBy(sent, id, leaves)).toEqual([]);

    // the person leaves with the one-click link of an earlier mail
    const click = await app.inject({
      method: 'POST',
      url: `/api/newsletters/unsubscribe/${leaves.unsubscribeToken}?c=${id}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'List-Unsubscribe=One-Click',
    });
    expect(click.statusCode).toBe(200);

    const second = await pass(nextDayOf(now), [id]);

    expect(gotBy(sent, id, leaves)).toEqual([]);
    expect(gotBy(sent, id, stays)).toHaveLength(1);
    expect((await rowOf(id, leaves))!.status).toBe('skipped');
    expect(second.reason).toBe('done');

    const campaign = (await campaignRowOf(id))!;
    expect(campaign.status).toBe('finished');
    // the plan is what it was at the start; the one who left is in no total
    expect(campaign.plannedCount).toBe(audience);
    expect(campaign.sentCount).toBe(audience - 1);
    expect(campaign.rejectedCount).toBe(0);
  });

  it('leaves out a person who unsubscribed while their portion was already taken', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();
    let done = false;

    // the first mail of the portion goes out; meanwhile the last reader of the portion unsubscribes
    answerNewsletterMail(async (_mail, index) => {
      if (index !== 0 || done) return undefined;
      done = true;
      await inOwnerTx(
        (db) =>
          db.rows(
            `update cartlify.newsletter_subscriptions
             set status = 'ended', "endedAt" = (now() at time zone 'utc'), "endReason" = 'unsubscribed'
             where id = (select "subscriptionId" from cartlify.newsletter_recipients where "campaignId" = $1 order by id desc limit 1)`,
            id,
          ),
        { commit: true },
      );
      return undefined;
    });

    // one portion holds the whole audience, so the last reader is taken before the first mail goes
    const summary = await pass(now, [id], { batchSize: 1000, concurrency: 1 });

    const rows = await rowsOf(id);
    const last = rows[rows.length - 1]!;
    expect(last.status).toBe('skipped');
    expect(toAddress(ofCampaign(sent, id), last.email)).toEqual([]);
    expect(summary.skipped).toBe(1);
    // everybody else got their mail
    expect(ofCampaign(sent, id)).toHaveLength(rows.length - 1);
  });
});

// ---- the daily limit ----

describe('the daily limit', () => {
  it('stops at the limit, keeps the campaign sending, and goes on the next day of the shop', async () => {
    const now = dayOfTest();
    // five readers, so the day's limit is more than the two that wait for the next day
    for (const locale of ['en', 'es', 'en', 'es', 'en']) await reader({ locale });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();
    const audience = await activeAudience();
    const limit = audience - 2;

    const first = await pass(now, [id], { dailyLimit: limit });

    expect(first).toMatchObject({
      reason: 'daily_limit',
      claimed: limit,
      sent: limit,
      finished: 0,
    });
    expect(ofCampaign(sent, id)).toHaveLength(limit);
    expect((await campaignRowOf(id))!.status).toBe('sending');
    expect((await rowsOf(id)).filter((row) => row.status === 'queued')).toHaveLength(2);

    // the same day again: the limit is spent, nothing is taken
    const sameDay = await pass(now, [id], { dailyLimit: limit });
    expect(sameDay).toMatchObject({ reason: 'daily_limit', claimed: 0, sent: 0 });
    expect(ofCampaign(sent, id)).toHaveLength(limit);

    // the next day of the shop: the rest, and the campaign is finished
    const next = nextDayOf(now);
    const second = await pass(next, [id], { dailyLimit: limit });

    expect(second).toMatchObject({ reason: 'done', claimed: 2, sent: 2, finished: 1 });
    expect(ofCampaign(sent, id)).toHaveLength(audience);
    expect((await campaignRowOf(id))!.status).toBe('finished');

    // the mails are dated by the day they went: `limit` on the first day, the two on the second
    const countOn = (day: Date) => {
      const { start, end } = shopDayBounds(day);
      const wall = (at: Date) => at.toISOString().slice(0, -1);

      return inOwnerTx(async (db) => {
        const [row] = await callAs<{ n: number }>(
          db,
          READER,
          `select count(*)::int as n from cartlify.newsletter_recipients
           where "campaignId" = $1 and "sentAt" >= $2::timestamp and "sentAt" < $3::timestamp`,
          id,
          wall(start),
          wall(end),
        );
        return row!.n;
      });
    };
    expect(await countOn(now)).toBe(limit);
    expect(await countOn(next)).toBe(2);
  });

  it('goes by the setting of the server (NEWSLETTER_DAILY_LIMIT) when the pass is given no limit', async () => {
    const now = dayOfTest();
    const limit = env.NEWSLETTER_DAILY_LIMIT;
    for (let i = 0; i < limit + 3; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();

    // the others do not pass a limit of their own; this one does not either
    const summary = await runNewsletterPass({ log, now, pauseMs: 0, campaignIds: [id] });

    expect(summary).toMatchObject({ reason: 'daily_limit', sent: limit, finished: 0 });
    expect(ofCampaign(sent, id)).toHaveLength(limit);
    expect((await campaignRowOf(id))!.status).toBe('sending');
  });

  it('shares the limit between the campaigns of the day', async () => {
    const now = dayOfTest();
    for (const locale of ['en', 'es', 'en']) await reader({ locale });
    const first = await scheduled(now, { tag: 'one', at: new Date(now.getTime() - 7_200_000) });
    const second = await scheduled(now, { tag: 'two', at: new Date(now.getTime() - 3_600_000) });
    const sent = watchNewsletterMail();
    const audience = await activeAudience();

    // room for the first campaign and all but one mail of the second
    const summary = await pass(now, [first, second], { dailyLimit: 2 * audience - 1 });

    expect(summary).toMatchObject({ reason: 'daily_limit', launched: 2, sent: 2 * audience - 1 });
    expect(ofCampaign(sent, first)).toHaveLength(audience);
    expect(ofCampaign(sent, second)).toHaveLength(audience - 1);
    expect((await campaignRowOf(first))!.status).toBe('finished');
    expect((await campaignRowOf(second))!.status).toBe('sending');
  });

  it('sends nothing when the limit is nothing, and still starts the campaign', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();

    const summary = await pass(now, [id], { dailyLimit: 0 });

    expect(summary).toMatchObject({ reason: 'daily_limit', launched: 1, claimed: 0, sent: 0 });
    expect(ofCampaign(sent, id)).toEqual([]);
    expect((await campaignRowOf(id))!.status).toBe('sending');
  });
});

// ---- when a campaign starts ----

describe('when a campaign starts', () => {
  it('starts at its time and not before', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    const id = await scheduled(now, { at: new Date(now.getTime() + 3_600_000) });
    const sent = watchNewsletterMail();

    const early = await pass(now, [id]);
    expect(early).toMatchObject({ launched: 0, claimed: 0, reason: 'done' });
    expect((await campaignRowOf(id))!.status).toBe('scheduled');
    expect(ofCampaign(sent, id)).toEqual([]);

    const later = await pass(new Date(now.getTime() + 2 * 3_600_000), [id]);
    expect(later.launched).toBe(1);
    expect((await campaignRowOf(id))!.status).toBe('finished');
  });

  it('never starts a campaign that was called off', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    const id = await scheduled(now);
    const cancel = await api.cancel(staff.manager, id);
    expect(cancel.statusCode).toBe(200);
    const sent = watchNewsletterMail();

    const summary = await pass(now, [id]);

    expect(summary).toMatchObject({ launched: 0, claimed: 0, finished: 0 });
    expect((await campaignRowOf(id))!.status).toBe('cancelled');
    expect(await rowsOf(id)).toEqual([]);
    expect(ofCampaign(sent, id)).toEqual([]);
  });

  it('lets a campaign that is not scheduled any more go by without a word, and a real fault be heard', async () => {
    const now = dayOfTest();
    const id = await scheduled(now);
    expect((await api.cancel(staff.manager, id)).statusCode).toBe(200);
    const snapshot = { takenAt: now.toISOString(), currency: 'EUR', blocks: [] };

    // cancelled between the moment the pass read the list and the moment it started the campaign
    expect(await startCampaign(id, snapshot, 'en', now)).toEqual({ status: 'not_scheduled' });
    // a campaign there is none of
    expect(await startCampaign(2_000_000_000, snapshot, 'en', now)).toEqual({
      status: 'not_scheduled',
    });
    expect((await campaignRowOf(id))!.status).toBe('cancelled');

    // a language that is no language is a fault of the pass, not a race: it is heard, and the campaign
    // that is scheduled stays so
    const waiting = await scheduled(now);
    await expect(startCampaign(waiting, snapshot, 'EN', now)).rejects.toBeDefined();
    expect((await campaignRowOf(waiting))!.status).toBe('scheduled');
  });

  it('finishes at once a campaign nobody is mailed in', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    // a subject in Ukrainian alone and the rule skip: nobody of the audience speaks it
    const id = await scheduled(now, {
      content: {
        subject: { uk: 'Only Ukrainian' },
        preview: {},
        blocks: [{ type: 'text', text: { uk: 'Only Ukrainian' } }],
      },
      rule: 'skip',
    });
    const sent = watchNewsletterMail();

    const summary = await pass(now, [id]);

    expect(summary).toMatchObject({
      launched: 1,
      claimed: 0,
      sent: 0,
      finished: 1,
      reason: 'done',
    });
    const campaign = (await campaignRowOf(id))!;
    expect(campaign).toMatchObject({ status: 'finished', plannedCount: 0, sentCount: 0 });
    expect(ofCampaign(sent, id)).toEqual([]);
  });

  it('takes the products once, at the start: later mails keep the cards of the start', async () => {
    const now = dayOfTest();
    const product = await createProduct({ price: 40, name: 'Snapshot Shoe', stock: 10 });
    products.push(product);
    const who = await reader({ locale: 'en' });
    const last = await reader({ locale: 'en' });
    const id = await scheduled(now, {
      content: contentOf('P', {
        blocks: [
          { type: 'text', text: { en: 'Hello', es: 'Hola' } },
          { type: 'products', title: { en: 'Picks' }, source: 'manual', productIds: [product.id] },
        ],
      }),
    });
    const sent = watchNewsletterMail();
    const audience = await activeAudience();

    // the first day sends all but the last reader
    await pass(now, [id], { dailyLimit: audience - 1 });
    expect(gotBy(sent, id, who)[0]!.html).toContain('Snapshot Shoe');
    expect(gotBy(sent, id, last)).toEqual([]);

    // the shop changes the product after the start
    await asAdmin((tx) =>
      tx.product.update({ where: { id: product.id }, data: { name: 'Renamed Shoe' } }),
    );

    await pass(nextDayOf(now), [id]);

    // the reader of the second day got the card as it was at the start
    const late = gotBy(sent, id, last)[0]!;
    expect(late.html).toContain('Snapshot Shoe');
    expect(late.html).not.toContain('Renamed Shoe');
    expect(late.text).toContain('Snapshot Shoe');
    const snapshot = (await campaignRowOf(id))!.productsSnapshot as {
      blocks: Array<{ items?: Array<{ name: string }> } | null>;
    };
    expect(snapshot.blocks[1]!.items![0]!.name).toBe('Snapshot Shoe');
  });
});

// ---- the limit of the campaigns, asked again at the start ----

describe('the limit of the campaigns, asked again when a campaign starts', () => {
  const CALLED_OFF = 'newsletter campaign was called off, the limit of the campaigns left no room';

  // a campaign that went out `agoMs` before `now`: it counts in the limit by the time it began
  const wentOutBefore = (now: Date, agoMs: number) =>
    campaignWithTotals(staff.manager, 'finished', {}, utc(), {
      startedAt: new Date(now.getTime() - agoMs).toISOString(),
    });

  // the shop allows `count` campaigns in `days` days while `fn` runs
  async function withLimit(count: number, days: number, fn: () => Promise<void>) {
    setShopSettingsForTest({ newsletterLimitCount: count, newsletterLimitDays: days });
    try {
      await fn();
    } finally {
      setShopSettingsForTest({ newsletterLimitCount: 2, newsletterLimitDays: 7 });
    }
  }

  it('calls off a campaign the limit as it is now leaves no room for: cancelled, with the reason, no mail', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    const went = await wentOutBefore(now, 2 * DAY);
    const id = await scheduled(now);
    const before = (await campaignRowOf(id))!;
    const sent = watchNewsletterMail();

    await withLimit(1, 7, async () => {
      const summary = await pass(now, [id]);

      expect(summary).toMatchObject({ launched: 0, cancelled: 1, claimed: 0, finished: 0 });
    });

    const row = (await campaignRowOf(id))!;
    expect(row).toMatchObject({
      status: 'cancelled',
      cancelReason: 'limit',
      plannedCount: 0,
      startedAt: null,
      // the system called it off: nobody is named as the one who changed it last
      updatedById: before.updatedById,
    });
    expect(row.cancelledAt).not.toBeNull();
    // no mail is made, none is sent
    expect(await rowsOf(id)).toEqual([]);
    expect(ofCampaign(sent, id)).toEqual([]);
    // the line says which campaigns filled the window, and never a text or an address
    const called = takeLines('warn', CALLED_OFF);
    expect(called).toHaveLength(1);
    expect(called[0]!.fields).toEqual({
      campaignId: id,
      limit: { count: 1, days: 7 },
      campaigns: [went],
    });
  });

  it('does not take the campaign up again once the limit called it off, whichever pass comes', async () => {
    const now = dayOfTest();
    await wentOutBefore(now, DAY);
    const id = await scheduled(now);

    await withLimit(1, 7, async () => {
      expect((await pass(now, [id])).cancelled).toBe(1);
      takeLines('warn', CALLED_OFF);

      // not even with room: it is cancelled, a manager copies it
      await withLimit(100, 1, async () => {
        expect(await pass(now, [id])).toMatchObject({ launched: 0, cancelled: 0 });
      });
    });
    expect(await campaignRowOf(id)).toMatchObject({ status: 'cancelled', cancelReason: 'limit' });
  });

  it('calls off every campaign that does not fit, each judged by the ones that went out', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    await wentOutBefore(now, DAY);
    await wentOutBefore(now, 3 * DAY);
    const first = await scheduled(now, { tag: 'a', at: new Date(now.getTime() - 2 * 3_600_000) });
    const second = await scheduled(now, { tag: 'b', at: new Date(now.getTime() - 3_600_000) });

    await withLimit(2, 7, async () => {
      const summary = await pass(now, [first, second]);

      expect(summary).toMatchObject({ launched: 0, cancelled: 2 });
    });
    takeLines('warn', CALLED_OFF);
    for (const id of [first, second]) {
      expect(await campaignRowOf(id)).toMatchObject({ status: 'cancelled', cancelReason: 'limit' });
    }
  });

  it('starts a campaign that fits, with the others in the window counted against the limit and not past it', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    await wentOutBefore(now, 4 * DAY);
    const id = await scheduled(now);

    await withLimit(2, 7, async () => {
      const summary = await pass(now, [id]);

      expect(summary).toMatchObject({ launched: 1, cancelled: 0 });
    });
    expect(await campaignRowOf(id)).toMatchObject({ status: 'finished', cancelReason: null });
  });

  // the windows are half open: campaigns exactly so many days apart are not in one window
  it('puts campaigns exactly the days apart in different windows, and a minute nearer in one', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    await wentOutBefore(now, 7 * DAY);
    const apart = await scheduled(now, { tag: 'apart' });

    await withLimit(1, 7, async () => {
      expect(await pass(now, [apart])).toMatchObject({ launched: 1, cancelled: 0 });
    });

    const later = dayOfTest();
    await wentOutBefore(later, 7 * DAY - 60_000);
    const near = await scheduled(later, { tag: 'near' });

    await withLimit(1, 7, async () => {
      expect(await pass(later, [near])).toMatchObject({ launched: 0, cancelled: 1 });
    });
    takeLines('warn', CALLED_OFF);
  });

  it('counts the days in the setting of the shop, not seven', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    await wentOutBefore(now, 3 * DAY);
    const id = await scheduled(now);

    // one campaign in two days: the one of three days ago is outside, so this one fits
    await withLimit(1, 2, async () => {
      expect(await pass(now, [id])).toMatchObject({ launched: 1, cancelled: 0 });
    });
  });

  it('counts a campaign that went out whatever it came to: sending, finished, stopped', async () => {
    for (const state of ['sending', 'finished', 'stopped'] as const) {
      const day = dayOfTest();
      await campaignWithTotals(staff.manager, state, {}, utc(), {
        startedAt: new Date(day.getTime() - DAY).toISOString(),
      });
      const id = await scheduled(day, { tag: state });

      await withLimit(1, 7, async () => {
        expect(await pass(day, [id])).toMatchObject({ launched: 0, cancelled: 1 });
      });
      takeLines('warn', CALLED_OFF);
    }
  });

  it('counts neither a draft, nor a campaign that was called off, nor one that waits for a later time', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    const draft = await draftOf(api, staff.manager, {});
    campaigns.push(draft);
    // called off by a manager, scheduled for a day before: it never went out
    await cancelledCampaign(staff.manager, {
      scheduledAt: new Date(now.getTime() - DAY).toISOString(),
    });
    // called off by the limit, the same
    await cancelledCampaign(staff.manager, {
      by: 'limit',
      scheduledAt: new Date(now.getTime() - 2 * DAY).toISOString(),
    });
    // waits for its turn tomorrow: it is judged when its time comes
    await scheduled(now, { tag: 'later', at: new Date(now.getTime() + DAY) });
    const id = await scheduled(now);

    await withLimit(1, 7, async () => {
      expect(await pass(now, [id])).toMatchObject({ launched: 1, cancelled: 0 });
    });
  });

  it('does not count the campaign against itself', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    const id = await scheduled(now);

    await withLimit(1, 1, async () => {
      expect(await pass(now, [id])).toMatchObject({ launched: 1, cancelled: 0 });
    });
  });

  // the pass takes the lock the routes that schedule take, and reads the campaigns that count after it
  // has it: what the holder of the lock commits before it lets go is there to be counted
  it('waits for the lock of the schedule, and counts what was committed before it was let go', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    const id = await scheduled(now);
    let running!: ReturnType<typeof pass>;

    await withLimit(1, 7, async () => {
      await inOwnerTx(
        async (db) => {
          await db.rows('select pg_advisory_xact_lock(hashtext($1))', SCHEDULE_LOCK);
          running = pass(now, [id]);
          await requestWaitsForScheduleLock();

          // a campaign that went out a day before takes the room while the pass stands at the lock
          await campaignIn(
            db,
            { role: 'ADMIN', userId: staff.manager.id },
            'finished',
            utc(),
            {},
            { startedAt: new Date(now.getTime() - DAY).toISOString() },
          );
        },
        { commit: true },
      );

      expect(await running).toMatchObject({ launched: 0, cancelled: 1 });
    });
    takeLines('warn', CALLED_OFF);
    expect(await campaignRowOf(id)).toMatchObject({ status: 'cancelled', cancelReason: 'limit' });
  });

  it('gives a campaign a manager cancels at the same moment to the manager: the pass starts nothing', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    const id = await scheduled(now);
    expect((await api.cancel(staff.manager, id)).statusCode).toBe(200);

    await withLimit(1, 7, async () => {
      expect(await pass(now, [id])).toMatchObject({ launched: 0, cancelled: 0 });
    });
    expect(await campaignRowOf(id)).toMatchObject({ status: 'cancelled', cancelReason: null });
  });
});

// ---- when SendGrid does not take a mail ----

describe('a mail SendGrid does not take', () => {
  it.each([
    ['a server error', 500],
    ['too many requests', 429],
    ['no answer at all', 'unreachable' as const],
  ])('is tried again later after %s, and then it goes', async (_what, failure) => {
    const now = dayOfTest();
    const who = await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();
    forReader(who, (index) => (index === 0 ? failure : undefined));

    const first = await pass(now, [id]);

    // the mail waits, with a try used; the campaign stays sending
    expect(first).toMatchObject({ retried: 1, rejected: 0, finished: 0 });
    expect(await rowOf(id, who)).toMatchObject({ status: 'queued', attempts: 1, messageId: null });
    expect((await campaignRowOf(id))!.status).toBe('sending');
    expect(takeLines('warn', 'newsletter mails were not taken by the provider')).toHaveLength(1);

    // while the lease holds nothing is tried again
    const idle = await pass(now, [id]);
    expect(idle).toMatchObject({ claimed: 0, sent: 0 });
    expect(gotBy(sent, id, who)).toHaveLength(failure === 'unreachable' ? 0 : 1);

    // once it has run out, the mail goes and the campaign finishes
    await letLeaseRunOut((await rowOf(id, who))!.id);
    const second = await pass(now, [id]);

    expect(second).toMatchObject({ sent: 1, finished: 1, reason: 'done' });
    expect(await rowOf(id, who)).toMatchObject({ status: 'sent', attempts: 2 });
    expect(gotBy(sent, id, who).filter((mail) => mail.accepted)).toHaveLength(1);
    const campaign = (await campaignRowOf(id))!;
    expect(campaign.sentCount).toBe(campaign.plannedCount);
  });

  it('is given up after five tries: rejected, counted once, and not tried again', async () => {
    const now = dayOfTest();
    const who = await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();
    forReader(who, () => 500);

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const summary = await pass(now, [id]);
      expect(summary).toMatchObject({ retried: 1, rejected: 0, finished: 0 });
      expect(await rowOf(id, who)).toMatchObject({ status: 'queued', attempts: attempt });
      await letLeaseRunOut((await rowOf(id, who))!.id);
    }

    const fifth = await pass(now, [id]);

    expect(fifth).toMatchObject({ rejected: 1, retried: 0, finished: 1 });
    expect(await rowOf(id, who)).toMatchObject({ status: 'rejected', attempts: 5 });
    expect(gotBy(sent, id, who)).toHaveLength(5);
    expect(takeLines('warn', 'newsletter mails were not taken by the provider')).toHaveLength(5);

    const campaign = (await campaignRowOf(id))!;
    expect(campaign).toMatchObject({ status: 'finished', rejectedCount: 1 });
    expect(campaign.sentCount).toBe(campaign.plannedCount - 1);

    // nothing more, whatever passes follow
    await letLeaseRunOut((await rowOf(id, who))!.id);
    await pass(nextDayOf(now), [id]);
    expect(gotBy(sent, id, who)).toHaveLength(5);
  });

  // the number of tries and the pause between them are settings, handed to the database at every claim
  it('is given up after the number of tries the setting names (NEWSLETTER_MAX_ATTEMPTS)', async () => {
    const was = env.NEWSLETTER_MAX_ATTEMPTS;
    env.NEWSLETTER_MAX_ATTEMPTS = 2;
    try {
      const now = dayOfTest();
      const who = await reader({ locale: 'en' });
      const id = await scheduled(now);
      forReader(who, () => 500);

      const first = await pass(now, [id]);
      expect(first).toMatchObject({ retried: 1, rejected: 0 });
      expect(await rowOf(id, who)).toMatchObject({ status: 'queued', attempts: 1 });

      await letLeaseRunOut((await rowOf(id, who))!.id);
      const second = await pass(now, [id]);

      // the second try is the last: no third
      expect(second).toMatchObject({ rejected: 1, retried: 0, finished: 1 });
      expect(await rowOf(id, who)).toMatchObject({ status: 'rejected', attempts: 2 });
      takeLines('warn', 'newsletter mails were not taken by the provider');
    } finally {
      env.NEWSLETTER_MAX_ATTEMPTS = was;
    }
  });

  it('tries a mail again only after the minutes the setting names (NEWSLETTER_RETRY_MINUTES)', async () => {
    const was = env.NEWSLETTER_RETRY_MINUTES;
    env.NEWSLETTER_RETRY_MINUTES = 30;
    try {
      const now = dayOfTest();
      const who = await reader({ locale: 'en' });
      const id = await scheduled(now);
      const sent = watchNewsletterMail();
      forReader(who, (index) => (index === 0 ? 500 : undefined));

      await pass(now, [id]);
      const recipient = (await rowOf(id, who))!.id;
      takeLines('warn', 'newsletter mails were not taken by the provider');

      // eleven minutes is more than the ten of the default and less than the thirty of the setting
      await letLeaseRunOut(recipient);
      expect(await pass(now, [id])).toMatchObject({ claimed: 0, sent: 0 });
      expect(gotBy(sent, id, who)).toHaveLength(1);

      // thirty-three minutes is more than the setting
      await letLeaseRunOut(recipient);
      await letLeaseRunOut(recipient);
      expect(await pass(now, [id])).toMatchObject({ sent: 1, finished: 1 });
      expect(await rowOf(id, who)).toMatchObject({ status: 'sent', attempts: 2 });
    } finally {
      env.NEWSLETTER_RETRY_MINUTES = was;
    }
  });

  it.each([400, 404, 413])(
    'is rejected at once when SendGrid says %s, and never tried again',
    async (status) => {
      const now = dayOfTest();
      const who = await reader({ locale: 'en' });
      const id = await scheduled(now);
      const sent = watchNewsletterMail();
      forReader(who, () => status);

      const summary = await pass(now, [id]);

      expect(summary).toMatchObject({ rejected: 1, retried: 0, finished: 1 });
      expect(await rowOf(id, who)).toMatchObject({
        status: 'rejected',
        attempts: 1,
        messageId: null,
      });
      expect(takeLines('warn', 'newsletter mails were not taken by the provider')).toHaveLength(1);

      await letLeaseRunOut((await rowOf(id, who))!.id);
      await pass(nextDayOf(now), [id]);

      expect(gotBy(sent, id, who)).toHaveLength(1);
      const campaign = (await campaignRowOf(id))!;
      expect(campaign.rejectedCount).toBe(1);
      expect(campaign.sentCount).toBe(campaign.plannedCount - 1);
    },
  );

  // a mail that found SendGrid busy waits under its lease, and a lease of a few minutes can run out
  // within a long pass: the mail is taken again by the same pass. It is judged by its last try, once
  describe('a mail that is taken again by the same pass', () => {
    // the lease of the mail runs out while its first try is with SendGrid, as a short
    // NEWSLETTER_RETRY_MINUTES lets it within the minutes a pass may take
    const busyFirstTry = (who: Arranged, id: number, then: number | undefined) =>
      forReader(who, async (index) => {
        if (index > 0) return then;
        await letLeaseRunOut((await rowOf(id, who))!.id);
        return 503;
      });

    it('is counted once as busy when it is busy again', async () => {
      const now = dayOfTest();
      const who = await reader({ locale: 'en' });
      const id = await scheduled(now);
      busyFirstTry(who, id, 503);

      const summary = await pass(now, [id]);

      expect(summary).toMatchObject({ claimed: 2, sent: 0, rejected: 0, retried: 1, finished: 0 });
      expect(await rowOf(id, who)).toMatchObject({ status: 'queued', attempts: 2 });
      expect(takeLines('warn', 'newsletter mails were not taken by the provider')).toHaveLength(2);
    });

    it('is counted as sent and not as busy when it is taken the second time', async () => {
      const now = dayOfTest();
      const who = await reader({ locale: 'en' });
      const id = await scheduled(now);
      busyFirstTry(who, id, undefined);

      const summary = await pass(now, [id]);

      expect(summary).toMatchObject({ claimed: 2, sent: 1, rejected: 0, retried: 0, finished: 1 });
      expect(await rowOf(id, who)).toMatchObject({ status: 'sent', attempts: 2 });
      expect(takeLines('warn', 'newsletter mails were not taken by the provider')).toHaveLength(1);
    });
  });

  it('does not give up the pass over refusals that come among mails that are taken', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 24; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    // every other mail is refused
    answerNewsletterMail((_mail, index) => (index % 2 === 1 ? 400 : undefined));

    const summary = await pass(now, [id], { concurrency: 1 });

    expect(summary.reason).toBe('done');
    expect(summary.rejected).toBeGreaterThanOrEqual(12);
    expect(summary.sent).toBeGreaterThanOrEqual(12);
    expect(
      takeLines('warn', 'newsletter mails were not taken by the provider').length,
    ).toBeGreaterThan(0);
  });
});

describe('a stream that has a problem', () => {
  it.each([401, 403])(
    'stops the pass when SendGrid says %s, and leaves every mail queued as it was',
    async (status) => {
      const now = dayOfTest();
      const who = await reader({ locale: 'en' });
      const id = await scheduled(now);
      const sent = watchNewsletterMail();
      answerNewsletterMail(() => status);

      const summary = await pass(now, [id]);

      expect(summary.reason).toBe('halted');
      expect(summary).toMatchObject({ sent: 0, rejected: 0, finished: 0 });
      const rows = await rowsOf(id);
      expect(rows.length).toBeGreaterThan(0);
      // nothing was lost: every mail waits, and no try is counted against it
      expect(rows.every((row) => row.status === 'queued' && row.attempts === 0)).toBe(true);
      expect((await campaignRowOf(id))!.status).toBe('sending');

      const stopped = takeLines(
        'error',
        'newsletter pass stopped, the mails not tried stay queued',
      );
      expect(stopped).toHaveLength(1);
      expect(stopped[0]!.fields).toMatchObject({ why: 'access_refused', status });
      // the alert of the admins hears of it, with the time of the stop
      expect(await readSendingHalt()).toEqual({ at: now, why: 'access_refused' });

      // the key is mended: the next pass sends them all, each on its first try
      answerNewsletterMail(() => undefined);
      const next = await pass(now, [id]);

      expect(next).toMatchObject({ reason: 'done', finished: 1 });
      // and the stream has proved sound: the stop is gone
      expect(await readSendingHalt()).toBeNull();
      expect(await rowOf(id, who)).toMatchObject({ status: 'sent', attempts: 1 });
      expect(gotBy(sent, id, who).filter((mail) => mail.accepted)).toHaveLength(1);
    },
  );

  // Ten mails in a row refused: the readers are not all wrong, the stream may be. The pass stops and
  // judges none of them. The ten keep the try they used and wait out their lease, which puts them
  // behind the mails with fewer tries; the mails of the portion that were not tried go back, free at once
  it('stops the pass after many mails in a row that SendGrid refuses: the ten keep their try, the rest go back untried', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 14; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    answerNewsletterMail(() => 400);

    const summary = await pass(now, [id], { concurrency: 1 });

    expect(summary.reason).toBe('halted');
    const rows = await rowsOf(id);
    expect(rows.length).toBeGreaterThanOrEqual(14);
    expect(summary).toMatchObject({
      sent: 0,
      rejected: 0,
      retried: 0,
      finished: 0,
      deferred: FAILURE_STREAK_LIMIT,
      released: summary.claimed - FAILURE_STREAK_LIMIT,
    });
    // the first ten of the queue used their try and wait; the rest are as they were
    expect(
      rows
        .slice(0, FAILURE_STREAK_LIMIT)
        .every((row) => row.status === 'queued' && row.attempts === 1),
    ).toBe(true);
    expect(
      rows
        .slice(FAILURE_STREAK_LIMIT)
        .every((row) => row.status === 'queued' && row.attempts === 0),
    ).toBe(true);
    expect(await campaignRowOf(id)).toMatchObject({
      status: 'sending',
      rejectedCount: 0,
      sentCount: 0,
    });
    expect(takeLines('warn', 'newsletter mails were not taken by the provider')).toHaveLength(1);
    expect(
      takeLines('error', 'newsletter pass stopped, the mails not tried stay queued')[0]!.fields,
    ).toMatchObject({ why: 'every_mail_refused' });
    expect(await readSendingHalt()).toEqual({ at: now, why: 'every_mail_refused' });
  });

  // the ten wait out their lease: the next pass takes the mails not tried first, and the ten come
  // back after them, once their lease has run out
  it('sends the mails not tried on the next pass, and the ten refused after their lease, once the stream is mended', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 12; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();
    answerNewsletterMail(() => 400);
    await pass(now, [id], { concurrency: 1 });
    takeLines('warn', 'newsletter mails were not taken by the provider');
    takeLines('error', 'newsletter pass stopped, the mails not tried stay queued');
    const waiting = (await rowsOf(id)).slice(0, FAILURE_STREAK_LIMIT);

    answerNewsletterMail(() => undefined);
    const next = await pass(now, [id], { concurrency: 1 });

    // the ten are under their lease: the pass sends all the others, on their first try, and ends
    expect(next).toMatchObject({ reason: 'done', rejected: 0, deferred: 0, finished: 0 });
    let rows = await rowsOf(id);
    expect(next.sent).toBe(rows.length - FAILURE_STREAK_LIMIT);
    expect(rows.slice(0, FAILURE_STREAK_LIMIT).map((row) => [row.status, row.attempts])).toEqual(
      waiting.map(() => ['queued', 1]),
    );
    expect(
      rows.slice(FAILURE_STREAK_LIMIT).every((row) => row.status === 'sent' && row.attempts === 1),
    ).toBe(true);
    expect((await campaignRowOf(id))!.status).toBe('sending');
    expect(await readSendingHalt()).toBeNull();

    // their lease runs out, and the ten are tried again behind everything else
    for (const row of waiting) await letLeaseRunOut(row.id);
    const last = await pass(now, [id], { concurrency: 1 });

    expect(last).toMatchObject({
      reason: 'done',
      sent: FAILURE_STREAK_LIMIT,
      rejected: 0,
      finished: 1,
    });
    rows = await rowsOf(id);
    expect(rows.every((row) => row.status === 'sent')).toBe(true);
    expect(rows.slice(0, FAILURE_STREAK_LIMIT).every((row) => row.attempts === 2)).toBe(true);
    expect(ofCampaign(sent, id).filter((mail) => mail.accepted)).toHaveLength(rows.length);
  });

  // The first mails of the queue are refused for themselves (a broken text in one language, say) and
  // the stream is sound: they must not keep the rest of the campaign from going
  it('sends the rest of the campaign when the first ten mails are refused, and rejects the ten at their next try without stopping again', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 14; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();

    // pass one: the first ten mails are refused, the pass stops on them
    answerNewsletterMail((_mail, index) => (index < FAILURE_STREAK_LIMIT ? 400 : undefined));
    const first = await stoppedPass(now, id);

    let rows = await rowsOf(id);
    const refused = rows.slice(0, FAILURE_STREAK_LIMIT);
    const refusedAddresses = new Set(refused.map((row) => row.email));
    expect(first).toMatchObject({ sent: 0, rejected: 0, deferred: FAILURE_STREAK_LIMIT });
    expect(refused.every((row) => row.status === 'queued' && row.attempts === 1)).toBe(true);

    // pass two: the same ten are still refused, but they wait out their lease; the rest go
    answerNewsletterMail((mail) => (refusedAddresses.has(mail.to[0]!) ? 400 : undefined));
    const second = await pass(now, [id], { concurrency: 1 });

    rows = await rowsOf(id);
    expect(second).toMatchObject({
      reason: 'done',
      sent: rows.length - FAILURE_STREAK_LIMIT,
      rejected: 0,
      retried: 0,
      deferred: 0,
      finished: 0,
    });
    expect(rows.slice(0, FAILURE_STREAK_LIMIT).map((row) => [row.status, row.attempts])).toEqual(
      refused.map(() => ['queued', 1]),
    );
    expect(
      rows.slice(FAILURE_STREAK_LIMIT).every((row) => row.status === 'sent' && row.attempts === 1),
    ).toBe(true);
    expect((await campaignRowOf(id))!.status).toBe('sending');
    // a mail was taken: the stream has proved sound
    expect(await readSendingHalt()).toBeNull();
    expect(takeLines('error', 'newsletter pass stopped, the mails not tried stay queued')).toEqual(
      [],
    );
    takeLines('warn', 'newsletter mails were not taken by the provider');

    // pass three, after their lease: the ten are refused again, but the campaign sent mails since their
    // try, so the fault is theirs: each is rejected at once and the pass does not stop
    await letLeasesRunOut(id);
    const third = await pass(now, [id], { concurrency: 1 });

    expect(third).toMatchObject({
      reason: 'done',
      claimed: FAILURE_STREAK_LIMIT,
      sent: 0,
      rejected: FAILURE_STREAK_LIMIT,
      retried: 0,
      deferred: 0,
      finished: 1,
    });
    expect(takeLines('warn', 'newsletter mails were not taken by the provider')).toHaveLength(1);
    expect(takeLines('error', 'newsletter pass stopped, the mails not tried stay queued')).toEqual(
      [],
    );
    rows = await rowsOf(id);
    expect(
      rows
        .slice(0, FAILURE_STREAK_LIMIT)
        .every((row) => row.status === 'rejected' && row.attempts === 2),
    ).toBe(true);
    expect(await campaignRowOf(id)).toMatchObject({
      status: 'finished',
      rejectedCount: FAILURE_STREAK_LIMIT,
      sentCount: rows.length - FAILURE_STREAK_LIMIT,
    });
    expect(await readSendingHalt()).toBeNull();
    // every other reader got one mail, the ten none
    expect(ofCampaign(sent, id).filter((mail) => mail.accepted)).toHaveLength(
      rows.length - FAILURE_STREAK_LIMIT,
    );
  });

  // The fault is a stream's, and a campaign cannot tell: every mail is refused. Each stopped pass spends
  // one try of the ten mails it tried, and no other; none is rejected before its tries are used
  it('spends one try of ten mails on each stopped pass while every mail is refused, and rejects none before the tries are used', async () => {
    const now = dayOfTest();
    const audience = await audienceOfTens();
    const id = await scheduled(now);
    answerNewsletterMail(() => 400);

    const first = await stoppedPass(now, id);

    expect(first).toMatchObject({ sent: 0, rejected: 0, deferred: FAILURE_STREAK_LIMIT });
    let rows = await rowsOf(id);
    expect(rows).toHaveLength(audience);
    expect(rows.filter((row) => row.attempts === 1)).toHaveLength(FAILURE_STREAK_LIMIT);
    expect(rows.filter((row) => row.attempts === 0)).toHaveLength(audience - FAILURE_STREAK_LIMIT);

    // the rest of the first try: ten mails to a pass
    for (let tries = 1; tries <= 4; tries += 1) {
      const stops = await refusedRound(now, id, tries);

      expect(stops.length).toBeGreaterThanOrEqual(1);
      for (const stop of stops) {
        expect(stop).toMatchObject({ sent: 0, rejected: 0, deferred: FAILURE_STREAK_LIMIT });
      }
      rows = await rowsOf(id);
      // every mail has used the tries of the round, no more, and waits
      expect(rows.every((row) => row.status === 'queued' && row.attempts === tries)).toBe(true);
      expect(await campaignRowOf(id)).toMatchObject({ status: 'sending', rejectedCount: 0 });
    }

    // the stream is mended: everything goes on the next try, the last one the mails have
    answerNewsletterMail(() => undefined);
    await letLeasesRunOut(id);
    const mended = await pass(now, [id], { concurrency: 1 });

    expect(mended).toMatchObject({ reason: 'done', sent: audience, rejected: 0, finished: 1 });
    rows = await rowsOf(id);
    expect(rows.every((row) => row.status === 'sent' && row.attempts === 5)).toBe(true);
    expect(await campaignRowOf(id)).toMatchObject({ status: 'finished', rejectedCount: 0 });
    expect(await readSendingHalt()).toBeNull();
  });

  // The cost of a stream that refuses everything for good: a campaign that is small wears out. The
  // mails are rejected when their tries are used up, as a mail that dies on a try is
  it('rejects the mails of a small campaign once a stream that refuses everything has used their tries', async () => {
    const now = dayOfTest();
    const audience = await audienceOfTens();
    const id = await scheduled(now);
    answerNewsletterMail(() => 400);

    await stoppedPass(now, id);
    for (let tries = 1; tries <= 5; tries += 1) {
      await refusedRound(now, id, tries);
      const rows = await rowsOf(id);
      expect(rows.every((row) => row.status === 'queued' && row.attempts === tries)).toBe(true);
      expect(await campaignRowOf(id)).toMatchObject({ status: 'sending', rejectedCount: 0 });
    }

    // the last try is spent and the lease of the last try runs out: the next claim puts them away
    await letLeasesRunOut(id);
    const worn = await pass(now, [id], { concurrency: 1 });

    expect(worn).toMatchObject({ reason: 'done', claimed: 0, sent: 0, finished: 1 });
    const rows = await rowsOf(id);
    expect(rows.every((row) => row.status === 'rejected' && row.attempts === 5)).toBe(true);
    expect(await campaignRowOf(id)).toMatchObject({ status: 'finished', rejectedCount: audience });
  });

  // a mail refused again is the fault of the mail when the campaign sent a mail since its previous try,
  // even one taken earlier in the same pass: the mails not tried come before it, in the order of the queue
  it('rejects a mail at once when it is refused again and a mail was taken earlier in the same pass', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 8; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    expect((await pass(now, [id], { dailyLimit: 0 })).reason).toBe('daily_limit');
    const [tried, ...others] = await rowsOf(id);
    // the first mail of the queue has been tried once, and its lease has run out
    await inOwnerTx(
      (db) =>
        db.rows(
          `update cartlify.newsletter_recipients
           set attempts = 1, "updatedAt" = "updatedAt" - interval '11 minutes' where id = $1`,
          tried!.id,
        ),
      { commit: true },
    );
    answerNewsletterMail((mail) => (mail.to[0] === tried!.email ? 400 : undefined));

    const summary = await pass(now, [id], { concurrency: 1 });

    expect(summary).toMatchObject({
      reason: 'done',
      sent: others.length,
      rejected: 1,
      retried: 0,
      deferred: 0,
      finished: 1,
    });
    expect((await rowsOf(id))[0]).toMatchObject({ status: 'rejected', attempts: 2 });
    expect(await campaignRowOf(id)).toMatchObject({ status: 'finished', rejectedCount: 1 });
    takeLines('warn', 'newsletter mails were not taken by the provider');
  });

  // A mail the campaign sent before the previous try of a mail says nothing about it: the stream may
  // have broken since. Ten mails tried before and refused again, with no mail taken after their previous
  // try, are a run of refusals like any other and stop the pass
  it('counts the mails refused again toward the ten when no mail was taken since their previous try', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 12; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    expect((await pass(now, [id], { dailyLimit: 0 })).reason).toBe('daily_limit');
    const rows = await rowsOf(id);
    const tried = rows.slice(0, FAILURE_STREAK_LIMIT);
    const taken = rows.slice(FAILURE_STREAK_LIMIT);
    await inOwnerTx(
      async (db) => {
        // ten mails tried once, eleven minutes ago; every other mail taken two hours ago, before that
        await db.rows(
          `update cartlify.newsletter_recipients
           set attempts = 1, "updatedAt" = (now() at time zone 'utc') - interval '11 minutes'
           where id = any($1::int[])`,
          tried.map((row) => row.id),
        );
        await db.rows(
          `update cartlify.newsletter_recipients
           set status = 'sent', attempts = 1, "sentAt" = (now() at time zone 'utc') - interval '2 hours',
               "providerMessageId" = 'old-' || id::text,
               "updatedAt" = (now() at time zone 'utc') - interval '2 hours'
           where id = any($1::int[])`,
          taken.map((row) => row.id),
        );
      },
      { commit: true },
    );
    answerNewsletterMail(() => 400);

    const summary = await stoppedPass(now, id);

    expect(summary).toMatchObject({
      claimed: FAILURE_STREAK_LIMIT,
      sent: 0,
      rejected: 0,
      deferred: FAILURE_STREAK_LIMIT,
    });
    const after = (await rowsOf(id)).slice(0, FAILURE_STREAK_LIMIT);
    expect(after.every((row) => row.status === 'queued' && row.attempts === 2)).toBe(true);
  });

  // Ten tries in a row that find SendGrid busy or silent are a stream that is not there. Nothing was
  // judged, and the try each used is given back: the mails are as they were, free at once, in their place
  it.each([
    ['429', 429],
    ['500', 500],
    ['503', 503],
    ['no answer', 'unreachable' as const],
  ])(
    'stops the pass after many tries in a row that find SendGrid busy (%s), and gives them back with no try counted',
    async (_what, busy) => {
      const now = dayOfTest();
      for (let i = 0; i < 14; i += 1) await reader({ locale: 'en' });
      const id = await scheduled(now);
      answerNewsletterMail(() => busy);

      const summary = await pass(now, [id], { concurrency: 1 });

      expect(summary.reason).toBe('halted');
      const rows = await rowsOf(id);
      expect(summary).toMatchObject({
        sent: 0,
        rejected: 0,
        retried: 0,
        deferred: 0,
        released: rows.length,
      });
      expect(rows.every((row) => row.status === 'queued' && row.attempts === 0)).toBe(true);
      takeLines('warn', 'newsletter mails were not taken by the provider');
      expect(
        takeLines('error', 'newsletter pass stopped, the mails not tried stay queued')[0]!.fields,
      ).toMatchObject({ why: 'provider_unavailable' });
      expect(await readSendingHalt()).toEqual({ at: now, why: 'provider_unavailable' });

      // free at once, in the same place: the next pass takes the first ten again without waiting for a lease
      answerNewsletterMail(() => undefined);
      const next = await pass(now, [id], { concurrency: 1 });
      expect(next).toMatchObject({ reason: 'done', sent: rows.length });
      expect((await rowsOf(id)).every((row) => row.status === 'sent' && row.attempts === 1)).toBe(
        true,
      );
    },
  );

  // the mails the campaign made, each taken four times already (the leases have run out): the next try
  // is the last one, the one a mail is given up on
  async function onTheirLastTry(id: number): Promise<void> {
    expect((await pass(dayOfTest(), [id], { dailyLimit: 0 })).reason).toBe('daily_limit');
    await inOwnerTx(
      (db) =>
        db.rows(
          `update cartlify.newsletter_recipients
           set attempts = 4, "updatedAt" = "updatedAt" - interval '11 minutes'
           where "campaignId" = $1 and status = 'queued'`,
          id,
        ),
      { commit: true },
    );
  }

  // a mail on its last try that SendGrid finds busy is given up, unless the streak it is in is the fault
  // of the stream: then it goes back with the try it had, not given up
  it('does not give up a mail on its last try when many in a row find SendGrid busy: the stream is what is busy', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 12; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    await onTheirLastTry(id);
    answerNewsletterMail(() => 503);

    const summary = await pass(now, [id], { concurrency: 1 });

    expect(summary.reason).toBe('halted');
    expect(summary.rejected).toBe(0);
    const rows = await rowsOf(id);
    expect(rows.every((row) => row.status === 'queued' && row.attempts === 4)).toBe(true);
    expect((await campaignRowOf(id))!.rejectedCount).toBe(0);
    takeLines('warn', 'newsletter mails were not taken by the provider');
    takeLines('error', 'newsletter pass stopped, the mails not tried stay queued');
  });

  it('gives up a mail on its last try that SendGrid finds busy, when a few do and the rest are taken', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 12; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    await onTheirLastTry(id);
    answerNewsletterMail((_mail, index) => (index < 3 ? 503 : undefined));

    const summary = await pass(now, [id], { concurrency: 1 });

    expect(summary).toMatchObject({ reason: 'done', rejected: 3, released: 0 });
    const rows = await rowsOf(id);
    expect(rows.filter((row) => row.status === 'rejected')).toHaveLength(3);
    expect(rows.filter((row) => row.status === 'sent')).toHaveLength(rows.length - 3);
    expect((await campaignRowOf(id))!.rejectedCount).toBe(3);
    takeLines('warn', 'newsletter mails were not taken by the provider');
  });

  // fewer than ten in a row is no problem of the stream: the mails are rejected, as they always were,
  // when the pass ends with no mail taken after them
  it('rejects the mails refused in a row of fewer than ten, once a mail is taken after them', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 12; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    answerNewsletterMail((_mail, index) => (index < 9 ? 400 : undefined));

    const summary = await pass(now, [id], { concurrency: 1 });

    expect(summary).toMatchObject({ reason: 'done', rejected: 9, released: 0, finished: 1 });
    const rows = await rowsOf(id);
    expect(rows.filter((row) => row.status === 'rejected' && row.attempts === 1)).toHaveLength(9);
    expect(rows.filter((row) => row.status === 'sent')).toHaveLength(rows.length - 9);
    expect(await campaignRowOf(id)).toMatchObject({ status: 'finished', rejectedCount: 9 });
    takeLines('warn', 'newsletter mails were not taken by the provider');
    // no stop: nothing is wrong with the stream
    expect(await readSendingHalt()).toBeNull();
  });

  // ...or when the pass ends with none taken after them
  it('rejects the mails refused in a row of fewer than ten, when the pass ends and none is taken', async () => {
    const now = dayOfTest();
    const readers = [];
    for (let i = 0; i < 3; i += 1) readers.push(await reader({ locale: 'en' }));
    const id = await scheduled(now);
    // only the three readers of the test are refused; any other subscription of the shop is taken
    const mine = new Set(readers.map((who) => who.email));
    answerNewsletterMail((mail) => (mine.has(mail.to[0]!) ? 400 : undefined));

    const summary = await pass(now, [id], { concurrency: 1 });

    expect(summary).toMatchObject({ reason: 'done', rejected: 3, released: 0 });
    for (const who of readers) expect((await rowOf(id, who))?.status).toBe('rejected');
    takeLines('warn', 'newsletter mails were not taken by the provider');
  });

  // a mail SendGrid takes ends the streak: the refusals before it were the mails' own
  it('rejects the mails refused before a mail that was taken, and starts the count again after it', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 20; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    // nine refused, one taken, nine refused, the rest taken: no ten in a row anywhere
    answerNewsletterMail((_mail, index) => (index === 9 || index >= 19 ? undefined : 400));

    const summary = await pass(now, [id], { concurrency: 1 });

    expect(summary).toMatchObject({ reason: 'done', rejected: 18, released: 0 });
    const rows = await rowsOf(id);
    expect(rows.filter((row) => row.status === 'rejected')).toHaveLength(18);
    expect(rows.filter((row) => row.status === 'sent')).toHaveLength(rows.length - 18);
    expect(await campaignRowOf(id)).toMatchObject({
      rejectedCount: 18,
      sentCount: rows.length - 18,
    });
    takeLines('warn', 'newsletter mails were not taken by the provider');
  });

  // the streak is of the pass, not of a portion: ten in a row across portions are still ten
  it('counts the mails refused in a row across the portions', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 12; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    answerNewsletterMail(() => 400);

    const summary = await pass(now, [id], { concurrency: 1, batchSize: 4 });

    expect(summary.reason).toBe('halted');
    expect(summary).toMatchObject({ rejected: 0, sent: 0, deferred: FAILURE_STREAK_LIMIT });
    const rows = await rowsOf(id);
    // the ten of the three portions kept their try, the rest of the last portion went back
    expect(
      rows
        .slice(0, FAILURE_STREAK_LIMIT)
        .every((row) => row.status === 'queued' && row.attempts === 1),
    ).toBe(true);
    expect(
      rows
        .slice(FAILURE_STREAK_LIMIT)
        .every((row) => row.status === 'queued' && row.attempts === 0),
    ).toBe(true);
    takeLines('warn', 'newsletter mails were not taken by the provider');
    takeLines('error', 'newsletter pass stopped, the mails not tried stay queued');
  });

  // A problem of another kind (the key is refused) stops the pass too: the mails refused before it keep
  // their try, as in any stop, and the rest go back
  it('keeps the try of the mails refused before a problem of another kind stops the pass', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 6; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    // three refused, then the key is refused
    answerNewsletterMail((_mail, index) => (index < 3 ? 400 : 401));

    const summary = await pass(now, [id], { concurrency: 1 });

    expect(summary.reason).toBe('halted');
    const rows = await rowsOf(id);
    expect(summary).toMatchObject({
      rejected: 0,
      sent: 0,
      deferred: 3,
      released: summary.claimed - 3,
    });
    expect(rows.slice(0, 3).every((row) => row.status === 'queued' && row.attempts === 1)).toBe(
      true,
    );
    expect(rows.slice(3).every((row) => row.status === 'queued' && row.attempts === 0)).toBe(true);
    takeLines('warn', 'newsletter mails were not taken by the provider');
    expect(
      takeLines('error', 'newsletter pass stopped, the mails not tried stay queued')[0]!.fields,
    ).toMatchObject({ why: 'access_refused' });
  });

  // a stop of either run does the same with both kinds: the refused mails keep their try, the busy ones
  // and the ones not tried go back with theirs
  it('keeps the try of the refused mails and gives back the busy ones when many in a row find SendGrid busy', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 14; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    // three refused, then SendGrid is busy for the rest
    answerNewsletterMail((_mail, index) => (index < 3 ? 400 : 503));

    const summary = await pass(now, [id], { concurrency: 1 });

    expect(summary.reason).toBe('halted');
    const rows = await rowsOf(id);
    expect(summary).toMatchObject({
      sent: 0,
      rejected: 0,
      retried: 0,
      deferred: 3,
      released: summary.claimed - 3,
    });
    expect(rows.slice(0, 3).every((row) => row.status === 'queued' && row.attempts === 1)).toBe(
      true,
    );
    expect(rows.slice(3).every((row) => row.status === 'queued' && row.attempts === 0)).toBe(true);
    takeLines('warn', 'newsletter mails were not taken by the provider');
    expect(
      takeLines('error', 'newsletter pass stopped, the mails not tried stay queued')[0]!.fields,
    ).toMatchObject({ why: 'provider_unavailable' });
  });

  // five mails go at once: the tenth refusal halts the pass while a mail that started before it is
  // still with SendGrid. That mail is taken, and it is written down as sent, but the mails held are not
  // judged by it: a halted stream rejects nothing, the refused keep their try and the rest go back
  it('does not reject the mails held when a mail that was already on its way is taken after the halt', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 14; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();
    const late = deferred();
    // the first mail to reach SendGrid waits there; the next ten are refused, and a moment after the
    // tenth the first is taken (the refusal has long been held by then: only promises are in between)
    answerNewsletterMail(async (_mail, index) => {
      if (index === 0) {
        await late.promise;
        return undefined;
      }
      if (index === 10) setTimeout(() => late.resolve(), 300);
      return 400;
    });

    const summary = await pass(now, [id], { concurrency: 5 });

    expect(summary.reason).toBe('halted');
    const rows = await rowsOf(id);
    expect(rows.length).toBeGreaterThanOrEqual(14);
    expect(sent.filter((mail) => mail.accepted)).toHaveLength(1);
    // the mail that was taken is written down; nothing is rejected; the mails refused (the ten, and the
    // ones that were on their way with them) keep their try, all the rest wait as they were
    const kept = rows.filter((row) => row.status === 'queued' && row.attempts === 1);
    expect(kept.length).toBeGreaterThanOrEqual(FAILURE_STREAK_LIMIT);
    expect(summary).toMatchObject({
      sent: 1,
      rejected: 0,
      retried: 0,
      deferred: kept.length,
      released: summary.claimed - 1 - kept.length,
    });
    expect(rows.filter((row) => row.status === 'sent')).toHaveLength(1);
    expect(rows.filter((row) => row.status !== 'sent' && row.status !== 'queued')).toEqual([]);
    expect(
      rows
        .filter((row) => row.status === 'queued' && row.attempts !== 1)
        .every((row) => row.attempts === 0),
    ).toBe(true);
    expect(await campaignRowOf(id)).toMatchObject({
      status: 'sending',
      rejectedCount: 0,
      sentCount: 1,
    });
    takeLines('warn', 'newsletter mails were not taken by the provider');
    expect(
      takeLines('error', 'newsletter pass stopped, the mails not tried stay queued')[0]!.fields,
    ).toMatchObject({ why: 'every_mail_refused' });
  });

  describe('the mark of the stop, for the alert', () => {
    it('is written with the time of the pass and why it stopped, and written over by the next stop', async () => {
      const now = dayOfTest();
      const later = new Date(now.getTime() + 3_600_000);
      await reader({ locale: 'en' });
      const id = await scheduled(now);
      answerNewsletterMail(() => 401);

      await pass(now, [id]);
      expect(await readSendingHalt()).toEqual({ at: now, why: 'access_refused' });

      await pass(later, [id]);
      expect(await readSendingHalt()).toEqual({ at: later, why: 'access_refused' });
      takeLines('error', 'newsletter pass stopped, the mails not tried stay queued');
    });

    it('is taken away by a pass that took a mail', async () => {
      const now = dayOfTest();
      await reader({ locale: 'en' });
      const id = await scheduled(now);

      await markSendingHalted('stream_broken', now);
      expect(await pass(now, [id])).toMatchObject({ reason: 'done', sent: 1 });
      expect(await readSendingHalt()).toBeNull();
    });

    it('is taken away by a pass that finds no mail of a sending campaign left in the queue', async () => {
      const now = dayOfTest();
      await reader({ locale: 'en' });
      const id = await scheduled(now);
      expect(await pass(now, [id])).toMatchObject({ sent: 1, finished: 1 });

      // nothing waits now: the pass has sent nothing, but nothing is held up either
      await markSendingHalted('stream_broken', now);
      expect(await pass(now, [id])).toMatchObject({ reason: 'done', claimed: 0, sent: 0 });
      expect(await readSendingHalt()).toBeNull();
    });

    // the queue is not empty, the claim is: the mails that wait are leased to a try that is not over.
    // SendGrid was busy again, so the pass has proved nothing and the alert stays until a mail is taken
    it('is left by a pass that sent nothing while mails still wait: all busy again, or still leased', async () => {
      const now = dayOfTest();
      const who = await reader({ locale: 'en' });
      const id = await scheduled(now);
      const busy = watchNewsletterMail();
      answerNewsletterMail(() => 503);
      await markSendingHalted('stream_broken', now);

      // the claim takes the mail, SendGrid is busy: it waits under its lease
      const first = await pass(now, [id]);
      expect(first).toMatchObject({ reason: 'done', sent: 0, retried: 1, finished: 0 });
      takeLines('warn', 'newsletter mails were not taken by the provider');
      expect(await readSendingHalt()).toEqual({ at: now, why: 'stream_broken' });

      // while the lease holds the claim is empty and the mail still waits
      const second = await pass(now, [id]);
      expect(second).toMatchObject({ reason: 'done', claimed: 0, sent: 0 });
      expect(await readSendingHalt()).toEqual({ at: now, why: 'stream_broken' });
      expect(busy).toHaveLength(1);

      // once SendGrid takes a mail the alert goes
      await letLeaseRunOut((await rowOf(id, who))!.id);
      answerNewsletterMail(() => undefined);
      expect(await pass(now, [id])).toMatchObject({ sent: 1, finished: 1 });
      expect(await readSendingHalt()).toBeNull();
    });

    it('is left by a pass that proved nothing: the limit of the day spent, the time up at once', async () => {
      const now = dayOfTest();
      await reader({ locale: 'en' });
      const id = await scheduled(now);
      await markSendingHalted('stream_broken', now);

      expect((await pass(now, [id], { dailyLimit: 0 })).reason).toBe('daily_limit');
      expect(await readSendingHalt()).toEqual({ at: now, why: 'stream_broken' });

      expect((await pass(now, [id], { deadlineMs: 0 })).reason).toBe('deadline');
      expect(await readSendingHalt()).toEqual({ at: now, why: 'stream_broken' });
    });

    it('is left by a pass that finds the lock held by another', async () => {
      const now = dayOfTest();
      await reader({ locale: 'en' });
      const id = await scheduled(now);
      await markSendingHalted('stream_broken', now);
      const reached = deferred();
      const release = deferred();
      answerNewsletterMail(async (_mail, index) => {
        if (index === 0) {
          reached.resolve();
          await release.promise;
        }
        return 401;
      });
      const running = pass(now, [id]);
      await reached.promise;

      expect((await pass(now, [id])).reason).toBe('locked');
      expect(await readSendingHalt()).toEqual({ at: now, why: 'stream_broken' });

      release.resolve();
      await running;
      takeLines('error', 'newsletter pass stopped, the mails not tried stay queued');
    });
  });
});

// ---- the database fails while the outcome of a mail is written down ----

// The write of one outcome is made to fail for the length of `run` (a trigger the test puts on the
// table, as in localeReset.shopwide): the rows of the campaign cannot move to the state given
async function whileWriteFails<T>(
  campaign: number,
  status: 'sent' | 'rejected',
  run: () => Promise<T>,
): Promise<T> {
  await inOwnerTx(
    async (db) => {
      await db.rows(`
        create function cartlify.test_fail_mail_outcome() returns trigger
        language plpgsql as $$ begin raise exception 'TEST_MAIL_OUTCOME_FAILS'; end $$`);
      await db.rows(`
        create trigger test_fail_mail_outcome before update of status on cartlify.newsletter_recipients
        for each row when (new."campaignId" = ${campaign} and new.status = '${status}')
        execute function cartlify.test_fail_mail_outcome()`);
    },
    { commit: true },
  );

  try {
    return await run();
  } finally {
    await inOwnerTx(
      async (db) => {
        await db.rows(
          'drop trigger if exists test_fail_mail_outcome on cartlify.newsletter_recipients',
        );
        await db.rows('drop function if exists cartlify.test_fail_mail_outcome()');
      },
      { commit: true },
    );
  }
}

describe('when the database fails while a mail is written down', () => {
  const stopped = () =>
    takeLines('error', 'newsletter pass stopped, the mails not tried stay queued')[0]!.fields;

  // a mail SendGrid took is on its way to the reader: nothing the pass does afterwards may send it again
  // at once. A refusal held before it is judged when it is taken, and that write fails: the pass stops,
  // and the refused mail keeps its try, as in any stop
  it('never sends a mail again that SendGrid took, when the refusals held before it cannot be written down', async () => {
    const now = dayOfTest();
    const readers: Arranged[] = [];
    for (let i = 0; i < 3; i += 1) readers.push(await reader({ locale: 'en' }));
    const id = await scheduled(now);
    const sent = watchNewsletterMail();
    // the first mail is refused and held, the next is taken
    answerNewsletterMail((_mail, index) => (index === 0 ? 400 : undefined));

    const first = await whileWriteFails(id, 'rejected', () => pass(now, [id], { concurrency: 1 }));

    expect(first.reason).toBe('halted');
    expect(stopped()).toMatchObject({ why: 'database_failed' });
    takeLines('warn', 'newsletter mails were not taken by the provider');
    const taken = sent.filter((mail) => mail.accepted).map((mail) => mail.to[0]!);
    expect(taken).toHaveLength(1);
    // the mail that went is written down as sent, however the rest ended
    const [gone] = readers.filter((who) => who.email === taken[0]);
    expect(gone).toBeDefined();
    expect(await rowOf(id, gone!)).toMatchObject({ status: 'sent', attempts: 1 });
    expect((await campaignRowOf(id))!.sentCount).toBe(1);

    // the refused mail kept its try and waits out its lease; the others had not been tried
    const before = await rowsOf(id);
    const waiting = before.filter((row) => row.status === 'queued');
    expect(waiting.filter((row) => row.attempts === 1)).toHaveLength(1);

    // the database is well again: the rest go, and the one that went is not sent a second time
    const next = await pass(now, [id]);

    expect(next).toMatchObject({ reason: 'done', finished: 0, rejected: 0 });
    // all but the mail that went and the mail that was refused
    expect(next.sent).toBe(before.length - 2);
    expect(await rowsOf(id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'queued', attempts: 1 })]),
    );

    // and once its lease has run out the refused mail is tried again, and taken
    await letLeaseRunOut(waiting.find((row) => row.attempts === 1)!.id);
    expect(await pass(now, [id])).toMatchObject({
      reason: 'done',
      sent: 1,
      finished: 1,
      rejected: 0,
    });
    for (const who of readers) {
      expect(gotBy(sent, id, who).filter((mail) => mail.accepted)).toHaveLength(1);
    }
    expect((await rowsOf(id)).every((row) => row.status === 'sent')).toBe(true);
  });

  // ...or the write of the mail itself fails: it stays under the lease of its try. It is not given back
  // to be sent again at once; once the lease runs out it is tried again (a mail is sent at least once,
  // the limit docs/newsletters.md names)
  it('leaves a mail SendGrid took under its lease when it cannot be written down: not sent again at once', async () => {
    const now = dayOfTest();
    const who = await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();

    const first = await whileWriteFails(id, 'sent', () => pass(now, [id]));

    expect(first.reason).toBe('halted');
    expect(stopped()).toMatchObject({ why: 'database_failed' });
    expect(gotBy(sent, id, who).filter((mail) => mail.accepted)).toHaveLength(1);
    expect(await rowOf(id, who)).toMatchObject({ status: 'queued', attempts: 1 });

    // the lease holds: another pass takes nothing, and the reader has one mail
    const idle = await pass(now, [id]);
    expect(idle).toMatchObject({ claimed: 0, sent: 0 });
    expect(gotBy(sent, id, who).filter((mail) => mail.accepted)).toHaveLength(1);

    // when it has run out the mail is tried again: the documented limit of a mail sent at least once
    await letLeaseRunOut((await rowOf(id, who))!.id);
    expect(await pass(now, [id])).toMatchObject({ sent: 1, finished: 1 });
    expect(gotBy(sent, id, who).filter((mail) => mail.accepted)).toHaveLength(2);
  });
});

// ---- stopping a campaign, two passes, the reports of SendGrid ----

describe('while a campaign is being sent', () => {
  it('sends no more of a campaign that was stopped, not even the rest of the portion', async () => {
    const now = dayOfTest();
    for (let i = 0; i < 6; i += 1) await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();

    // the manager stops the campaign while the second mail is on its way
    answerNewsletterMail(async (_mail, index) => {
      if (index === 1) {
        const stop = await api.stop(staff.manager, id);
        expect(stop.statusCode).toBe(200);
      }
      return undefined;
    });

    const summary = await pass(now, [id], { concurrency: 1, batchSize: 5 });

    // the two mails that were sent, and the three left of the portion given back, not tried
    expect(ofCampaign(sent, id)).toHaveLength(2);
    expect(summary).toMatchObject({ sent: 2, released: 3, reason: 'done', finished: 0 });

    const campaign = (await campaignRowOf(id))!;
    // the mail that was on its way when it was stopped is counted
    expect(campaign).toMatchObject({ status: 'stopped', sentCount: 2 });
    const waiting = (await rowsOf(id)).filter((row) => row.status === 'queued');
    expect(waiting.length).toBeGreaterThanOrEqual(3);
    expect(waiting.every((row) => row.attempts === 0)).toBe(true);

    // and no later pass sends the rest
    await pass(nextDayOf(now), [id]);
    expect(ofCampaign(sent, id)).toHaveLength(2);
    expect((await campaignRowOf(id))!.status).toBe('stopped');
  });

  it('runs one pass at a time: a second pass finds the lock held and ends at once', async () => {
    const now = dayOfTest();
    const who = await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();
    const reached = deferred();
    const release = deferred();

    answerNewsletterMail(async (_mail, index) => {
      if (index === 0) {
        reached.resolve();
        await release.promise;
      }
      return undefined;
    });

    const running = pass(now, [id]);
    await reached.promise;

    const second = await pass(now, [id]);
    expect(second).toEqual({
      reason: 'locked',
      launched: 0,
      cancelled: 0,
      claimed: 0,
      sent: 0,
      rejected: 0,
      retried: 0,
      skipped: 0,
      released: 0,
      deferred: 0,
      finished: 0,
    });
    expect(
      lines.some((line) => line.msg === 'newsletter pass skipped, another pass is running'),
    ).toBe(true);

    release.resolve();
    const first = await running;

    expect(first.reason).toBe('done');
    expect(gotBy(sent, id, who)).toHaveLength(1);
    const mails = ofCampaign(sent, id);
    expect(new Set(mails.map((mail) => mail.to[0])).size).toBe(mails.length);

    // the lock is let go at the end: the next pass runs
    const third = await pass(now, [id]);
    expect(third.reason).toBe('done');
  });

  it('lets go of the lock when the pass stops on a problem', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    const id = await scheduled(now);
    answerNewsletterMail(() => 401);

    expect((await pass(now, [id])).reason).toBe('halted');
    takeLines('error', 'newsletter pass stopped, the mails not tried stay queued');

    answerNewsletterMail(() => undefined);
    expect((await pass(now, [id])).reason).toBe('done');
  });

  // the Event Webhook hears of the mail the way SendGrid reports it: with the custom arguments the pass
  // put on the mail, so the event finds its recipient and this environment recognises it as its own
  it('is told of a bounce of a mail it sent, by the arguments that rode on the mail', async () => {
    const now = dayOfTest();
    const who = await reader({ locale: 'en' });
    const other = await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();

    await pass(now, [id]);

    // SendGrid reports a bounce of a mail with the id it gave the mail (and a suffix) and the custom
    // arguments of the mail on the same level as its own fields
    const reportOf = (to: Arranged, over: Record<string, unknown> = {}) => {
      const mail = gotBy(sent, id, to)[0]!;
      return {
        email: to.email,
        event: 'bounce',
        type: 'bounce',
        sg_message_id: `${mail.messageId}.filter0001.1.0`,
        ...mail.customArgs,
        ...over,
      };
    };

    const res = await deliverEvents(app, [reportOf(who)]);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true, applied: 1, skipped: 0 });
    expect((await rowOf(id, who))!.status).toBe('bounced');
    expect((await rowOf(id, other))!.status).toBe('sent');
    expect((await subscriptionsOf(who.email))[0]).toMatchObject({
      status: 'stopped_bounce',
      endReason: 'bounced',
    });
    expect((await subscriptionsOf(other.email))[0]).toMatchObject({ status: 'active' });
    expect((await campaignRowOf(id))!.undeliveredCount).toBe(1);

    // the same report for the other reader, but of a mail another environment of the account sent
    const foreign = await deliverEvents(app, [reportOf(other, { environment: 'prod' })]);

    expect(foreign.json()).toEqual({ received: true, applied: 0, skipped: 1 });
    expect((await rowOf(id, other))!.status).toBe('sent');
    expect((await subscriptionsOf(other.email))[0]).toMatchObject({ status: 'active' });
  });

  it('counts a mail once, as sent, when the report of SendGrid on it comes before the answer is written', async () => {
    const now = dayOfTest();
    const who = await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();

    // SendGrid reports the bounce of this mail before its own answer reaches the pass
    answerNewsletterMail(async (mail) => {
      if (mail.to[0] !== who.email) return undefined;
      await asAdmin(
        (tx) =>
          tx.$queryRaw`select cartlify.newsletter_apply_event(${Number(mail.customArgs.recipientId)}::int, 'bounce') as result`,
      );
      return undefined;
    });

    await pass(now, [id]);

    const mail = gotBy(sent, id, who)[0]!;
    const row = (await rowOf(id, who))!;
    // the report decided the status; the pass put the id in and kept its hands off the status
    expect(row.status).toBe('bounced');
    expect(row.messageId).toBe(mail.messageId);
    expect(row.attempts).toBe(1);

    const campaign = (await campaignRowOf(id))!;
    expect(campaign.undeliveredCount).toBe(1);
    expect(campaign.sentCount).toBe(campaign.plannedCount);
    expect(campaign.status).toBe('finished');
  });
});

// ---- the clock, the time, the logs ----

describe('the time of the pass', () => {
  it('stops taking portions when its time is up, and starts nothing it cannot finish', async () => {
    const now = dayOfTest();
    await reader({ locale: 'en' });
    const id = await scheduled(now);
    const sent = watchNewsletterMail();

    const summary = await pass(now, [id], { deadlineMs: 0 });

    expect(summary).toMatchObject({
      reason: 'deadline',
      launched: 1,
      claimed: 0,
      sent: 0,
      finished: 0,
    });
    expect(ofCampaign(sent, id)).toEqual([]);
    expect((await campaignRowOf(id))!.status).toBe('sending');

    // the next pass takes it from there
    const next = await pass(now, [id]);
    expect(next).toMatchObject({ reason: 'done', launched: 0, finished: 1 });
  });
});

describe('what the pass logs', () => {
  it('names campaigns and counts, never an address, a token, a key or a text', async () => {
    const now = dayOfTest();
    const who = await reader({ locale: 'en' });
    const failing = await reader({ locale: 'es' });
    const id = await scheduled(now, { tag: 'Logged' });
    answerNewsletterMail((mail) => {
      if (mail.to[0] === who.email) return 400;
      if (mail.to[0] === failing.email) return 500;
      return undefined;
    });

    await pass(now, [id]);
    const warned = takeLines('warn', 'newsletter mails were not taken by the provider');
    expect(warned).toHaveLength(1);

    // the fields the pass logged: only ids and counters
    const text = JSON.stringify(lines.concat(warned.map((line) => ({ ...line }))));
    for (const secret of [
      who.email,
      failing.email,
      who.manageToken,
      failing.manageToken,
      manageHashOf(who.manageToken),
      process.env.SENDGRID_NEWSLETTER_API_KEY ?? '',
      'Logged',
      'Rebajas',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(warned[0]!.fields).toEqual({ failures: expect.any(Object) });
    expect(lines.find((line) => line.msg === 'newsletter campaign started')!.fields).toEqual({
      campaignId: id,
      planned: expect.any(Number),
    });
    expect(lines.find((line) => line.msg === 'newsletter pass finished')!.fields).toMatchObject({
      reason: 'done',
      launched: 1,
    });
  });
});
