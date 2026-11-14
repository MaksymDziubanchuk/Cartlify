import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inRolledBackTx, type Actor } from '../../helpers/db.js';
import {
  agoIn,
  campaignIn,
  eventRow,
  insertRow,
  insertSubscription,
  recipientIn,
  recipientRow,
  removeNewsletterFixtures,
  setupNewsletterFixtures,
  type CampaignState,
  type NewsletterFixtures,
  type RecipientState,
  type SubscriptionStatus,
} from '../../helpers/newsletterDb.js';
import {
  CLEANUPS,
  READER,
  SQL,
  SYSTEM,
  attemptAs,
  callAs,
  cleanupSql,
  codeOf,
  publishPolicyWith,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx, type OwnerSession } from '../../helpers/ownerDb.js';

// how long the shop keeps what the newsletters leave: the requests that were not confirmed (three
// days, no term of the policy), the proof of the consent of an ended subscription with its journal
// ("retentionNewsletterConsentDays", counted from the end), the rows of the mails of a campaign
// ("retentionNewsletterRecipientsDays", counted from the end of the campaign). The days are in the
// privacy policy of the shop; the functions take none. A row is kept for the shorter of the term of
// the version in force when it was collected and the term of the version in force now, and is
// cleaned a day before the term ends (rules of db/retention.shopwide.test.ts). Each function is the work of
// the system. The rows of a case are made by the owner of the database in a session that rolls
// back, so the version of the policy a case publishes is seen by that case only; the guards let a
// row end at any moment, so a subscription or a campaign can end long ago. *.shopwide: a cleanup
// goes over every row of the database and holds what it took until the case rolls back

let fx: NewsletterFixtures;

beforeAll(async () => {
  fx = await setupNewsletterFixtures();
});

afterAll(async () => {
  try {
    if (fx) await removeNewsletterFixtures(fx);
  } finally {
    await prisma.$disconnect();
  }
});

const MANAGER = (): Actor => ({ role: 'ADMIN', userId: fx.manager.id });

// a cleanup run by the system: how many rows it removed
async function clean(db: OwnerSession, fn: (typeof CLEANUPS)[number]): Promise<number> {
  const outcome = await attemptAs<{ removed: number }>(db, SYSTEM, cleanupSql(fn));
  if (!outcome.ok) throw new Error(`${fn} refused: ${outcome.message}`);
  return Number(outcome.rows[0]!.removed);
}

// [rows of the subscription, lines of its journal, mails of campaigns] that are in the database
async function remains(db: OwnerSession, id: number): Promise<number[]> {
  const [row] = await callAs<{ rows: string; lines: string; mails: string }>(
    db,
    READER,
    `select
       (select count(*) from cartlify.newsletter_subscriptions where id = $1) as rows,
       (select count(*) from cartlify.newsletter_subscription_events where "subscriptionId" = $1) as lines,
       (select count(*) from cartlify.newsletter_recipients where "subscriptionId" = $1) as mails`,
    id,
  );
  return [Number(row!.rows), Number(row!.lines), Number(row!.mails)];
}

// a millisecond after a moment the database dated (text), so a row made then began under that version
const justAfter = async (db: OwnerSession, at: string): Promise<string> => {
  const [row] = await db.rows<{ at: string }>(
    `select ($1::timestamp + make_interval(secs => 0.001))::text as at`,
    at,
  );
  return row!.at;
};

// A moment some days before the clock of the transaction, cut to the millisecond a column keeps and
// moved forward by some milliseconds. A finer moment would be rounded by the column, up as well as
// down, and a case on the very edge of a term would turn on the rounding.
const agoMs = async (db: OwnerSession, days: number, aheadMs = 0): Promise<string> => {
  const [row] = await db.rows<{ at: string }>(
    `select (date_trunc('milliseconds', now() at time zone 'utc')
             - make_interval(days => $1::int) + $2::int * interval '1 millisecond')::text as at`,
    days,
    aheadMs,
  );
  return row!.at;
};

const GONE = [0, 0, 0];
const WHOLE = [1, 2, 1];

// a subscription in the state given with two lines of the journal and a mail of a campaign
async function subscriberIn(
  db: OwnerSession,
  status: SubscriptionStatus,
  set: Record<string, unknown> = {},
  source: 'form' | 'account' = 'form',
): Promise<number> {
  const id = await insertSubscription(db, {
    status,
    source,
    ...(source === 'account' ? { userId: fx.stranger.id, email: fx.stranger.email } : {}),
    locale: 'en',
    set,
  });
  await insertRow(db, 'newsletter_subscription_events', eventRow(id));
  await insertRow(db, 'newsletter_subscription_events', eventRow(id, { event: 'confirmed' }));
  await insertRow(db, 'newsletter_recipients', recipientRow(fx.campaign, id));
  return id;
}

describe.each(CLEANUPS)('cartlify.%s', (fn) => {
  // the others who may not call it (a guest, a buyer, an admin, root with an account, nobody) are in
  // retention.shopwide.test.ts; here the people the newsletters add
  it.each([
    ['an admin with the right to run the newsletters', MANAGER],
    ['root without an account', () => ({ role: 'ROOT' }) as Actor],
  ])('is not for %s', async (_who, actor) => {
    const outcome = await inRolledBackTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { consent: 1, recipients: 1 });
      return attemptAs(db, actor(), cleanupSql(fn));
    });

    expect(codeOf(outcome)).toBe('RETENTION_CLEANUP_FORBIDDEN');
  });

  it('is run by the role of the app for the system, and gives a count', async () => {
    const outcome = await inRolledBackTx((db) =>
      attemptAs<{ removed: number }>(db, SYSTEM, cleanupSql(fn)),
    );

    expect(outcome).toMatchObject({ ok: true, rows: [{ removed: expect.any(Number) }] });
  });
});

describe('cartlify.cleanup_newsletter_pending', () => {
  // a request that waits, with two lines of its journal, its deadline some time from now (negative: ago)
  const requestIn = async (db: OwnerSession, expiresInMinutes: number) => {
    const expiresAt = await agoIn(db, 0, -expiresInMinutes);
    return subscriberIn(db, 'pending', { confirmExpiresAt: expiresAt });
  };

  it.each([
    ['a minute ago', -1],
    ['an hour ago', -60],
    ['three days ago', -3 * 24 * 60],
    ['a month ago', -30 * 24 * 60],
  ])('removes a request that expired %s, with its journal', async (_when, minutes) => {
    await inOwnerTx(async (db) => {
      const id = await requestIn(db, minutes);

      await clean(db, 'cleanup_newsletter_pending');

      expect(await remains(db, id)).toEqual(GONE);
    });
  });

  it.each([
    ['in a minute', 1],
    ['in an hour', 60],
    ['in three days', 3 * 24 * 60],
  ])('keeps a request whose deadline is %s', async (_when, minutes) => {
    await inOwnerTx(async (db) => {
      const id = await requestIn(db, minutes);

      await clean(db, 'cleanup_newsletter_pending');

      expect(await remains(db, id)).toEqual(WHOLE);
    });
  });

  // the link works while the deadline is later than the clock (a confirmation takes it so): a request
  // whose deadline the clock has just reached has expired, one whose deadline is a millisecond ahead
  // has not
  it.each([
    ['removes a request whose deadline the clock has just reached', 0, GONE],
    ['keeps a request whose deadline is a millisecond ahead of the clock', 1, WHOLE],
  ])('%s', async (_case, ahead, expected) => {
    await inOwnerTx(async (db) => {
      const id = await subscriberIn(db, 'pending', {
        confirmExpiresAt: await agoMs(db, 0, ahead),
      });

      await clean(db, 'cleanup_newsletter_pending');

      expect(await remains(db, id)).toEqual(expected);
    });
  });

  // only a request that waits goes by its deadline; a subscription that was confirmed has none
  it.each(['active', 'paused_complaint', 'stopped_bounce', 'ended'] as SubscriptionStatus[])(
    'keeps a subscription that is %s, however old',
    async (status) => {
      await inOwnerTx(async (db) => {
        const old = await agoIn(db, 400);
        const id = await subscriberIn(db, status, { createdAt: old, updatedAt: old });

        await clean(db, 'cleanup_newsletter_pending');

        expect(await remains(db, id)).toEqual(WHOLE);
      });
    },
  );

  it('needs no term of the policy, and takes only the expired ones among many', async () => {
    await inOwnerTx(async (db) => {
      const expired = [await requestIn(db, -5), await requestIn(db, -50)];
      const waiting = [await requestIn(db, 5), await requestIn(db, 50)];

      const removed = await clean(db, 'cleanup_newsletter_pending');

      expect(removed).toBeGreaterThanOrEqual(2);
      for (const id of expired) expect(await remains(db, id)).toEqual(GONE);
      for (const id of waiting) expect(await remains(db, id)).toEqual(WHOLE);
    });
  });

  it('frees the address of the request that expired', async () => {
    await inOwnerTx(async (db) => {
      const email = `again-${Math.random().toString(16).slice(2)}@example.com`;
      const expiresAt = await agoIn(db, 0, 5);
      await insertSubscription(db, {
        email,
        status: 'pending',
        set: { confirmExpiresAt: expiresAt },
      });

      await clean(db, 'cleanup_newsletter_pending');

      await insertSubscription(db, { email, status: 'pending' });
    });
  });

  it('removes nothing the second time', async () => {
    await inOwnerTx(async (db) => {
      const id = await requestIn(db, -10);

      await clean(db, 'cleanup_newsletter_pending');
      const kept = await requestIn(db, 10);
      await clean(db, 'cleanup_newsletter_pending');

      expect(await remains(db, id)).toEqual(GONE);
      expect(await remains(db, kept)).toEqual(WHOLE);
    });
  });
});

describe('cartlify.cleanup_newsletter_consent', () => {
  const ENDED = ['ended', 'stopped_bounce'] as const;

  // an ended subscription, ended some days (and minutes) before the transaction
  const endedIn = async (
    db: OwnerSession,
    status: (typeof ENDED)[number],
    days: number,
    minutes = 0,
    set: Record<string, unknown> = {},
    source: 'form' | 'account' = 'form',
  ) => subscriberIn(db, status, { endedAt: await agoIn(db, days, minutes), ...set }, source);

  it.each(ENDED)(
    'removes a %s subscription older than the term, with its journal and its mails',
    async (status) => {
      await inOwnerTx(async (db) => {
        await publishPolicyWith(db, fx.root.id, { consent: 90 });
        const old = await endedIn(db, status, 100);
        const recent = await endedIn(db, status, 80);

        const removed = await clean(db, 'cleanup_newsletter_consent');

        expect(removed).toBeGreaterThanOrEqual(1);
        expect(await remains(db, old)).toEqual(GONE);
        expect(await remains(db, recent)).toEqual(WHOLE);
      });
    },
  );

  it('removes the subscription of an account, and leaves the account', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { consent: 90 });
      const old = await endedIn(db, 'ended', 100, 0, {}, 'account');

      await clean(db, 'cleanup_newsletter_consent');

      expect(await remains(db, old)).toEqual(GONE);
      const [user] = await callAs(
        db,
        READER,
        'select id from cartlify.users where id = $1',
        fx.stranger.id,
      );
      expect(user).toEqual({ id: fx.stranger.id });
    });
  });

  // cleaned a day before the term ends: a task that runs once a day never cleans late
  it('cleans a day before the term ends, a minute short of that it waits', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { consent: 90 });
      const due = await endedIn(db, 'ended', 89, 1);
      const notYet = await endedIn(db, 'ended', 89, -1);

      await clean(db, 'cleanup_newsletter_consent');

      expect([await remains(db, due), await remains(db, notYet)]).toEqual([GONE, WHOLE]);
    });
  });

  // the day in hand is whole: a subscription that ended exactly (term - 1) days ago is due, in
  // each of the two places that look at the day (the cheap cut by the shortest term and the check
  // of the term of the versions), to the millisecond a column keeps: a subscription that ended
  // (term - 1) days before the clock is due, one that ended a millisecond later is not
  it.each([
    ['takes one that ended 89 days ago, with a term of 90 days', 90, 89, 0, GONE],
    [
      'leaves one that ended 89 days less a millisecond ago, with a term of 90 days',
      90,
      89,
      1,
      WHOLE,
    ],
    ['takes one that ended a day ago, with a term of 2 days', 2, 1, 0, GONE],
    ['leaves one that ended a day less a millisecond ago, with a term of 2 days', 2, 1, 1, WHOLE],
  ])('at the edge of the day in hand it %s', async (_case, term, days, short, expected) => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { consent: term });
      const id = await endedIn(db, 'ended', 0, 0, { endedAt: await agoMs(db, days, short) });

      await clean(db, 'cleanup_newsletter_consent');

      expect(await remains(db, id)).toEqual(expected);
    });
  });

  it.each([
    ['two days', 2, WHOLE],
    ['a year', 365, WHOLE],
  ])(
    'keeps a subscription that ended a minute ago with a term of %s',
    async (_term, days, expected) => {
      await inOwnerTx(async (db) => {
        await publishPolicyWith(db, fx.root.id, { consent: days });
        const id = await endedIn(db, 'ended', 0, 1);

        await clean(db, 'cleanup_newsletter_consent');

        expect(await remains(db, id)).toEqual(expected);
      });
    },
  );

  it('cleans at once with a term of one day', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { consent: 1 });
      const id = await endedIn(db, 'ended', 0, 1);

      await clean(db, 'cleanup_newsletter_consent');

      expect(await remains(db, id)).toEqual(GONE);
    });
  });

  // the proof stays while the consent is alive: a request, a subscription in force or paused is no
  // proof of anything that ended
  it.each(['pending', 'active', 'paused_complaint'] as SubscriptionStatus[])(
    'keeps a subscription that is %s, however old and whatever the term',
    async (status) => {
      await inOwnerTx(async (db) => {
        await publishPolicyWith(db, fx.root.id, { consent: 1 });
        const old = await agoIn(db, 400);
        const id = await subscriberIn(db, status, { createdAt: old, updatedAt: old });

        await clean(db, 'cleanup_newsletter_consent');

        expect(await remains(db, id)).toEqual(WHOLE);
      });
    },
  );

  // the term counts from the end: a subscription made long ago and ended lately is kept
  it('counts from the end of the subscription, not from its start', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { consent: 90 });
      const id = await endedIn(db, 'ended', 5, 0, { createdAt: await agoIn(db, 1000) });

      await clean(db, 'cleanup_newsletter_consent');

      expect(await remains(db, id)).toEqual(WHOLE);
    });
  });

  // The shorter of the term of the version in force when the subscription was made and of the
  // newest version. The transaction began before it published the versions, so the subscription is
  // made a millisecond after the first one and ended two days ago: only a term that counts from the
  // end, which is that old, can be due
  it.each([
    ['the first version shorter', 1, 30, GONE],
    ['the newest version shorter', 30, 1, GONE],
    ['both as long', 30, 30, WHOLE],
  ])(
    'keeps a subscription for the shorter of the two terms: %s',
    async (_case, first, newest, expected) => {
      await inOwnerTx(async (db) => {
        const v1 = await publishPolicyWith(db, fx.root.id, { consent: first });
        await db.rows('select 1 as done from pg_sleep(0.01)');
        await publishPolicyWith(db, fx.root.id, { consent: newest });
        const id = await endedIn(db, 'ended', 2, 0, {
          createdAt: await justAfter(db, v1.createdAt),
        });

        await clean(db, 'cleanup_newsletter_consent');

        expect(await remains(db, id)).toEqual(expected);
      });
    },
  );

  // a subscription made before the first version follows the newest one
  it.each([
    ['a longer', 30, 1000, WHOLE],
    ['a shorter', 1000, 30, GONE],
  ])(
    'follows the newest version for a subscription from before the first one, %s term there',
    async (_case, first, newest, expected) => {
      await inOwnerTx(async (db) => {
        await publishPolicyWith(db, fx.root.id, { consent: first });
        await publishPolicyWith(db, fx.root.id, { consent: newest });
        const id = await endedIn(db, 'ended', 100, 0, { createdAt: await agoIn(db, 200) });

        await clean(db, 'cleanup_newsletter_consent');

        expect(await remains(db, id)).toEqual(expected);
      });
    },
  );

  it('does not use the term of the recipients: the two terms are independent', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { consent: 365, recipients: 1 });
      const id = await endedIn(db, 'ended', 100);

      await clean(db, 'cleanup_newsletter_consent');

      expect(await remains(db, id)).toEqual(WHOLE);
    });
  });

  it('says how many it removed, and removes none the second time', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { consent: 90 });
      await endedIn(db, 'ended', 100);
      await endedIn(db, 'stopped_bounce', 120);
      await endedIn(db, 'ended', 10);

      const first = await clean(db, 'cleanup_newsletter_consent');
      const second = await clean(db, 'cleanup_newsletter_consent');

      expect(first).toBeGreaterThanOrEqual(2);
      expect(second).toBe(0);
    });
  });

  // Without a published policy nothing is cleaned. A version cannot be taken back, so this case
  // looks for a database that has none; the files that publish one for good (api/legal) run after
  // the rest, and the database is built anew for each run
  it('removes nothing while no policy is published', async () => {
    await inOwnerTx(async (db) => {
      const [{ n }] = (await callAs<{ n: string }>(
        db,
        READER,
        `select count(*) as n from cartlify.legal_documents where kind = 'privacy'`,
      )) as [{ n: string }];
      if (Number(n) > 0) return;

      const id = await endedIn(db, 'ended', 4000);

      expect(await clean(db, 'cleanup_newsletter_consent')).toBe(0);
      expect(await remains(db, id)).toEqual(WHOLE);
    });
  });
});

describe('cartlify.cleanup_newsletter_recipients', () => {
  const ALL_STATES: RecipientState[] = [
    'queued',
    'sent',
    'rejected',
    'bounced',
    'dropped',
    'complained',
  ];

  // a campaign in the state given that ended some days (and minutes) before the transaction, and
  // a mail of it to each of the subscribers given: the ids of the mails
  async function campaignOf(
    db: OwnerSession,
    state: CampaignState,
    days: number,
    minutes = 0,
    states: RecipientState[] = ['sent'],
    createdAt?: string,
    endedAt?: string,
  ) {
    const campaign = await campaignIn(
      db,
      MANAGER(),
      state,
      endedAt ?? (await agoIn(db, days, minutes)),
    );
    const mails: number[] = [];
    for (const status of states) {
      const subscription = await insertSubscription(db, { status: 'active', locale: 'en' });
      mails.push(
        await recipientIn(db, campaign, subscription, status, createdAt ? { createdAt } : {}),
      );
    }
    return { campaign, mails };
  }

  const mailsLeft = async (db: OwnerSession, ids: number[]) => {
    const [row] = await callAs<{ n: string }>(
      db,
      READER,
      'select count(*) as n from cartlify.newsletter_recipients where id = any($1::int[])',
      ids,
    );
    return Number(row!.n);
  };

  it.each(['finished', 'stopped', 'cancelled'] as CampaignState[])(
    'removes the mails of a %s campaign once its term has passed, in every state, and keeps the younger',
    async (state) => {
      await inOwnerTx(async (db) => {
        await publishPolicyWith(db, fx.root.id, { recipients: 90 });
        const old = await campaignOf(db, state, 100, 0, ALL_STATES);
        const recent = await campaignOf(db, state, 80, 0, ALL_STATES);

        const removed = await clean(db, 'cleanup_newsletter_recipients');

        expect(removed).toBeGreaterThanOrEqual(ALL_STATES.length);
        expect(await mailsLeft(db, old.mails)).toBe(0);
        expect(await mailsLeft(db, recent.mails)).toBe(ALL_STATES.length);
      });
    },
  );

  // a campaign that has not ended has nothing to count from
  it.each(['scheduled', 'sending'] as CampaignState[])(
    'keeps the mails of a campaign that is %s, whatever the term',
    async (state) => {
      await inOwnerTx(async (db) => {
        await publishPolicyWith(db, fx.root.id, { recipients: 1 });
        const { mails } = await campaignOf(db, state, 400, 0, ['queued', 'sent']);

        await clean(db, 'cleanup_newsletter_recipients');

        expect(await mailsLeft(db, mails)).toBe(2);
      });
    },
  );

  it('cleans a day before the term ends, a minute short of that it waits', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { recipients: 90 });
      const due = await campaignOf(db, 'finished', 89, 1);
      const notYet = await campaignOf(db, 'finished', 89, -1);

      await clean(db, 'cleanup_newsletter_recipients');

      expect([await mailsLeft(db, due.mails), await mailsLeft(db, notYet.mails)]).toEqual([0, 1]);
    });
  });

  // the day in hand to the millisecond a column keeps: the mails of a campaign that ended (term - 1)
  // days before the clock are due, those of one that ended a millisecond later are not
  it.each([
    ['takes the mails of one that ended 89 days ago, with a term of 90 days', 90, 89, 0, 0],
    [
      'leaves the mails of one that ended 89 days less a millisecond ago, with a term of 90 days',
      90,
      89,
      1,
      1,
    ],
    ['takes the mails of one that ended a day ago, with a term of 2 days', 2, 1, 0, 0],
    [
      'leaves the mails of one that ended a day less a millisecond ago, with a term of 2 days',
      2,
      1,
      1,
      1,
    ],
  ])('at the edge of the day in hand it %s', async (_case, term, days, short, left) => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { recipients: term });
      const ended = await campaignOf(
        db,
        'finished',
        0,
        0,
        ['sent'],
        undefined,
        await agoMs(db, days, short),
      );

      await clean(db, 'cleanup_newsletter_recipients');

      expect(await mailsLeft(db, ended.mails)).toBe(left);
    });
  });

  it('cleans at once with a term of one day, and keeps a campaign that ended a minute ago with two', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { recipients: 1 });
      const ended = await campaignOf(db, 'finished', 0, 1);

      await clean(db, 'cleanup_newsletter_recipients');
      expect(await mailsLeft(db, ended.mails)).toBe(0);
    });

    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { recipients: 2 });
      const ended = await campaignOf(db, 'finished', 0, 1);

      await clean(db, 'cleanup_newsletter_recipients');
      expect(await mailsLeft(db, ended.mails)).toBe(1);
    });
  });

  it('removes only the mails: the campaign with its totals, the subscriptions and the journal stay', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { recipients: 90 });
      const { campaign, mails } = await campaignOf(db, 'finished', 100, 0, ['sent', 'bounced']);
      const [subscriptions] = await callAs<{ ids: number[] }>(
        db,
        READER,
        `select array_agg("subscriptionId" order by id) as ids
         from cartlify.newsletter_recipients where id = any($1::int[])`,
        mails,
      );
      const read = () =>
        callAs(
          db,
          READER,
          `select c.status::text as status, c."plannedCount", c."sentCount", c."undeliveredCount",
                  c."finishedAt", c."startedAt",
                  (select count(*) from cartlify.newsletter_subscriptions s where s.id = any($2::int[])) as subs
           from cartlify.newsletter_campaigns c where c.id = $1`,
          campaign,
          subscriptions!.ids,
        );
      const before = await read();

      await clean(db, 'cleanup_newsletter_recipients');

      expect(await mailsLeft(db, mails)).toBe(0);
      expect(await read()).toEqual(before);
      expect(before).toEqual([expect.objectContaining({ status: 'finished', subs: '2' })]);
    });
  });

  it('keeps the mails of a campaign that ended later, in the same run', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { recipients: 90 });
      const old = await campaignOf(db, 'stopped', 100, 0, ['sent', 'sent', 'sent']);
      const recent = await campaignOf(db, 'finished', 10, 0, ['sent', 'sent']);

      await clean(db, 'cleanup_newsletter_recipients');

      expect([await mailsLeft(db, old.mails), await mailsLeft(db, recent.mails)]).toEqual([0, 2]);
    });
  });

  it.each([
    ['the first version shorter', 1, 30, 0],
    ['the newest version shorter', 30, 1, 0],
    ['both as long', 30, 30, 2],
  ])('keeps the mails for the shorter of the two terms: %s', async (_case, first, newest, left) => {
    await inOwnerTx(async (db) => {
      const v1 = await publishPolicyWith(db, fx.root.id, { recipients: first });
      await db.rows('select 1 as done from pg_sleep(0.01)');
      await publishPolicyWith(db, fx.root.id, { recipients: newest });
      const madeAt = await justAfter(db, v1.createdAt);
      const { mails } = await campaignOf(db, 'finished', 2, 0, ['sent', 'sent'], madeAt);

      await clean(db, 'cleanup_newsletter_recipients');

      expect(await mailsLeft(db, mails)).toBe(left);
    });
  });

  it.each([
    ['a longer', 30, 1000, 2],
    ['a shorter', 1000, 30, 0],
  ])(
    'follows the newest version for mails from before the first one, %s term there',
    async (_case, first, newest, left) => {
      await inOwnerTx(async (db) => {
        await publishPolicyWith(db, fx.root.id, { recipients: first });
        await publishPolicyWith(db, fx.root.id, { recipients: newest });
        const { mails } = await campaignOf(
          db,
          'finished',
          100,
          0,
          ['sent', 'sent'],
          await agoIn(db, 200),
        );

        await clean(db, 'cleanup_newsletter_recipients');

        expect(await mailsLeft(db, mails)).toBe(left);
      });
    },
  );

  it('does not use the term of the consent: the two terms are independent', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { consent: 1, recipients: 365 });
      const { mails } = await campaignOf(db, 'finished', 100);

      await clean(db, 'cleanup_newsletter_recipients');

      expect(await mailsLeft(db, mails)).toBe(1);
    });
  });

  it('says how many it removed, and removes none the second time', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { recipients: 90 });
      await campaignOf(db, 'finished', 100, 0, ['sent', 'sent', 'sent']);
      await campaignOf(db, 'finished', 10, 0, ['sent']);

      const first = await clean(db, 'cleanup_newsletter_recipients');
      const second = await clean(db, 'cleanup_newsletter_recipients');

      expect(first).toBeGreaterThanOrEqual(3);
      expect(second).toBe(0);
    });
  });

  // see the same case of the consent: a database with no policy is looked for
  it('removes nothing while no policy is published', async () => {
    await inOwnerTx(async (db) => {
      const [{ n }] = (await callAs<{ n: string }>(
        db,
        READER,
        `select count(*) as n from cartlify.legal_documents where kind = 'privacy'`,
      )) as [{ n: string }];
      if (Number(n) > 0) return;

      const { mails } = await campaignOf(db, 'finished', 4000);

      expect(await clean(db, 'cleanup_newsletter_recipients')).toBe(0);
      expect(await mailsLeft(db, mails)).toBe(1);
    });
  });
});

// the export of a person gives the subscriptions their address has, the ended ones with their
// journals: the proof of the consent is theirs to read while it is kept, and what the cleanup removed
// is not given
describe('the export of the person and the cleanup of the consent', () => {
  type Exported = { subscriptions: { status: string; events: unknown[] }[] };

  const exportedFor = async (db: OwnerSession, userId: number) => {
    const [row] = await callAs<{ data: Exported }>(db, SYSTEM, SQL.profileExport, userId);
    return row!.data.subscriptions;
  };

  it('gives an ended subscription with its journal until the cleanup removes it, the younger one after', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { consent: 90 });
      await subscriberIn(db, 'ended', { endedAt: await agoIn(db, 100) }, 'account');
      await subscriberIn(db, 'stopped_bounce', { endedAt: await agoIn(db, 10) }, 'account');

      const before = await exportedFor(db, fx.stranger.id);
      await clean(db, 'cleanup_newsletter_consent');
      const after = await exportedFor(db, fx.stranger.id);

      expect(before.map((item) => item.status).sort()).toEqual(['ended', 'stopped_bounce']);
      expect(before.map((item) => item.events.length)).toEqual([2, 2]);
      expect(after.map((item) => item.status)).toEqual(['stopped_bounce']);
      expect(after.map((item) => item.events.length)).toEqual([2]);
    });
  });

  it('gives nothing of the subscription a person had once the cleanup removed all of them', async () => {
    await inOwnerTx(async (db) => {
      await publishPolicyWith(db, fx.root.id, { consent: 30 });
      await subscriberIn(db, 'ended', { endedAt: await agoIn(db, 60) }, 'account');

      await clean(db, 'cleanup_newsletter_consent');

      expect(await exportedFor(db, fx.stranger.id)).toEqual([]);
    });
  });
});

// the two terms are known to the internal functions that read the policy, as the six others are
describe('the terms of the newsletters in the policy', () => {
  const FIELDS = ['retentionNewsletterConsentDays', 'retentionNewsletterRecipientsDays'] as const;
  const termOf = (field: (typeof FIELDS)[number], days: number) =>
    field === 'retentionNewsletterConsentDays' ? { consent: days } : { recipients: days };

  // the versions the other shop-wide files published before this one stay in the database (a
  // version is never taken back), and they count too
  it.each(FIELDS)('gives the shortest term of %s in any version', async (field) => {
    await inOwnerTx(async (db) => {
      const [{ shortest }] = (await db.rows<{ shortest: number | null }>(
        `select min("${field}") as shortest from cartlify.legal_documents where kind = 'privacy'`,
      )) as [{ shortest: number | null }];
      await publishPolicyWith(db, fx.root.id, termOf(field, 7));
      await publishPolicyWith(db, fx.root.id, termOf(field, 5));
      await publishPolicyWith(db, fx.root.id, termOf(field, 9));

      const rows = await callAs(db, READER, 'select cartlify.retention_floor($1) as floor', field);

      expect(rows).toEqual([{ floor: shortest === null ? 5 : Math.min(shortest, 5) }]);
    });
  });

  it.each(FIELDS)(
    'gives the term of %s in the version in force at a moment, the newest for an older one',
    async (field) => {
      await inOwnerTx(async (db) => {
        const v1 = await publishPolicyWith(db, fx.root.id, termOf(field, 40));
        await db.rows('select 1 as done from pg_sleep(0.01)');
        await publishPolicyWith(db, fx.root.id, termOf(field, 60));
        const after = await justAfter(db, v1.createdAt);
        const before = await agoIn(db, 400);

        const days = (at: string) =>
          callAs(
            db,
            READER,
            'select cartlify.retention_days($1, $2::timestamp) as days',
            field,
            at,
          );

        // after the first version: the shorter of it (40) and the newest (60); before it: the newest
        expect(await days(after)).toEqual([{ days: 40 }]);
        expect(await days(before)).toEqual([{ days: 60 }]);
      });
    },
  );

  it('refuses a field it does not know', async () => {
    const outcome = await inOwnerTx((db) =>
      attemptAs(
        db,
        READER,
        `select cartlify.retention_days('retentionNewsletterOtherDays', now() at time zone 'utc')`,
      ),
    );

    expect(outcome).toMatchObject({
      ok: false,
      code: '22023',
      message: expect.stringContaining('RETENTION_FIELD_INVALID'),
    });
  });
});
