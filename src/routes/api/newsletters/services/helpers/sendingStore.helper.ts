import type { Prisma } from '@prisma/client';

import env from '@config/env.js';
import { newsletterLimit } from '@config/shopSettings.js';
import { getPgMessage, tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { checkSendingLimit } from '@helpers/newsletterLimit.js';
import { shopDayBounds } from '@helpers/shopDay.js';
import type { NewsletterContentDto, NewsletterSnapshotDto } from 'types/dto/newsletters.dto.js';

import { campaignsNear, lockSchedule } from './campaignLimit.helper.js';

type Tx = Prisma.TransactionClient;

// The database side of the sending of the newsletters (the pass, src/jobs/newsletterPass.job.ts). The
// system sends them: every step runs in its own transaction as the admin context without a user id.
// The steps that touch rows other sessions may take too are functions of the database (db/05, section
// NEWSLETTERS: THE SENDING); the rest are plain statements the policies let the system make.

// a transaction as the system
const asSystem = <T>(fn: (db: Tx) => Promise<T>, opts?: Parameters<typeof tx>[1]): Promise<T> =>
  tx(async (db) => {
    await setAdminContext(db);
    return fn(db);
  }, opts);

// a mail that waits, taken for the pass: what the sender needs to make it and send it
export type ClaimedRecipient = {
  recipientId: number;
  campaignId: number;
  locale: string;
  email: string;
  // the salt of the subscription, the token of "Manage the subscription" is made of it
  manageSalt: string;
  // the 5th try: a mail that fails again is given up
  lastAttempt: boolean;
  // when the mail was taken before this claim (the clock of the database, the one that writes the
  // lease); null for a mail taken for the first time
  previousTry: Date | null;
};

type ClaimRow = {
  recipient_id: number;
  campaign_id: number;
  locale: string;
  email: string;
  manage_salt: string;
  last_attempt: boolean;
  previous_try: Date | null;
};

// the campaigns that wait for their time, the oldest time first (a campaign is found by its state,
// not by its time: a cancelled one keeps the time it was scheduled for)
export function dueCampaigns(
  now: Date,
  only?: number[],
): Promise<Array<{ id: number; content: NewsletterContentDto }>> {
  return asSystem(async (db) => {
    const rows = await db.newsletterCampaign.findMany({
      where: {
        status: 'scheduled',
        scheduledAt: { lte: now },
        ...(only ? { id: { in: only } } : {}),
      },
      orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }],
      select: { id: true, content: true },
    });

    return rows.map((row) => ({
      id: row.id,
      content: row.content as unknown as NewsletterContentDto,
    }));
  });
}

// How a try to start a campaign ended:
// - started: the database made its list of mails and moved it to sending; `planned` is how many;
// - not_scheduled: it is not scheduled any more (a manager called it off, or another pass started it,
//   meanwhile): that is no failure;
// - over_limit: the limit of the campaigns of the shop leaves no room for it as the shop sets it now, so
//   it is called off for good (cancelled, with the reason `limit`); `campaigns` are the ones that fill
//   the windows it would break, `limit` the limit it was judged by.
export type StartResult =
  | { status: 'started'; planned: number }
  | { status: 'not_scheduled' }
  | { status: 'over_limit'; campaigns: number[]; limit: { count: number; days: number } };

// Starts a scheduled campaign at `now`. The limit of the campaigns is asked again, the way scheduling
// asked it, because the limit may have been lowered since the campaign was scheduled: under the lock of
// the schedule (the one the routes that schedule take, so none of them passes in between), the campaigns
// that went out are read, and a campaign that would break the limit is called off (the system's move
// scheduled to cancelled with the reason `limit`, which the guard of the table lets it make and nothing
// else). One that fits is started by the database (newsletter_start_campaign: its list of mails, then
// sending). The campaigns still scheduled are not counted: they are judged when their turn comes, so
// the one first in line is not refused for the sake of one after it. All in one transaction
export async function startCampaign(
  campaignId: number,
  snapshot: NewsletterSnapshotDto,
  shopLocale: string,
  now: Date,
): Promise<StartResult> {
  try {
    return await asSystem(
      async (db): Promise<StartResult> => {
        await lockSchedule(db);

        const current = await db.newsletterCampaign.findUnique({
          where: { id: campaignId },
          select: { status: true },
        });
        if (current?.status !== 'scheduled') return { status: 'not_scheduled' };

        const limit = newsletterLimit();
        const verdict = checkSendingLimit(
          await campaignsNear(db, now, limit.days, campaignId, 'started'),
          { id: campaignId, at: now },
          limit,
        );

        if (!verdict.allowed) {
          // the condition of the state is in the write: a manager who called the campaign off meanwhile
          // (cancelling takes no lock) keeps it
          const called = await db.newsletterCampaign.updateMany({
            where: { id: campaignId, status: 'scheduled' },
            data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'limit' },
          });
          if (called.count === 0) return { status: 'not_scheduled' };

          return {
            status: 'over_limit',
            campaigns: verdict.campaigns.map((campaign) => campaign.id),
            limit,
          };
        }

        const rows = await db.$queryRaw<Array<{ planned: number }>>`
          select cartlify.newsletter_start_campaign(${campaignId}::int, ${JSON.stringify(snapshot)}::jsonb, ${shopLocale}) as planned`;

        return { status: 'started', planned: rows[0]!.planned };
      },
      // the list of mails of a big audience is made in one statement
      { timeout: 60_000 },
    );
  } catch (err) {
    // cancelled between the read and the start (cancelling takes no lock): the database refuses
    const code = getPgMessage(err);
    if (code === 'NEWSLETTER_CAMPAIGN_NOT_SCHEDULED' || code === 'NEWSLETTER_CAMPAIGN_NOT_FOUND') {
      return { status: 'not_scheduled' };
    }
    throw err;
  }
}

// How many mails were taken by the provider on the day of the shop `now` falls in, in all campaigns:
// the daily limit is spent by them
export function mailsSentOnDayOf(now: Date): Promise<number> {
  const { start, end } = shopDayBounds(now);

  return asSystem((db) =>
    db.newsletterRecipient.count({ where: { sentAt: { gte: start, lt: end } } }),
  );
}

// A portion of the mails that wait (newsletter_claim_recipients): the mails with the fewest tries used
// first, and by id among those with the same; leased to this pass, the ones whose subscription ended put
// away. `only` narrows it to those campaigns. How long a mail taken by a pass is
// left to it before another may take it again (it is also the pause between the tries of a mail the
// provider failed on) and how many times a mail is tried are settings (NEWSLETTER_RETRY_MINUTES,
// NEWSLETTER_MAX_ATTEMPTS), read at every claim; the database keeps them within bounds
export async function claimRecipients(limit: number, only?: number[]): Promise<ClaimedRecipient[]> {
  const rows = await asSystem(
    (db) =>
      db.$queryRaw<ClaimRow[]>`
        select * from cartlify.newsletter_claim_recipients(
          ${limit}::int, ${only ?? null}::int[], ${env.NEWSLETTER_RETRY_MINUTES}::int, ${env.NEWSLETTER_MAX_ATTEMPTS}::int
        )`,
  );

  return rows.map((row) => ({
    recipientId: row.recipient_id,
    campaignId: row.campaign_id,
    locale: row.locale,
    email: row.email,
    manageSalt: row.manage_salt,
    lastAttempt: row.last_attempt,
    previousTry: row.previous_try,
  }));
}

// Whether the provider took a mail of the campaign at or after `since`, a time of the clock of the
// database (the previous try of a mail, as the claim gives it). A mail that was taken is written down
// with the clock of the database in its updatedAt (recordSent), so the two times are of one clock.
// Mails reported on later (a bounce) are not sent any more and do not count: their time is that of the
// report
export function acceptedSince(campaignId: number, since: Date): Promise<boolean> {
  return asSystem(async (db) => {
    const row = await db.newsletterRecipient.findFirst({
      where: { campaignId, status: 'sent', updatedAt: { gte: since } },
      select: { id: true },
    });

    return row !== null;
  });
}

// Whether a mail of a sending campaign is still in the queue, waiting or leased to a try that is not over
// (`only` narrows it to those campaigns)
export function mailsWaiting(only?: number[]): Promise<boolean> {
  return asSystem(async (db) => {
    const row = await db.newsletterRecipient.findFirst({
      where: {
        status: 'queued',
        campaign: { status: 'sending', ...(only ? { id: { in: only } } : {}) },
      },
      select: { id: true },
    });

    return row !== null;
  });
}

// gives back mails that were taken and not tried, or tried and found the provider busy
// (newsletter_release_recipients)
export async function releaseRecipients(ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;

  const rows = await asSystem(
    (db) =>
      db.$queryRaw<Array<{ released: number }>>`
        select cartlify.newsletter_release_recipients(${ids}::int[]) as released`,
  );

  return rows[0]!.released;
}

// where a mail and the things it depends on stand just before it is sent; null when the row is gone
// (the subscription was deleted)
export type DeliveryState = {
  mail: 'queued' | 'other';
  campaign: 'sending' | 'other';
  subscription: 'active' | 'other';
};

export async function deliveryStateOf(recipientId: number): Promise<DeliveryState | null> {
  const row = await asSystem((db) =>
    db.newsletterRecipient.findUnique({
      where: { id: recipientId },
      select: {
        status: true,
        campaign: { select: { status: true } },
        subscription: { select: { status: true } },
      },
    }),
  );
  if (!row) return null;

  return {
    mail: row.status === 'queued' ? 'queued' : 'other',
    campaign: row.campaign.status === 'sending' ? 'sending' : 'other',
    subscription: row.subscription.status === 'active' ? 'active' : 'other',
  };
}

// what the mails of a campaign are made of, fixed at its start: the text and the data of the products
export type CampaignMaterial = {
  content: NewsletterContentDto;
  snapshot: NewsletterSnapshotDto;
};

export async function campaignMaterialOf(campaignId: number): Promise<CampaignMaterial | null> {
  const row = await asSystem((db) =>
    db.newsletterCampaign.findUnique({
      where: { id: campaignId },
      select: { content: true, productsSnapshot: true },
    }),
  );
  if (!row || row.productsSnapshot === null) return null;

  return {
    content: row.content as unknown as NewsletterContentDto,
    snapshot: row.productsSnapshot as unknown as NewsletterSnapshotDto,
  };
}

// The mail was taken by the provider. The row goes from waiting to sent, with the id the provider gave
// it and the moment (`at`, the clock of the pass: the day of the limit is counted by it), and the
// campaign counts it, in one transaction (a campaign that was stopped meanwhile still counts the mail
// that was on its way). The row's updatedAt is the moment on the clock of the database, the one that
// writes the leases of the claim, so that "a mail was taken after the previous try of another"
// compares two times of one clock (acceptedSince). If the row is not waiting any more, the provider's
// own report of the mail (a bounce) came before the answer to the send was written: the status is left
// as the report made it, the id is put in, and the mail still counts as sent.
export function recordSent(args: {
  recipientId: number;
  campaignId: number;
  messageId?: string | undefined;
  at: Date;
}): Promise<void> {
  return asSystem(async (db) => {
    const moved = await db.newsletterRecipient.updateMany({
      where: { id: args.recipientId, status: 'queued' },
      data: {
        status: 'sent',
        sentAt: args.at,
        ...(args.messageId ? { providerMessageId: args.messageId } : {}),
      },
    });

    if (moved.count === 1) {
      await db.$executeRaw`
        update cartlify.newsletter_recipients
        set "updatedAt" = (now() at time zone 'utc')
        where id = ${args.recipientId}`;
    }

    if (moved.count === 0 && args.messageId) {
      await db.newsletterRecipient.updateMany({
        where: {
          id: args.recipientId,
          providerMessageId: null,
          status: { in: ['bounced', 'dropped', 'complained'] },
        },
        data: { providerMessageId: args.messageId },
      });
    }

    await db.newsletterCampaign.update({
      where: { id: args.campaignId },
      data: { sentCount: { increment: 1 } },
    });
  });
}

// The provider will not take the mail (or took no more tries): the row is rejected and the campaign
// counts it, once, however many times it is asked
export function recordRejected(args: { recipientId: number; campaignId: number }): Promise<void> {
  return asSystem(async (db) => {
    const moved = await db.newsletterRecipient.updateMany({
      where: { id: args.recipientId, status: 'queued' },
      data: { status: 'rejected' },
    });

    if (moved.count === 1) {
      await db.newsletterCampaign.update({
        where: { id: args.campaignId },
        data: { rejectedCount: { increment: 1 } },
      });
    }
  });
}

// the mail is left out: it counts in no total
export async function recordSkipped(recipientId: number): Promise<void> {
  await asSystem((db) =>
    db.newsletterRecipient.updateMany({
      where: { id: recipientId, status: 'queued' },
      data: { status: 'skipped' },
    }),
  );
}

// Finishes the campaigns that are sending and have no mail left that waits (also one with no mail
// from the start). One statement, so a campaign is finished only if nothing waits at that moment.
// Gives how many it finished
export function finishCampaigns(at: Date, only?: number[]): Promise<number> {
  return asSystem(async (db) => {
    const done = await db.newsletterCampaign.updateMany({
      where: {
        status: 'sending',
        recipients: { none: { status: 'queued' } },
        ...(only ? { id: { in: only } } : {}),
      },
      data: { status: 'finished', finishedAt: at },
    });

    return done.count;
  });
}
