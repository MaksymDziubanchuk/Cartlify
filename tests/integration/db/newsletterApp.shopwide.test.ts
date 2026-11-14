import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';

import { inCommittedTx, inRolledBackTx, type Actor, type DbSession } from '../../helpers/db.js';
import {
  draftCampaignIn,
  eventRow,
  hex64,
  insertRow,
  insertSubscription,
  moveCampaignTo,
  recipientRow,
  removeNewsletterFixtures,
  removeSubscriptionRows,
  setupNewsletterFixtures,
  utc,
  type NewsletterFixtures,
} from '../../helpers/newsletterDb.js';
import {
  DAY,
  READER,
  SQL,
  SYSTEM,
  attemptAs,
  callAs,
  cleanupSql,
  codeOf,
  journalOf,
  publishPolicyWith,
  subscriptionById,
} from '../../helpers/newsletterFns.js';
import { inOwnerTx } from '../../helpers/ownerDb.js';

// the steps of the newsletters run by the role the app connects as (cartlify_app), with the real
// actor, on rows that are committed: the function has to be one the role may run, it has to act as
// the owner of the tables (security definer, its own search path) and it has to find the rows its
// actor may touch. The other files of this part try a step as the owner of the database, which
// would pass without either of these. A case moves the committed rows in a transaction that rolls
// back, so the rows stay as they were: a campaign that was started cannot be left in the database
// (only a draft is deleted), so the committed campaigns stay drafts and a case starts them.
// *.shopwide: the cleanups, the start and the reset of a language go over every row of the
// database and hold them until the case rolls back

let fx: NewsletterFixtures;
const subscriptionIds: number[] = [];
const blockedHmacs: string[] = [];
let ageing: { campaign: number; subscription: number; recipient: number };
let expired: number;
let waiting: number;
let longEnded: number;
let freshEnded: number;
let toBlock: { id: number; hmac: string };
let toRemove: number;

const MANAGER = (): Actor => ({ role: 'ADMIN', userId: fx.manager.id });
const ROOT = (): Actor => ({ role: 'ROOT', userId: fx.root.id });

beforeAll(async () => {
  fx = await setupNewsletterFixtures();

  // a draft campaign with a mail made long ago, for the cleanup of the mails
  const campaign = await inCommittedTx((db) => draftCampaignIn(db, MANAGER(), 'Ageing'));

  await inOwnerTx(
    async (db) => {
      const add = async (opts: Parameters<typeof insertSubscription>[1]) => {
        const id = await insertSubscription(db, opts);
        subscriptionIds.push(id);
        await insertRow(db, 'newsletter_subscription_events', eventRow(id));
        await insertRow(db, 'newsletter_subscription_events', eventRow(id, { event: 'confirmed' }));
        return id;
      };

      expired = await add({ status: 'pending', set: { confirmExpiresAt: utc(-DAY) } });
      waiting = await add({ status: 'pending' });
      longEnded = await add({
        status: 'ended',
        set: { createdAt: utc(-60 * DAY), endedAt: utc(-40 * DAY) },
      });
      freshEnded = await add({ status: 'ended' });

      const hmac = hex64();
      toBlock = { id: await add({ status: 'pending', set: { emailHmac: hmac } }), hmac };
      blockedHmacs.push(hmac);
      toRemove = await add({ status: 'active', locale: 'en' });
      await insertRow(db, 'newsletter_recipients', recipientRow(fx.campaign, toRemove));

      const subscription = await add({ status: 'active', locale: 'en' });
      ageing = {
        campaign,
        subscription,
        recipient: await insertRow(
          db,
          'newsletter_recipients',
          recipientRow(campaign, subscription, { createdAt: utc(-60 * DAY) }),
        ),
      };
    },
    { commit: true },
  );
});

afterAll(async () => {
  try {
    await removeSubscriptionRows(subscriptionIds, blockedHmacs);
    if (ageing) {
      // a draft is deleted by the one who runs the newsletters, its mails go with it
      await inOwnerTx(
        async (db) => {
          await db.as(ROOT());
          await db.rows('delete from cartlify.newsletter_campaigns where id = $1', ageing.campaign);
        },
        { commit: true },
      );
    }
    if (fx) await removeNewsletterFixtures(fx);
  } finally {
    await prisma.$disconnect();
  }
});

type Totals = { undeliveredCount: number; complaintCount: number };

// the state of the mail, of its campaign and of its subscription, read as root
async function stateOf(db: DbSession, recipient: number, campaign: number, subscription: number) {
  const [mail] = await callAs<{ status: string }>(
    db,
    READER,
    'select status::text as status from cartlify.newsletter_recipients where id = $1',
    recipient,
  );
  const [totals] = await callAs<Totals>(
    db,
    READER,
    'select "undeliveredCount", "complaintCount" from cartlify.newsletter_campaigns where id = $1',
    campaign,
  );
  return {
    mail: mail!.status,
    totals: totals!,
    subscription: (await subscriptionById(db, subscription))!.status,
  };
}

// the sending, in the name of the system, writes down that the mail left
const markSent = (db: DbSession, recipient: number) =>
  callAs(
    db,
    SYSTEM,
    `update cartlify.newsletter_recipients
     set status = 'sent', attempts = 1, "sentAt" = now() at time zone 'utc', "providerMessageId" = 'message-1'
     where id = $1`,
    recipient,
  );

describe('cartlify.newsletter_apply_event, run by the role of the app for the system', () => {
  const EXPECTED = {
    bounce: {
      mail: 'bounced',
      totals: { undeliveredCount: 1, complaintCount: 0 },
      subscription: 'stopped_bounce',
      line: 'bounced',
    },
    dropped: {
      mail: 'dropped',
      totals: { undeliveredCount: 1, complaintCount: 0 },
      subscription: 'active',
      line: null,
    },
    spamreport: {
      mail: 'complained',
      totals: { undeliveredCount: 0, complaintCount: 1 },
      subscription: 'paused_complaint',
      line: 'complaint',
    },
  } as const;

  it.each(Object.keys(EXPECTED) as (keyof typeof EXPECTED)[])(
    'takes %s of a mail that was sent, and changes the mail, the campaign and the subscription',
    async (event) => {
      const result = await inRolledBackTx(async (db) => {
        // the committed draft is started and its mail sent, the way the sending does it
        await moveCampaignTo(db, MANAGER(), fx.campaign, 'sending');
        await markSent(db, fx.recipient);
        const before = await stateOf(db, fx.recipient, fx.campaign, fx.formSub);

        const outcome = await attemptAs(db, SYSTEM, SQL.applyEvent, fx.recipient, event);

        return {
          before,
          outcome,
          after: await stateOf(db, fx.recipient, fx.campaign, fx.formSub),
          journal: await journalOf(db, fx.formSub),
        };
      });

      expect(result.before).toEqual({
        mail: 'sent',
        totals: { undeliveredCount: 0, complaintCount: 0 },
        subscription: 'active',
      });
      expect(result.outcome).toEqual({ ok: true, rows: [{ result: 'applied' }] });

      const expected = EXPECTED[event];
      expect(result.after).toEqual({
        mail: expected.mail,
        totals: expected.totals,
        subscription: expected.subscription,
      });
      expect(result.journal.map((line) => line.event)).toEqual(
        expected.line ? [expected.line] : [],
      );
    },
  );

  it('takes an event of a mail whose sending has not been written down yet', async () => {
    const result = await inRolledBackTx(async (db) => {
      await moveCampaignTo(db, MANAGER(), fx.campaign, 'sending');
      const outcome = await attemptAs(db, SYSTEM, SQL.applyEvent, fx.recipient, 'bounce');
      return { outcome, after: await stateOf(db, fx.recipient, fx.campaign, fx.formSub) };
    });

    expect(result.outcome).toEqual({ ok: true, rows: [{ result: 'applied' }] });
    expect(result.after).toMatchObject({ mail: 'bounced', subscription: 'stopped_bounce' });
  });

  it('takes an event after the campaign finished, and counts it in its totals', async () => {
    const result = await inRolledBackTx(async (db) => {
      await moveCampaignTo(db, MANAGER(), fx.campaign, 'finished');
      await markSent(db, fx.recipient);
      const outcome = await attemptAs(db, SYSTEM, SQL.applyEvent, fx.recipient, 'spamreport');
      return { outcome, after: await stateOf(db, fx.recipient, fx.campaign, fx.formSub) };
    });

    expect(result.outcome).toEqual({ ok: true, rows: [{ result: 'applied' }] });
    expect(result.after.totals).toEqual({ undeliveredCount: 0, complaintCount: 1 });
  });

  it('leaves the committed rows as they were: the case rolled back', async () => {
    await inRolledBackTx(async (db) => {
      const [campaign] = await callAs<{ status: string }>(
        db,
        READER,
        'select status::text as status from cartlify.newsletter_campaigns where id = $1',
        fx.campaign,
      );
      expect(campaign).toEqual({ status: 'draft' });
      expect((await subscriptionById(db, fx.formSub))!.status).toBe('active');
    });
  });
});

describe('the cleanups of the newsletters, run by the role of the app for the system', () => {
  const countOf = async (db: DbSession, table: string, column: string, id: number) => {
    const [row] = await callAs<{ n: string }>(
      db,
      READER,
      `select count(*) as n from cartlify.${table} where "${column}" = $1`,
      id,
    );
    return Number(row!.n);
  };

  const clean = async (db: DbSession, fn: Parameters<typeof cleanupSql>[0]): Promise<number> => {
    const outcome = await attemptAs<{ removed: number }>(db, SYSTEM, cleanupSql(fn));
    if (!outcome.ok) throw new Error(`${fn} refused: ${codeOf(outcome)}`);
    return Number(outcome.rows[0]!.removed);
  };

  it('removes the request that was not confirmed in time, with its journal, and no other', async () => {
    const result = await inRolledBackTx(async (db) => {
      const removed = await clean(db, 'cleanup_newsletter_pending');
      return {
        removed,
        expired: [
          await subscriptionById(db, expired),
          await countOf(db, 'newsletter_subscription_events', 'subscriptionId', expired),
        ],
        waiting: (await subscriptionById(db, waiting))?.status,
        waitingLines: await countOf(
          db,
          'newsletter_subscription_events',
          'subscriptionId',
          waiting,
        ),
      };
    });

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(result.expired).toEqual([null, 0]);
    expect(result.waiting).toBe('pending');
    expect(result.waitingLines).toBe(2);
  });

  it('removes the proof of the consent of a subscription that ended long ago, with its journal', async () => {
    const result = await inRolledBackTx(async (db) => {
      // the term is thirty days: the subscription that ended forty days ago is due, the one of today is not
      await publishPolicyWith(db, fx.root.id, { consent: 30, recipients: 30 });
      const removed = await clean(db, 'cleanup_newsletter_consent');
      return {
        removed,
        long: [
          await subscriptionById(db, longEnded),
          await countOf(db, 'newsletter_subscription_events', 'subscriptionId', longEnded),
        ],
        fresh: (await subscriptionById(db, freshEnded))?.status,
        inForce: (await subscriptionById(db, toRemove))?.status,
      };
    });

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(result.long).toEqual([null, 0]);
    // an ended subscription of today and one in force are never taken
    expect(result.fresh).toBe('ended');
    expect(result.inForce).toBe('active');
  });

  it('removes the rows of the mails of a campaign that ended long ago, and keeps the campaign', async () => {
    const result = await inRolledBackTx(async (db) => {
      await moveCampaignTo(db, MANAGER(), ageing.campaign, 'finished', utc(-40 * DAY));
      await publishPolicyWith(db, fx.root.id, { consent: 30, recipients: 30 });
      const before = await countOf(db, 'newsletter_recipients', 'campaignId', ageing.campaign);
      const removed = await clean(db, 'cleanup_newsletter_recipients');
      return {
        before,
        removed,
        after: await countOf(db, 'newsletter_recipients', 'campaignId', ageing.campaign),
        campaign: await countOf(db, 'newsletter_campaigns', 'id', ageing.campaign),
        subscription: (await subscriptionById(db, ageing.subscription))?.status,
        // the mail of a campaign that is not over (the committed draft) is kept
        draft: await countOf(db, 'newsletter_recipients', 'campaignId', fx.campaign),
      };
    });

    expect(result.before).toBe(1);
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(result.after).toBe(0);
    expect(result.campaign).toBe(1);
    expect(result.subscription).toBe('active');
    expect(result.draft).toBeGreaterThanOrEqual(1);
  });

  it('is refused to anybody but the system, and removes nothing', async () => {
    const outcomes = await inRolledBackTx(async (db) => {
      const out: (string | null)[] = [];
      for (const actor of [MANAGER(), ROOT()]) {
        out.push(codeOf(await attemptAs(db, actor, cleanupSql('cleanup_newsletter_pending'))));
      }
      return { out, expired: (await subscriptionById(db, expired))?.status };
    });

    expect(outcomes.out).toEqual(['RETENTION_CLEANUP_FORBIDDEN', 'RETENTION_CLEANUP_FORBIDDEN']);
    expect(outcomes.expired).toBe('pending');
  });
});

describe('the people who run the newsletters, run by the role of the app on committed rows', () => {
  it('blocks an address: the request that waits for its address goes with its journal', async () => {
    const result = await inRolledBackTx(async (db) => {
      const outcome = await attemptAs(
        db,
        MANAGER(),
        SQL.blockAdd,
        toBlock.hmac,
        'asked by the person',
      );
      const [entry] = await callAs<{ blockedById: number; byPerson: boolean; reason: string }>(
        db,
        READER,
        'select "blockedById", "byPerson", reason from cartlify.newsletter_form_blocklist where "emailHmac" = $1',
        toBlock.hmac,
      );
      return {
        outcome,
        entry,
        request: await subscriptionById(db, toBlock.id),
        lines: (await journalOf(db, toBlock.id)).length,
      };
    });

    expect(result.outcome).toEqual({ ok: true, rows: [{ added: true }] });
    expect(result.entry).toEqual({
      blockedById: fx.manager.id,
      byPerson: false,
      reason: 'asked by the person',
    });
    expect(result.request).toBeNull();
    expect(result.lines).toBe(0);
  });

  it('erases a subscriber in force: the row stays, anonymous, with its mails', async () => {
    const result = await inRolledBackTx(async (db) => {
      const outcome = await attemptAs(db, MANAGER(), SQL.adminErase, toRemove);
      const [mails] = await callAs<{ n: string }>(
        db,
        READER,
        'select count(*) as n from cartlify.newsletter_recipients where "subscriptionId" = $1',
        toRemove,
      );
      return {
        outcome,
        row: await subscriptionById(db, toRemove),
        lines: (await journalOf(db, toRemove)).length,
        mails: Number(mails!.n),
      };
    });

    expect(result.outcome).toEqual({ ok: true, rows: [{ erased: 1 }] });
    expect(result.row).toMatchObject({
      email: `deleted+${toRemove}@deleted.invalid`,
      status: 'ended',
    });
    // the journal and the mails of the campaigns are not touched, only the address is gone
    expect(result.mails).toBe(1);
  });

  it('allows an admin to run the newsletters, who then runs them, and takes the right away', async () => {
    const result = await inRolledBackTx(async (db) => {
      const runs = async () =>
        (
          await callAs<{ manager: boolean }>(
            db,
            { role: 'ADMIN', userId: fx.plainAdmin.id },
            'select cartlify.newsletter_manager() as manager',
          )
        )[0]!.manager;

      const before = await runs();
      const on = await attemptAs(db, ROOT(), SQL.setManager, fx.plainAdmin.id, true);
      const during = await runs();
      const off = await attemptAs(db, ROOT(), SQL.setManager, fx.plainAdmin.id, false);
      return { before, on, during, off, after: await runs() };
    });

    expect(result).toEqual({
      before: false,
      on: { ok: true, rows: [{ changed: true }] },
      during: true,
      off: { ok: true, rows: [{ changed: true }] },
      after: false,
    });
  });
});

describe('the languages, run by the role of the app for root', () => {
  it('counts the language of the committed subscriptions and resets it', async () => {
    const hmac = hex64();
    const id = await inOwnerTx(
      async (db) =>
        insertSubscription(db, { status: 'active', locale: 'zw', set: { emailHmac: hmac } }),
      { commit: true },
    );
    subscriptionIds.push(id);

    const result = await inRolledBackTx(async (db) => {
      const counts = await callAs<{ locale: string; accounts: number; subscriptions: number }>(
        db,
        ROOT(),
        SQL.localeCounts,
      );
      const outcome = await attemptAs(db, ROOT(), SQL.resetLocale, 'zw');
      return {
        counts: counts.filter((row) => row.locale === 'zw'),
        outcome,
        row: await subscriptionById(db, id),
        lines: (await journalOf(db, id)).map((line) => line.event),
      };
    });

    expect(result.counts).toEqual([{ locale: 'zw', accounts: 0, subscriptions: 1 }]);
    expect(result.outcome).toEqual({ ok: true, rows: [{ accounts: 0, subscriptions: 1 }] });
    expect(result.row!.locale).toBeNull();
    expect(result.lines).toEqual(['locale_reset']);
  });
});
