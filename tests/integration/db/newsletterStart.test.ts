import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inCommittedTx, type Actor, type DbSession } from '../../helpers/db.js';
import { interleave } from '../../helpers/interleave.js';
import {
  campaignIn,
  draftCampaignIn,
  insertRow,
  insertSubscription,
  moveCampaignTo,
  removeNewsletterFixtures,
  removeSubscriptionRows,
  setupNewsletterFixtures,
  type CampaignState,
  type NewsletterFixtures,
  type SubscriptionStatus,
} from '../../helpers/newsletterDb.js';
import {
  GUEST,
  READER,
  SQL,
  SYSTEM,
  attemptAs,
  callAs,
  codeOf,
  dbNow,
  near,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx, type OwnerSession } from '../../helpers/ownerDb.js';

// the start of a campaign (cartlify.newsletter_start_campaign): the system turns a scheduled
// campaign into a sending one and makes the list of mails, one row for each subscription in force at
// that moment, in the language the person is mailed in. A campaign that was started cannot be left in
// the database (only a draft is deleted), so the cases make their rows in a session of the owner of
// the database that rolls back; the two cases of a race need committed rows and clean up after
// themselves

let fx: NewsletterFixtures;
const startedForReal: number[] = [];

beforeAll(async () => {
  fx = await setupNewsletterFixtures();
});

afterAll(async () => {
  try {
    if (startedForReal.length) {
      // the campaigns the race cases started stay in the database, finished and without mails
      await inOwnerTx(
        async (db) => {
          await db.rows(
            'delete from cartlify.newsletter_recipients where "campaignId" = any($1::int[])',
            startedForReal,
          );
          await db.as(SYSTEM);
          await db.rows(
            `update cartlify.newsletter_campaigns
             set status = 'finished', "finishedAt" = (now() at time zone 'utc')
             where id = any($1::int[]) and status = 'sending'`,
            startedForReal,
          );
        },
        { commit: true },
      );
    }
    if (fx) await removeNewsletterFixtures(fx);
  } finally {
    await prisma.$disconnect();
  }
});

const MANAGER = (): Actor => ({ role: 'ADMIN', userId: fx.manager.id });
const ROOT = (): Actor => ({ role: 'ROOT', userId: fx.root.id });

const SNAPSHOT = { takenAt: '2026-11-09T10:00:00.000Z', currency: 'EUR', blocks: [] };

// the text of a campaign with a subject in each language given (the preview and the blocks are of
// no interest to the start)
const contentWith = (subject: Record<string, unknown>) => ({
  subject,
  preview: {},
  blocks: [{ type: 'text', text: { en: 'Hello' } }],
});

// a campaign that is scheduled for a moment before the transaction
const scheduledCampaign = (
  db: OwnerSession,
  set: Parameters<typeof campaignIn>[4] = {},
  state: CampaignState = 'scheduled',
) => campaignIn(db, MANAGER(), state, undefined, set);

const start = (
  db: OwnerSession,
  actor: Actor | null,
  campaign: number | null,
  snapshot: unknown = SNAPSHOT,
  shopLocale: string | null = 'en',
) =>
  attemptAs<{ planned: number }>(
    db,
    actor,
    SQL.startCampaign,
    campaign,
    snapshot === null ? null : JSON.stringify(snapshot),
    shopLocale,
  );

// a draft the manager made, in an owner session
async function draftIn(db: OwnerSession): Promise<number> {
  await db.as(MANAGER());
  return insertRow(db, 'newsletter_campaigns', {
    name: 'A draft',
    missingLocale: 'shop_locale',
    content: JSON.stringify(contentWith({ en: 'Hi' })),
    createdById: fx.manager.id,
    updatedById: fx.manager.id,
  });
}

type MailRow = { id: number; subscriptionId: number; locale: string; status: string };

// the mails of a campaign, oldest first (read as root)
const mailsOf = (db: OwnerSession, campaign: number) =>
  callAs<MailRow>(
    db,
    READER,
    `select id, "subscriptionId", locale, status::text as status
     from cartlify.newsletter_recipients where "campaignId" = $1 order by id`,
    campaign,
  );

type CampaignRow = {
  status: string;
  startedAt: Date | null;
  scheduledAt: Date | null;
  plannedCount: number;
  sentCount: number;
  productsSnapshot: unknown;
};

const campaignRow = async (db: OwnerSession, id: number): Promise<CampaignRow> => {
  const [row] = await callAs<CampaignRow>(
    db,
    READER,
    `select status::text as status, "startedAt", "scheduledAt", "plannedCount", "sentCount",
            "productsSnapshot"
     from cartlify.newsletter_campaigns where id = $1`,
    id,
  );
  return row!;
};

describe('who may start a campaign', () => {
  const ACTORS: [string, () => Actor | null][] = [
    ['a guest', () => GUEST()],
    ['no actor', () => null],
    ['a buyer', () => ({ role: 'USER', userId: fx.stranger.id })],
    [
      'an admin without the right to run the newsletters',
      () => ({ role: 'ADMIN', userId: fx.plainAdmin.id }),
    ],
    ['an admin with the right to run the newsletters', MANAGER],
    ['root with an account', ROOT],
    ['root without an account', () => ({ role: 'ROOT' })],
  ];

  it.each(ACTORS)('refuses %s and changes nothing', async (_who, actor) => {
    const { outcome, campaign, mails } = await inOwnerTx(async (db) => {
      await insertSubscription(db, { locale: 'en' });
      const id = await scheduledCampaign(db);
      const outcome = await start(db, actor(), id);

      return { outcome, campaign: await campaignRow(db, id), mails: await mailsOf(db, id) };
    });

    expect(codeOf(outcome)).toBe('NEWSLETTER_FORBIDDEN');
    expect(campaign.status).toBe('scheduled');
    expect(campaign.productsSnapshot).toBeNull();
    expect(mails).toEqual([]);
  });

  it('lets the system start it', async () => {
    const outcome = await inOwnerTx(async (db) => start(db, SYSTEM, await scheduledCampaign(db)));

    expect(outcome.ok).toBe(true);
  });
});

describe('the mails a start makes', () => {
  it('makes one for each subscription in force, and none for the rest', async () => {
    const STATES: SubscriptionStatus[] = [
      'pending',
      'active',
      'paused_complaint',
      'stopped_bounce',
      'ended',
    ];

    const { rows, campaign, planned, byState } = await inOwnerTx(async (db) => {
      const byState = new Map<number, string>();
      for (const status of STATES) {
        const id = await insertSubscription(db, { status, locale: 'en' });
        byState.set(id, status);
      }
      const account = await insertSubscription(db, {
        source: 'account',
        userId: fx.stranger.id,
        email: fx.stranger.email,
        locale: 'en',
      });
      byState.set(account, 'active (account)');

      const id = await scheduledCampaign(db);
      const outcome = await start(db, SYSTEM, id);
      if (!outcome.ok) throw new Error(`the start was refused: ${codeOf(outcome)}`);

      return {
        rows: await mailsOf(db, id),
        campaign: await campaignRow(db, id),
        planned: outcome.rows[0]!.planned,
        byState,
      };
    });

    // the subscriptions of this case that got a mail: the one in force of each source, nobody else
    const got = rows
      .filter((row) => byState.has(row.subscriptionId))
      .map((row) => byState.get(row.subscriptionId));
    expect(got.sort()).toEqual(['active', 'active (account)']);
    expect(rows.every((row) => row.status === 'queued')).toBe(true);

    // other test files commit subscriptions of their own: the count is the one of the rows made
    expect(planned).toBe(rows.length);
    expect(campaign.plannedCount).toBe(rows.length);
  });

  it('lists the people in the order of their subscriptions', async () => {
    const { ids, rows } = await inOwnerTx(async (db) => {
      const ids: number[] = [];
      for (let i = 0; i < 4; i += 1) ids.push(await insertSubscription(db, { locale: 'en' }));

      const id = await scheduledCampaign(db);
      await start(db, SYSTEM, id);

      return { ids, rows: await mailsOf(db, id) };
    });

    expect(rows.map((row) => row.subscriptionId)).toEqual(
      [...rows.map((row) => row.subscriptionId)].sort((a, b) => a - b),
    );
    expect(rows.map((row) => row.id)).toEqual([...rows.map((row) => row.id)].sort((a, b) => a - b));
    expect(rows.filter((row) => ids.includes(row.subscriptionId))).toHaveLength(4);
  });

  it('makes a mail of its own for the same person in each campaign', async () => {
    const { first, second, subscription } = await inOwnerTx(async (db) => {
      const subscription = await insertSubscription(db, { locale: 'en' });
      const one = await scheduledCampaign(db);
      const two = await scheduledCampaign(db);
      await start(db, SYSTEM, one);
      await start(db, SYSTEM, two);

      return { first: await mailsOf(db, one), second: await mailsOf(db, two), subscription };
    });

    expect(first.filter((row) => row.subscriptionId === subscription)).toHaveLength(1);
    expect(second.filter((row) => row.subscriptionId === subscription)).toHaveLength(1);
  });

  it('puts the campaign in sending with its moment, its data and the number planned', async () => {
    const { before, after, now } = await inOwnerTx(async (db) => {
      await insertSubscription(db, { locale: 'en' });
      const id = await scheduledCampaign(db);
      const before = await campaignRow(db, id);
      await start(db, SYSTEM, id, SNAPSHOT);

      return { before, after: await campaignRow(db, id), now: await dbNow(db) };
    });

    expect(before).toMatchObject({ status: 'scheduled', startedAt: null, plannedCount: 0 });
    expect(after.status).toBe('sending');
    expect(near(after.startedAt, now)).toBe(true);
    expect(after.productsSnapshot).toEqual(SNAPSHOT);
    expect(after.plannedCount).toBeGreaterThanOrEqual(1);
    expect(after.sentCount).toBe(0);
    // the time it was scheduled for is left as it was
    expect(after.scheduledAt).toEqual(before.scheduledAt);
  });
});

describe('the language of a mail', () => {
  // [what the case says, the subjects the campaign has, the rule for the rest, the shop language,
  // the language of the subscription, the language of the mail (null: no mail)]
  const CASES: [
    string,
    Record<string, unknown>,
    'shop_locale' | 'skip',
    string,
    string | null,
    string | null,
  ][] = [
    ['a language the campaign has', { en: 'Hi', es: 'Hola' }, 'shop_locale', 'en', 'es', 'es'],
    [
      'a language the campaign has, with the rule skip',
      { en: 'Hi', es: 'Hola' },
      'skip',
      'en',
      'es',
      'es',
    ],
    [
      'the shop language of a person who has one',
      { en: 'Hi', es: 'Hola' },
      'skip',
      'en',
      'en',
      'en',
    ],
    [
      'no language: the language of the shop',
      { en: 'Hi', es: 'Hola' },
      'shop_locale',
      'en',
      null,
      'en',
    ],
    [
      'no language, with the rule skip: the language of the shop all the same',
      { en: 'Hi', es: 'Hola' },
      'skip',
      'en',
      null,
      'en',
    ],
    [
      'no language, another language of the shop',
      { en: 'Hi', es: 'Hola' },
      'skip',
      'es',
      null,
      'es',
    ],
    [
      'a language the campaign lacks, rule shop_locale',
      { en: 'Hi', es: 'Hola' },
      'shop_locale',
      'en',
      'uk',
      'en',
    ],
    [
      'a language the campaign lacks, rule skip',
      { en: 'Hi', es: 'Hola' },
      'skip',
      'en',
      'uk',
      null,
    ],
    [
      'no language, no text in the language of the shop, rule shop_locale',
      { es: 'Hola' },
      'shop_locale',
      'en',
      null,
      null,
    ],
    [
      'no language, no text in the language of the shop, rule skip',
      { es: 'Hola' },
      'skip',
      'en',
      null,
      null,
    ],
    [
      'a language the campaign lacks, and none in the shop language',
      { es: 'Hola' },
      'shop_locale',
      'en',
      'uk',
      null,
    ],
    [
      'a blank subject is no subject (rule shop_locale)',
      { en: 'Hi', es: '   ' },
      'shop_locale',
      'en',
      'es',
      'en',
    ],
    [
      'a blank subject is no subject (rule skip)',
      { en: 'Hi', es: '   ' },
      'skip',
      'en',
      'es',
      null,
    ],
    [
      'a subject that is null is no subject',
      { en: 'Hi', es: null },
      'shop_locale',
      'en',
      'es',
      'en',
    ],
    ['a subject that is not a text is no subject', { en: 'Hi', es: 5 }, 'skip', 'en', 'es', null],
  ];

  it.each(CASES)('%s', async (_what, subject, rule, shop, subscriber, expected) => {
    const mails = await inOwnerTx(async (db) => {
      const subscription = await insertSubscription(db, { locale: subscriber });
      const id = await scheduledCampaign(db, {
        content: contentWith(subject),
        missingLocale: rule,
      });
      const outcome = await start(db, SYSTEM, id, SNAPSHOT, shop);
      if (!outcome.ok) throw new Error(`the start was refused: ${codeOf(outcome)}`);

      return (await mailsOf(db, id)).filter((row) => row.subscriptionId === subscription);
    });

    expect(mails.map((row) => row.locale)).toEqual(expected === null ? [] : [expected]);
  });
});

describe('what a start refuses', () => {
  const REFUSED: [string, CampaignState | 'draft'][] = [
    ['a draft', 'draft'],
    ['a campaign that is sending already', 'sending'],
    ['a finished campaign', 'finished'],
    ['a stopped campaign', 'stopped'],
    ['a cancelled campaign', 'cancelled'],
  ];

  it.each(REFUSED)('refuses %s and makes no mail', async (_what, state) => {
    const { outcome, before, after, mails } = await inOwnerTx(async (db) => {
      await insertSubscription(db, { locale: 'en' });
      const id = state === 'draft' ? await draftIn(db) : await scheduledCampaign(db, {}, state);
      const before = await campaignRow(db, id);
      const outcome = await start(db, SYSTEM, id);

      return { outcome, before, after: await campaignRow(db, id), mails: await mailsOf(db, id) };
    });

    expect(codeOf(outcome)).toBe('NEWSLETTER_CAMPAIGN_NOT_SCHEDULED');
    expect(after).toEqual(before);
    expect(mails).toEqual([]);
  });

  it('refuses a campaign there is none of', async () => {
    const outcome = await inOwnerTx(async (db) => start(db, SYSTEM, 2_000_000_000));

    expect(codeOf(outcome)).toBe('NEWSLETTER_CAMPAIGN_NOT_FOUND');
  });

  it.each([
    ['no data of products', null],
    ['a list as the data of products', []],
    ['a text as the data of products', 'snapshot'],
    ['a number as the data of products', 5],
  ] as [string, unknown][])('refuses %s', async (_what, snapshot) => {
    const { outcome, campaign } = await inOwnerTx(async (db) => {
      const id = await scheduledCampaign(db);
      const outcome = await start(db, SYSTEM, id, snapshot);

      return { outcome, campaign: await campaignRow(db, id) };
    });

    expect(codeOf(outcome)).toBe('NEWSLETTER_SNAPSHOT_INVALID');
    expect(campaign.status).toBe('scheduled');
  });

  it.each([
    ['no language of the shop', null],
    ['an empty one', ''],
    ['a capital', 'EN'],
    ['three letters', 'eng'],
    ['a region', 'en-GB'],
    ['a number', '12'],
  ] as [string, string | null][])('refuses %s as the language of the shop', async (_what, shop) => {
    const { outcome, campaign } = await inOwnerTx(async (db) => {
      const id = await scheduledCampaign(db);
      const outcome = await start(db, SYSTEM, id, SNAPSHOT, shop);

      return { outcome, campaign: await campaignRow(db, id) };
    });

    expect(codeOf(outcome)).toBe('NEWSLETTER_LOCALE_INVALID');
    expect(campaign.status).toBe('scheduled');
  });
});

describe('two sessions at the same time', () => {
  // a scheduled campaign the app role can see: committed by the manager
  async function committedScheduled(): Promise<number> {
    const id = await inCommittedTx(async (db) => {
      const created = await draftCampaignIn(db, MANAGER(), 'Start race');
      await moveCampaignTo(db, MANAGER(), created, 'scheduled');
      return created;
    });
    startedForReal.push(id);
    return id;
  }

  const startAs = (db: DbSession, id: number) =>
    attemptAs<{ planned: number }>(
      db,
      SYSTEM,
      SQL.startCampaign,
      id,
      JSON.stringify(SNAPSHOT),
      'en',
    );

  it('gives one winner when two sessions start the same campaign', async () => {
    const id = await committedScheduled();

    // the first holds everything the start takes until it commits; the second waits and then finds
    // the campaign sending
    const { first, second } = await interleave(
      (db) => startAs(db, id),
      (db) => startAs(db, id),
    );

    expect(first.ok).toBe(true);
    expect(codeOf(second)).toBe('NEWSLETTER_CAMPAIGN_NOT_SCHEDULED');

    const { count, planned } = await inOwnerTx(async (db) => {
      const [row] = await callAs<{ count: number }>(
        db,
        READER,
        'select count(*)::int as count from cartlify.newsletter_recipients where "campaignId" = $1',
        id,
      );
      return { count: row!.count, planned: (await campaignRow(db, id)).plannedCount };
    });

    // one set of mails, never two: the winner's
    expect(first.ok && first.rows[0]!.planned).toBe(count);
    expect(planned).toBe(count);
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it('waits for a planning in progress: they share the lock of the limit of the campaigns', async () => {
    const id = await committedScheduled();

    // the first session holds the lock the scheduling of a campaign takes first; the start waits
    const { second } = await interleave(
      async (db) => {
        await db.rows(
          `select 1 as locked from pg_advisory_xact_lock(hashtext('cartlify.newsletter_schedule'))`,
        );
      },
      (db) => startAs(db, id),
    );

    expect(second.ok).toBe(true);
  });

  it('finds a campaign cancelled meanwhile cancelled', async () => {
    const id = await committedScheduled();

    // the first session cancels it and holds the row until it commits; the start waits for the row
    const { second } = await interleave(
      async (db) => {
        await db.as(MANAGER());
        await db.rows(
          `update cartlify.newsletter_campaigns
           set status = 'cancelled', "cancelledAt" = (now() at time zone 'utc'), "updatedById" = $2::int
           where id = $1`,
          id,
          fx.manager.id,
        );
      },
      (db) => startAs(db, id),
    );

    expect(codeOf(second)).toBe('NEWSLETTER_CAMPAIGN_NOT_SCHEDULED');

    const mails = await inOwnerTx((db) => mailsOf(db, id));
    expect(mails).toEqual([]);
  });
});

// A subscriber an admin removes or erases while a campaign starts: the start takes the subscriptions
// in force, so the step that changes or removes one waits for the start (or the start for the step),
// and the start never makes a mail for a subscription that is gone, nor fails on it
describe('a start and the removal of a subscriber at the same time', () => {
  const removed: number[] = [];

  afterAll(async () => {
    await removeSubscriptionRows(removed);
  });

  async function committedActive(): Promise<number> {
    const id = await inOwnerTx((db) => insertSubscription(db, { status: 'active', locale: 'en' }), {
      commit: true,
    });
    removed.push(id);
    return id;
  }

  async function committedScheduled(): Promise<number> {
    const id = await inCommittedTx(async (db) => {
      const created = await draftCampaignIn(db, MANAGER(), 'Start and removal');
      await moveCampaignTo(db, MANAGER(), created, 'scheduled');
      return created;
    });
    startedForReal.push(id);
    return id;
  }

  const startAs = (db: DbSession, id: number) =>
    attemptAs<{ planned: number }>(
      db,
      SYSTEM,
      SQL.startCampaign,
      id,
      JSON.stringify(SNAPSHOT),
      'en',
    );

  it('waits for the erasing of an address, and makes no mail for it', async () => {
    const subscription = await committedActive();
    const campaign = await committedScheduled();

    // the first session erases the address and holds its rows until it commits; the start waits
    const { first, second } = await interleave(
      (db) => attemptAs<{ erased: number }>(db, MANAGER(), SQL.adminErase, subscription),
      (db) => startAs(db, campaign),
    );

    expect(first).toEqual({ ok: true, rows: [{ erased: 1 }] });
    expect(second.ok).toBe(true);

    const mails = await inOwnerTx((db) => mailsOf(db, campaign));
    expect(mails.map((mail) => mail.subscriptionId)).not.toContain(subscription);
    // the campaign was started all the same, for the others
    expect(second.ok && second.rows[0]!.planned).toBe(mails.length);
  });

  it('is waited for by the erasing that comes second, and the mail is made', async () => {
    const subscription = await committedActive();
    const campaign = await committedScheduled();

    // the first session starts the campaign and holds the subscriptions until it commits
    const { first, second } = await interleave(
      (db) => startAs(db, campaign),
      (db) => attemptAs<{ erased: number }>(db, MANAGER(), SQL.adminErase, subscription),
    );

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: true, rows: [{ erased: 1 }] });

    // the people were fixed at the start: the mail was made, and it is skipped when the pass takes it
    const mails = await inOwnerTx((db) => mailsOf(db, campaign));
    expect(mails.map((mail) => mail.subscriptionId)).toContain(subscription);
  });
});
