import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inCommittedTx, inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import { deferred } from '../../helpers/interleave.js';
import {
  campaignIn,
  insertSubscription,
  recipientIn,
  removeNewsletterFixtures,
  removeSubscriptionRows,
  setupNewsletterFixtures,
  utc,
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
  subscriptionById,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx, type OwnerSession } from '../../helpers/ownerDb.js';

// the portion of mails a pass takes (cartlify.newsletter_claim_recipients) and the mails it gives
// back (cartlify.newsletter_release_recipients). A mail is leased to the one who takes it: it
// counts one more try and cannot be taken for 10 minutes; the queue goes by the tries a mail has
// used, the fewest first, and by id among the same; a mail whose subscription is gone is put
// away, not sent. The cases work in a session of the owner of the database that rolls back; the case
// of two sessions taking at once needs committed rows and cleans up after itself

let fx: NewsletterFixtures;
const raceCampaigns: number[] = [];
const raceSubscriptions: number[] = [];

beforeAll(async () => {
  fx = await setupNewsletterFixtures();
});

afterAll(async () => {
  try {
    if (raceCampaigns.length) {
      await inOwnerTx(
        async (db) => {
          await db.rows(
            'delete from cartlify.newsletter_recipients where "campaignId" = any($1::int[])',
            raceCampaigns,
          );
          await db.as(SYSTEM);
          await db.rows(
            `update cartlify.newsletter_campaigns
             set status = 'finished', "finishedAt" = (now() at time zone 'utc')
             where id = any($1::int[]) and status = 'sending'`,
            raceCampaigns,
          );
        },
        { commit: true },
      );
    }
    await removeSubscriptionRows(raceSubscriptions);
    if (fx) await removeNewsletterFixtures(fx);
  } finally {
    await prisma.$disconnect();
  }
});

const MANAGER = (): Actor => ({ role: 'ADMIN', userId: fx.manager.id });
const ROOT = (): Actor => ({ role: 'ROOT', userId: fx.root.id });

type Claimed = {
  recipient_id: number;
  campaign_id: number;
  locale: string;
  email: string;
  manage_salt: string;
  last_attempt: boolean;
  // when the mail was taken before this call, empty for a mail taken for the first time
  previous_try: Date | null;
};

// the claim of the pass, narrowed to the campaigns given (the rows other test files leave in the
// database are not this case's to take)
const claim = (
  db: Pick<DbSession, 'as' | 'rows' | 'attempt'>,
  actor: Actor | null,
  limit: number | null,
  campaigns: number[] | null,
) => attemptAs<Claimed>(db, actor, SQL.claim, limit, campaigns);

// a claim that has to work: the rows
async function claimed(
  db: OwnerSession,
  limit: number | null,
  campaigns: number[] | null,
): Promise<Claimed[]> {
  const outcome = await claim(db, SYSTEM, limit, campaigns);
  if (!outcome.ok) throw new Error(`the claim was refused: ${codeOf(outcome)}`);
  return outcome.rows;
}

// a claim of three mails in a session of the app role
async function takeThree(db: DbSession, campaign: number): Promise<Claimed[]> {
  const outcome = await claim(db, SYSTEM, 3, [campaign]);
  if (!outcome.ok) throw new Error(`the claim was refused: ${codeOf(outcome)}`);
  return outcome.rows;
}

const sendingCampaign = (db: OwnerSession, state: CampaignState = 'sending') =>
  campaignIn(db, MANAGER(), state);

type Mail = { id: number; subscription: number; email: string; salt: string };

// a mail that waits, to a subscription of its own: how many tries it has used and how long ago it was
// last taken (nothing: it has not been taken)
async function mailIn(
  db: OwnerSession,
  campaign: number,
  opts: {
    subscription?: SubscriptionStatus;
    locale?: string;
    attempts?: number;
    minutesAgo?: number;
    madeAgoMs?: number;
  } = {},
): Promise<Mail> {
  const subscription = await insertSubscription(db, {
    status: opts.subscription ?? 'active',
    locale: 'en',
  });
  const id = await recipientIn(db, campaign, subscription, 'queued', {
    locale: opts.locale ?? 'en',
    ...(opts.madeAgoMs ? { createdAt: utc(-opts.madeAgoMs) } : {}),
  });

  if (opts.attempts !== undefined || opts.minutesAgo !== undefined) {
    await db.rows(
      `update cartlify.newsletter_recipients
       set attempts = $2::int, "updatedAt" = (now() at time zone 'utc') - ($3::numeric * interval '1 minute')
       where id = $1`,
      id,
      opts.attempts ?? 1,
      opts.minutesAgo ?? 0,
    );
  }

  const row = (await subscriptionById(db, subscription))!;
  return { id, subscription, email: row.email, salt: row.manageSalt };
}

type MailState = { id: number; status: string; attempts: number; updatedAt: Date };

const statesOf = (db: OwnerSession, ids: number[]) =>
  callAs<MailState>(
    db,
    READER,
    `select id, status::text as status, attempts, "updatedAt"
     from cartlify.newsletter_recipients where id = any($1::int[]) order by id`,
    ids,
  );

type Totals = { sentCount: number; rejectedCount: number; plannedCount: number };

const totalsOf = async (db: OwnerSession, campaign: number): Promise<Totals> => {
  const [row] = await callAs<Totals>(
    db,
    READER,
    `select "sentCount", "rejectedCount", "plannedCount" from cartlify.newsletter_campaigns where id = $1`,
    campaign,
  );
  return row!;
};

describe('who may take mails and give them back', () => {
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

  it.each(ACTORS)(
    'refuses %s the claim and the release, and changes nothing',
    async (_who, actor) => {
      const { taken, given, state } = await inOwnerTx(async (db) => {
        const campaign = await sendingCampaign(db);
        const mail = await mailIn(db, campaign, { attempts: 2, minutesAgo: 30 });

        return {
          taken: await claim(db, actor(), 10, [campaign]),
          given: await attemptAs(db, actor(), SQL.release, [mail.id]),
          state: (await statesOf(db, [mail.id]))[0]!,
        };
      });

      expect(codeOf(taken)).toBe('NEWSLETTER_FORBIDDEN');
      expect(codeOf(given)).toBe('NEWSLETTER_FORBIDDEN');
      expect(state).toMatchObject({ status: 'queued', attempts: 2 });
    },
  );

  it('refuses the app role when the actor is not the system, and lets it in when it is', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const guest = await attemptAs(db, GUEST(), SQL.claim, 1, null);
      const buyer = await attemptAs(
        db,
        { role: 'USER', userId: fx.stranger.id },
        SQL.claim,
        1,
        [0],
      );
      const system = await attemptAs(db, SYSTEM, SQL.claim, 0, [0]);
      const released = await attemptAs(db, SYSTEM, SQL.release, []);

      return { guest, buyer, system, released };
    });

    expect(codeOf(outcomes.guest)).toBe('NEWSLETTER_FORBIDDEN');
    expect(codeOf(outcomes.buyer)).toBe('NEWSLETTER_FORBIDDEN');
    expect(outcomes.system.ok).toBe(true);
    expect(outcomes.released.ok).toBe(true);
  });
});

describe('what a claim gives and what it does to the mail', () => {
  it('gives what the sender needs and leases the mail with one more try', async () => {
    const { rows, mail, state, now } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign, { locale: 'es' });
      return {
        rows: await claimed(db, 10, [campaign]),
        mail: { ...mail, campaign },
        state: (await statesOf(db, [mail.id]))[0]!,
        now: await dbNow(db),
      };
    });

    expect(rows).toEqual([
      {
        recipient_id: mail.id,
        campaign_id: mail.campaign,
        locale: 'es',
        email: mail.email,
        manage_salt: mail.salt,
        last_attempt: false,
        previous_try: null,
      },
    ]);
    expect(state).toMatchObject({ status: 'queued', attempts: 1 });
    expect(near(state.updatedAt, now)).toBe(true);
  });

  it('takes the mails of the same tries in the order of their ids, as many as asked, and the next call takes the next', async () => {
    const { ids, first, second, third } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const ids: number[] = [];
      for (let i = 0; i < 5; i += 1) ids.push((await mailIn(db, campaign)).id);

      return {
        ids,
        first: await claimed(db, 2, [campaign]),
        second: await claimed(db, 2, [campaign]),
        third: await claimed(db, 2, [campaign]),
      };
    });

    expect(first.map((row) => row.recipient_id)).toEqual(ids.slice(0, 2));
    expect(second.map((row) => row.recipient_id)).toEqual(ids.slice(2, 4));
    expect(third.map((row) => row.recipient_id)).toEqual(ids.slice(4));
  });

  it.each([
    ['none', 0],
    ['a negative number', -3],
    ['no number', null],
  ])('takes nothing when asked for %s', async (_what, limit) => {
    const { rows, state } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign);
      return {
        rows: await claimed(db, limit, [campaign]),
        state: (await statesOf(db, [mail.id]))[0]!,
      };
    });

    expect(rows).toEqual([]);
    expect(state).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('takes the mails of every campaign that is sending when it is not narrowed', async () => {
    const { rows, one, two } = await inOwnerTx(async (db) => {
      const one = await sendingCampaign(db);
      const two = await sendingCampaign(db);
      const a = await mailIn(db, one);
      const b = await mailIn(db, two);

      return { rows: await claimed(db, 1000, null), one: a.id, two: b.id };
    });

    const ids = rows.map((row) => row.recipient_id);
    expect(ids).toContain(one);
    expect(ids).toContain(two);
  });

  it('takes only the mails of the campaigns it is narrowed to', async () => {
    const { rows, other, wanted } = await inOwnerTx(async (db) => {
      const one = await sendingCampaign(db);
      const two = await sendingCampaign(db);
      const wanted = await mailIn(db, one);
      const other = await mailIn(db, two);

      return { rows: await claimed(db, 10, [one]), other, wanted };
    });

    expect(rows.map((row) => row.recipient_id)).toEqual([wanted.id]);
    expect(other.id).not.toBe(wanted.id);
  });

  it('leaves the mails of a campaign alone when it is not sending', async () => {
    const states: CampaignState[] = ['finished', 'stopped'];

    const { rows, untouched } = await inOwnerTx(async (db) => {
      const sending = await sendingCampaign(db);
      const live = await mailIn(db, sending);
      const others: Mail[] = [];
      const campaigns = [sending];
      for (const state of states) {
        const campaign = await sendingCampaign(db, state);
        campaigns.push(campaign);
        others.push(await mailIn(db, campaign));
      }

      return {
        rows: await claimed(db, 10, campaigns),
        live,
        untouched: await statesOf(
          db,
          others.map((mail) => mail.id),
        ),
      };
    });

    expect(rows).toHaveLength(1);
    expect(untouched.map((state) => [state.status, state.attempts])).toEqual([
      ['queued', 0],
      ['queued', 0],
    ]);
  });
});

// The queue goes by the tries a mail has used: the fewest first, and by id among the same. A mail that
// was refused and kept, or found SendGrid busy, comes back behind the mails not tried yet
describe('the order of the queue', () => {
  // five mails made in this order: tried twice, never, once, never, once (the lease of the tried ones
  // has run out)
  async function mixedQueue(db: OwnerSession) {
    const campaign = await sendingCampaign(db);
    const twice = await mailIn(db, campaign, { attempts: 2, minutesAgo: 60 });
    const fresh = await mailIn(db, campaign);
    const once = await mailIn(db, campaign, { attempts: 1, minutesAgo: 60 });
    const freshToo = await mailIn(db, campaign);
    const onceToo = await mailIn(db, campaign, { attempts: 1, minutesAgo: 60 });

    return { campaign, twice, fresh, once, freshToo, onceToo };
  }

  it('gives the mails with fewer tries first, then by id', async () => {
    const { rows, made } = await inOwnerTx(async (db) => {
      const made = await mixedQueue(db);
      return { rows: await claimed(db, 10, [made.campaign]), made };
    });

    expect(rows.map((row) => row.recipient_id)).toEqual([
      made.fresh.id,
      made.freshToo.id,
      made.once.id,
      made.onceToo.id,
      made.twice.id,
    ]);
  });

  it('picks by the tries before it picks by id: a small portion is of the mails not tried', async () => {
    const { first, second, third, made } = await inOwnerTx(async (db) => {
      const made = await mixedQueue(db);

      return {
        made,
        first: await claimed(db, 2, [made.campaign]),
        second: await claimed(db, 2, [made.campaign]),
        third: await claimed(db, 2, [made.campaign]),
      };
    });

    expect(first.map((row) => row.recipient_id)).toEqual([made.fresh.id, made.freshToo.id]);
    expect(second.map((row) => row.recipient_id)).toEqual([made.once.id, made.onceToo.id]);
    expect(third.map((row) => row.recipient_id)).toEqual([made.twice.id]);
  });

  // the tries count as the call makes them: a mail taken a second time is behind one taken for the first
  it('puts a mail taken again behind the mails taken once, in the same portion', async () => {
    const { rows, again, fresh } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const again = await mailIn(db, campaign, { attempts: 1, minutesAgo: 60 });
      const fresh = await mailIn(db, campaign);

      return { rows: await claimed(db, 10, [campaign]), again: again.id, fresh: fresh.id };
    });

    expect(rows.map((row) => [row.recipient_id, row.last_attempt])).toEqual([
      [fresh, false],
      [again, false],
    ]);
  });

  it('keeps the order across campaigns: the tries first, whatever the campaign', async () => {
    const { rows, tried, untried } = await inOwnerTx(async (db) => {
      const one = await sendingCampaign(db);
      const two = await sendingCampaign(db);
      const tried = await mailIn(db, one, { attempts: 1, minutesAgo: 60 });
      const untried = await mailIn(db, two);

      return { rows: await claimed(db, 10, [one, two]), tried: tried.id, untried: untried.id };
    });

    expect(rows.map((row) => row.recipient_id)).toEqual([untried, tried]);
  });
});

// A mail taken before comes with the time it was taken last (the database clock, the one that writes
// the lease), so the pass can tell whether the campaign sent a mail since
describe('the time of the previous try', () => {
  it('is empty for a mail that is taken for the first time', async () => {
    const rows = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      await mailIn(db, campaign);
      return claimed(db, 10, [campaign]);
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.previous_try).toBeNull();
  });

  it('is the time the mail was taken last, for a mail taken before', async () => {
    const { rows, now } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      await mailIn(db, campaign, { attempts: 2, minutesAgo: 30 });
      return { rows: await claimed(db, 10, [campaign]), now: await dbNow(db) };
    });

    expect(rows).toHaveLength(1);
    expect(near(rows[0]!.previous_try, new Date(now.getTime() - 30 * 60_000))).toBe(true);
  });

  it('is the time of the claim before, not of this one, when a mail is taken twice', async () => {
    const { first, second, firstAt } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign);
      const first = await claimed(db, 10, [campaign]);
      const firstAt = (await statesOf(db, [mail.id]))[0]!.updatedAt;
      await db.rows(
        `update cartlify.newsletter_recipients
         set "updatedAt" = "updatedAt" - interval '11 minutes' where id = $1`,
        mail.id,
      );

      return { first, second: await claimed(db, 10, [campaign]), firstAt };
    });

    expect(first[0]!.previous_try).toBeNull();
    expect(near(second[0]!.previous_try, new Date(firstAt.getTime() - 11 * 60_000))).toBe(true);
  });

  // a mail given back is as it was before it was taken: its time is that of its making
  it('is the time the mail was made, for a mail that was given back after a retry', async () => {
    const { rows, madeAt } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign, {
        attempts: 2,
        minutesAgo: 60,
        madeAgoMs: 3_600_000,
      });
      const taken = await claimed(db, 10, [campaign]);
      await callAs(
        db,
        SYSTEM,
        SQL.release,
        taken.map((row) => row.recipient_id),
      );
      const madeAt = (
        await callAs<{ createdAt: Date }>(
          db,
          READER,
          `select "createdAt" from cartlify.newsletter_recipients where id = $1`,
          mail.id,
        )
      )[0]!.createdAt;

      return { rows: await claimed(db, 10, [campaign]), madeAt };
    });

    expect(rows).toHaveLength(1);
    expect(near(rows[0]!.previous_try, madeAt)).toBe(true);
  });
});

describe('the lease', () => {
  // [how long ago the mail was taken, how many tries it has used, whether it can be taken now]
  const LEASES: [string, number, number, boolean][] = [
    ['never taken, made just now', 0, 0, true],
    ['taken a moment ago', 1, 0, false],
    ['taken 9 minutes ago', 1, 9, false],
    // the column keeps milliseconds, so the edge is tried a little to either side of it
    ['taken a little under 10 minutes ago', 1, 9.999, false],
    ['taken a little over 10 minutes ago', 1, 10.001, true],
    ['taken 11 minutes ago', 1, 11, true],
    ['taken an hour ago, after 3 tries', 3, 60, true],
    ['taken 9 minutes ago, after 3 tries', 3, 9, false],
  ];

  it.each(LEASES)('a mail %s', async (_what, attempts, minutesAgo, due) => {
    const { rows, state } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign, { attempts, minutesAgo });

      return {
        rows: await claimed(db, 10, [campaign]),
        state: (await statesOf(db, [mail.id]))[0]!,
      };
    });

    expect(rows).toHaveLength(due ? 1 : 0);
    expect(state.attempts).toBe(due ? attempts + 1 : attempts);
  });

  it('does not give a mail twice to two calls in a row', async () => {
    const { first, second } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      await mailIn(db, campaign);

      return {
        first: await claimed(db, 10, [campaign]),
        second: await claimed(db, 10, [campaign]),
      };
    });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('tells the last try from the others', async () => {
    const { flags } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      // the mails have used 0, 1, 2, 3 and 4 tries, each taken long ago
      const mails: Mail[] = [];
      for (const attempts of [0, 1, 2, 3, 4]) {
        mails.push(await mailIn(db, campaign, { attempts, minutesAgo: 60 }));
      }
      const rows = await claimed(db, 10, [campaign]);

      return {
        flags: mails.map((mail) => rows.find((row) => row.recipient_id === mail.id)?.last_attempt),
      };
    });

    // the 5th try is the last one
    expect(flags).toEqual([false, false, false, false, true]);
  });
});

describe('a mail whose tries are used up', () => {
  it('is rejected and counted, once the lease of its last try has run out', async () => {
    const { rows, states, before, after } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const one = await mailIn(db, campaign, { attempts: 5, minutesAgo: 11 });
      const two = await mailIn(db, campaign, { attempts: 7, minutesAgo: 600 });
      const before = await totalsOf(db, campaign);

      return {
        rows: await claimed(db, 10, [campaign]),
        states: await statesOf(db, [one.id, two.id]),
        before,
        after: await totalsOf(db, campaign),
      };
    });

    expect(rows).toEqual([]);
    expect(states.map((state) => state.status)).toEqual(['rejected', 'rejected']);
    expect(after.rejectedCount - before.rejectedCount).toBe(2);
    expect(after.sentCount).toBe(before.sentCount);
    expect(after.plannedCount).toBe(before.plannedCount);
  });

  it('is left alone while the lease of its last try holds', async () => {
    const { rows, state, before, after } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign, { attempts: 5, minutesAgo: 9 });
      const before = await totalsOf(db, campaign);

      return {
        rows: await claimed(db, 10, [campaign]),
        state: (await statesOf(db, [mail.id]))[0]!,
        before,
        after: await totalsOf(db, campaign),
      };
    });

    expect(rows).toEqual([]);
    expect(state).toMatchObject({ status: 'queued', attempts: 5 });
    expect(after).toEqual(before);
  });

  it('is put away even when nothing is asked for', async () => {
    const state = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign, { attempts: 5, minutesAgo: 11 });
      await claimed(db, 0, [campaign]);

      return (await statesOf(db, [mail.id]))[0]!;
    });

    expect(state.status).toBe('rejected');
  });

  it('is left alone in a campaign that is not sending', async () => {
    const state = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db, 'stopped');
      const mail = await mailIn(db, campaign, { attempts: 5, minutesAgo: 600 });
      await claimed(db, 10, [campaign]);

      return (await statesOf(db, [mail.id]))[0]!;
    });

    expect(state).toMatchObject({ status: 'queued', attempts: 5 });
  });

  it('is left alone by a call narrowed to other campaigns', async () => {
    const state = await inOwnerTx(async (db) => {
      const one = await sendingCampaign(db);
      const two = await sendingCampaign(db);
      const mail = await mailIn(db, two, { attempts: 5, minutesAgo: 600 });
      await claimed(db, 10, [one]);

      return (await statesOf(db, [mail.id]))[0]!;
    });

    expect(state.status).toBe('queued');
  });
});

describe('a mail whose subscription is not in force', () => {
  const GONE: SubscriptionStatus[] = ['paused_complaint', 'stopped_bounce', 'ended'];

  it.each(GONE)('is skipped, not given, and counted in no total (%s)', async (status) => {
    const { rows, state, before, after } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign, { subscription: status });
      const before = await totalsOf(db, campaign);

      return {
        rows: await claimed(db, 10, [campaign]),
        state: (await statesOf(db, [mail.id]))[0]!,
        before,
        after: await totalsOf(db, campaign),
      };
    });

    expect(rows).toEqual([]);
    expect(state).toMatchObject({ status: 'skipped', attempts: 0 });
    expect(after).toEqual(before);
  });

  it('is skipped while the people in force are given, even when nothing is asked for', async () => {
    const { rows, states } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const gone = await mailIn(db, campaign, { subscription: 'ended' });
      const live = await mailIn(db, campaign);
      const rows = await claimed(db, 0, [campaign]);
      const afterwards = await claimed(db, 10, [campaign]);

      return { rows: [rows, afterwards], states: await statesOf(db, [gone.id, live.id]) };
    });

    expect(rows[0]).toEqual([]);
    expect(rows[1]).toHaveLength(1);
    expect(states.map((state) => state.status)).toEqual(['skipped', 'queued']);
  });

  it('is left queued while the lease of another holder holds', async () => {
    const state = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign, {
        subscription: 'ended',
        attempts: 1,
        minutesAgo: 2,
      });
      await claimed(db, 10, [campaign]);

      return (await statesOf(db, [mail.id]))[0]!;
    });

    expect(state).toMatchObject({ status: 'queued', attempts: 1 });
  });

  it('is skipped in the campaigns it is narrowed to only', async () => {
    const state = await inOwnerTx(async (db) => {
      const one = await sendingCampaign(db);
      const two = await sendingCampaign(db);
      const mail = await mailIn(db, two, { subscription: 'ended' });
      await claimed(db, 10, [one]);

      return (await statesOf(db, [mail.id]))[0]!;
    });

    expect(state.status).toBe('queued');
  });

  it('is skipped by the call even if the person was unsubscribed after the mail was made', async () => {
    const { rows, state } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign);
      // the person unsubscribes: the subscription ends the way the app ends it
      await db.rows(
        `update cartlify.newsletter_subscriptions
         set status = 'ended', "endedAt" = (now() at time zone 'utc'), "endReason" = 'unsubscribed'
         where id = $1`,
        mail.subscription,
      );

      return {
        rows: await claimed(db, 10, [campaign]),
        state: (await statesOf(db, [mail.id]))[0]!,
      };
    });

    expect(rows).toEqual([]);
    expect(state.status).toBe('skipped');
  });
});

describe('two sessions taking at the same time', () => {
  it('give each its own mails, never the same one twice', async () => {
    // committed rows: a campaign that is sending, and six mails that wait
    const ids = await inOwnerTx(
      async (db) => {
        const campaign = await sendingCampaign(db);
        raceCampaigns.push(campaign);
        const mails: number[] = [];
        for (let i = 0; i < 6; i += 1) {
          const mail = await mailIn(db, campaign);
          raceSubscriptions.push(mail.subscription);
          mails.push(mail.id);
        }
        return { campaign, mails };
      },
      { commit: true },
    );

    const held = deferred();
    const release = deferred();
    // the first call takes three and keeps its transaction open; the second must not wait for it
    const one = inCommittedTx(async (db) => {
      const rows = await takeThree(db, ids.campaign);
      held.resolve();
      await release.promise;
      return rows;
    });
    one.catch(() => undefined);
    await held.promise;

    const second = await inCommittedTx((db) => takeThree(db, ids.campaign));
    release.resolve();
    const first = await one;

    const firstIds = first.map((row) => row.recipient_id);
    const secondIds = second.map((row) => row.recipient_id);
    expect(firstIds).toHaveLength(3);
    expect(secondIds).toHaveLength(3);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(6);
    expect([...firstIds, ...secondIds].sort((a, b) => a - b)).toEqual(ids.mails);
  });
});

describe('giving mails back', () => {
  it('returns the try a mail was taken with, and the mail is free to be taken at once', async () => {
    const { given, afterwards, again } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      // made long ago, so the lease of the retry it goes back to has run out
      const first = await mailIn(db, campaign, { madeAgoMs: 3_600_000 });
      const retried = await mailIn(db, campaign, {
        madeAgoMs: 3_600_000,
        attempts: 3,
        minutesAgo: 60,
      });
      const taken = await claimed(db, 10, [campaign]);
      const ids = taken.map((row) => row.recipient_id);
      const [released] = await callAs<{ released: number }>(db, SYSTEM, SQL.release, ids);
      const afterwards = await statesOf(db, [first.id, retried.id]);

      return {
        given: released!.released,
        afterwards,
        again: (await claimed(db, 10, [campaign])).map((row) => row.recipient_id),
      };
    });

    expect(given).toBe(2);
    expect(afterwards.map((state) => [state.status, state.attempts])).toEqual([
      ['queued', 0],
      ['queued', 3],
    ]);
    expect(again).toHaveLength(2);
  });

  it('leaves a mail that is not waiting, one with no try and an unknown number alone', async () => {
    const { given, states } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const fresh = await mailIn(db, campaign);
      const subscription = await insertSubscription(db, { locale: 'en' });
      const sent = await recipientIn(db, campaign, subscription, 'sent');
      const [released] = await callAs<{ released: number }>(db, SYSTEM, SQL.release, [
        fresh.id,
        sent,
        2_000_000_000,
      ]);

      return { given: released!.released, states: await statesOf(db, [fresh.id, sent]) };
    });

    expect(given).toBe(0);
    expect(states.map((state) => [state.status, state.attempts])).toEqual([
      ['queued', 0],
      ['sent', 1],
    ]);
  });

  it.each([
    ['an empty list', []],
    ['no list', null],
  ])('gives back nothing for %s', async (_what, ids) => {
    const [row] = await inOwnerTx((db) =>
      callAs<{ released: number }>(db, SYSTEM, SQL.release, ids),
    );

    expect(row!.released).toBe(0);
  });
});

// the lease and the number of tries are the caller's to give (the server reads them from its
// settings), within bounds the database keeps; the size of a portion has a top
describe('the lease, the tries and the size of a portion, as arguments', () => {
  const claimWith = (
    db: OwnerSession,
    limit: number | null,
    campaigns: number[] | null,
    lease: number | null,
    tries: number | null,
  ) => attemptAs<Claimed>(db, SYSTEM, SQL.claimWith, limit, campaigns, lease, tries);

  it.each([
    // [minutes since the last take, the lease asked for, taken again]
    [5, 3, true],
    [5, 6, false],
    [30, 20, true],
    [30, 40, false],
    [1500, 1440, true],
    [1000, 1440, false],
  ] as const)(
    'gives a mail taken %s minutes ago again for a lease of %s minutes: %s',
    async (minutesAgo, lease, due) => {
      const rows = await inOwnerTx(async (db) => {
        const campaign = await sendingCampaign(db);
        await mailIn(db, campaign, { attempts: 1, minutesAgo });
        const outcome = await claimWith(db, 10, [campaign], lease, 5);
        return outcome.ok ? outcome.rows : [];
      });

      expect(rows).toHaveLength(due ? 1 : 0);
    },
  );

  it('keeps the lease of the minute: one minute and some seconds are enough, 50 seconds are not', async () => {
    const taken = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const early = await mailIn(db, campaign, { attempts: 1 });
      const late = await mailIn(db, campaign, { attempts: 1 });
      await db.rows(
        `update cartlify.newsletter_recipients
         set "updatedAt" = (now() at time zone 'utc') - interval '50 seconds' where id = $1`,
        early.id,
      );
      await db.rows(
        `update cartlify.newsletter_recipients
         set "updatedAt" = (now() at time zone 'utc') - interval '70 seconds' where id = $1`,
        late.id,
      );
      const outcome = await claimWith(db, 10, [campaign], 1, 5);
      return outcome.ok ? outcome.rows.map((row) => row.recipient_id === late.id) : [];
    });

    expect(taken).toEqual([true]);
  });

  it.each([
    // [tries used, the tries allowed, the last one is the next]
    [1, 2, true],
    [0, 2, false],
    [2, 3, true],
    [1, 3, false],
    [19, 20, true],
    [4, 5, true],
    [3, 5, false],
    [0, 1, true],
  ] as const)(
    'tells the last try: a mail with %s tries used, %s tries allowed: %s',
    async (used, allowed, last) => {
      const rows = await inOwnerTx(async (db) => {
        const campaign = await sendingCampaign(db);
        await mailIn(db, campaign, { attempts: used, minutesAgo: 60 });
        const outcome = await claimWith(db, 10, [campaign], 10, allowed);
        return outcome.ok ? outcome.rows : [];
      });

      expect(rows.map((row) => row.last_attempt)).toEqual([last]);
    },
  );

  it('rejects a mail whose tries are used up by the number of tries given, not by five', async () => {
    const { rows, state } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign, { attempts: 3, minutesAgo: 60 });
      const outcome = await claimWith(db, 10, [campaign], 10, 3);
      return {
        rows: outcome.ok ? outcome.rows : null,
        state: (await statesOf(db, [mail.id]))[0]!,
      };
    });

    expect(rows).toEqual([]);
    expect(state.status).toBe('rejected');
  });

  it('gives a mail with four tries used when six are allowed, and counts the fifth', async () => {
    const { rows, state } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign, { attempts: 5, minutesAgo: 60 });
      const outcome = await claimWith(db, 10, [campaign], 10, 6);
      return {
        rows: outcome.ok ? outcome.rows : null,
        state: (await statesOf(db, [mail.id]))[0]!,
      };
    });

    expect(rows).toHaveLength(1);
    expect(rows![0]!.last_attempt).toBe(true);
    expect(state).toMatchObject({ status: 'queued', attempts: 6 });
  });

  it.each([
    ['a lease of no minutes', 0, 5],
    ['a negative lease', -1, 5],
    ['a lease over a day', 1441, 5],
    ['no lease', null, 5],
    ['no tries', 10, 0],
    ['a negative number of tries', 10, -1],
    ['more than twenty tries', 10, 21],
    ['no number of tries', 10, null],
  ])('refuses %s, and takes nothing', async (_what, lease, tries) => {
    const { outcome, state } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign);
      return {
        outcome: await claimWith(db, 10, [campaign], lease, tries),
        state: (await statesOf(db, [mail.id]))[0]!,
      };
    });

    expect(codeOf(outcome)).toBe(
      lease === null || lease < 1 || lease > 1440
        ? 'NEWSLETTER_LEASE_INVALID'
        : 'NEWSLETTER_ATTEMPTS_INVALID',
    );
    expect(state).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it.each([
    ['one minute', 1, 5],
    ['a day', 1440, 5],
    ['one try', 10, 1],
    ['twenty tries', 10, 20],
  ])('takes %s', async (_what, lease, tries) => {
    const outcome = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      await mailIn(db, campaign);
      return claimWith(db, 10, [campaign], lease, tries);
    });

    expect(outcome.ok && outcome.rows).toHaveLength(1);
  });

  it('refuses a portion over a thousand, and takes one of a thousand', async () => {
    const { over, top } = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      await mailIn(db, campaign);
      return {
        over: await claimWith(db, 1001, [campaign], 10, 5),
        top: await claimWith(db, 1000, [campaign], 10, 5),
      };
    });

    expect(codeOf(over)).toBe('NEWSLETTER_LIMIT_INVALID');
    expect(top.ok && top.rows).toHaveLength(1);
  });

  it('refuses a portion over a thousand before it puts anything away', async () => {
    const state = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign, { attempts: 5, minutesAgo: 60 });
      await claimWith(db, 5000, [campaign], 10, 5);
      return (await statesOf(db, [mail.id]))[0]!;
    });

    expect(state.status).toBe('queued');
  });

  it('keeps a portion of nothing: below one it takes nothing, and puts away what is due', async () => {
    const state = await inOwnerTx(async (db) => {
      const campaign = await sendingCampaign(db);
      const mail = await mailIn(db, campaign, { attempts: 5, minutesAgo: 60 });
      const outcome = await claimWith(db, 0, [campaign], 10, 5);
      expect(outcome).toEqual({ ok: true, rows: [] });
      return (await statesOf(db, [mail.id]))[0]!;
    });

    expect(state.status).toBe('rejected');
  });

  it.each([
    ['a guest', GUEST],
    ['no actor', () => null],
  ])('still refuses %s, and does not read the bounds first', async (_who, actor) => {
    const outcome = await inOwnerTx(async (db) =>
      attemptAs<Claimed>(db, actor(), SQL.claimWith, 10, null, 0, 0),
    );

    expect(codeOf(outcome)).toBe('NEWSLETTER_FORBIDDEN');
  });
});
