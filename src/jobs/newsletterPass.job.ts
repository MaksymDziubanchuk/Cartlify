import env from '@config/env.js';
import { shopSettings } from '@config/shopSettings.js';
import { failureOf } from '@helpers/failureOf.js';
import { mapWithLimit } from '@helpers/mapWithLimit.js';
import { redisKeys } from '@redis/keys.js';
import { takeRedisLock } from '@redis/lock.js';
import { resolveCampaignProducts } from '@routes/api/newsletters/services/helpers/campaignProducts.helper.js';
import {
  clearSendingHalt,
  markSendingHalted,
} from '@routes/api/newsletters/services/helpers/sendingHalt.helper.js';
import {
  deliverRecipient,
  dropHeld,
  judgeHeld,
  materialReader,
  PassHalt,
  releaseHeld,
  type DeliveryContext,
  type DeliveryResult,
  type SendingLogger,
} from '@routes/api/newsletters/services/helpers/sendRecipient.helper.js';
import {
  claimRecipients,
  dueCampaigns,
  finishCampaigns,
  mailsSentOnDayOf,
  mailsWaiting,
  releaseRecipients,
  startCampaign,
  type ClaimedRecipient,
} from '@routes/api/newsletters/services/helpers/sendingStore.helper.js';

// A pass of the newsletters: the one function that sends them. It starts the campaigns whose time has
// come, takes the mails that wait in portions and sends them within the daily limit, and finishes the
// campaigns with nothing left to send. It is run by the service of periodic tasks (a cron of the
// host calls `npm run newsletter:run`, src/jobs/newsletterRun.ts), and by hand until that exists.
// Only one pass runs at a time (a lock in redis); a pass that finds the lock held ends at once.
//
// What a pass leaves for the next one is in the database: a mail that waits stays queued (what did not
// fit in the day, what SendGrid did not take yet), a campaign with such mails stays sending. A pass
// can be run again at any time; a mail is leased to the pass that took it (the claim of the database),
// so no mail is sent by two at once.

// how long a pass may run before it stops taking new portions
export const PASS_DEADLINE_MS = 4 * 60 * 1000;

// how long the lock of a pass is held at most: the deadline, and the portion that is on its way when
// it comes (50 mails, 5 at a time, each up to the 7 seconds SendGrid is given), with room to spare. A
// pass that dies leaves the lock until then
const LOCK_MARGIN_MS = 3 * 60 * 1000;

const BATCH_SIZE = 50;
const CONCURRENCY = 5;
// a pause between two portions, so a long pass does not hammer SendGrid or the database
const PAUSE_MS = 200;

export type NewsletterPassOptions = {
  log: SendingLogger;
  // the clock of the pass; tests set it, the sending is told the time by it (the day of the limit, the
  // time of a mail)
  now?: Date;
  // how long the pass may take, by the real clock
  deadlineMs?: number;
  // the daily limit; the setting of the server (NEWSLETTER_DAILY_LIMIT) unless set
  dailyLimit?: number;
  batchSize?: number;
  concurrency?: number;
  pauseMs?: number;
  // only these campaigns (the rest are left as they are)
  campaignIds?: number[];
};

// why the sending stopped: nothing is left to take now, the day's limit is spent, the time is up, the
// stream has a problem (the pass stopped and left the mails queued), or another pass held the lock
export type NewsletterPassReason = 'done' | 'daily_limit' | 'deadline' | 'halted' | 'locked';

export type NewsletterPassSummary = {
  reason: NewsletterPassReason;
  // campaigns started, campaigns called off because the limit of the campaigns left no room, mails taken
  launched: number;
  cancelled: number;
  claimed: number;
  // how the mails taken ended (a mail the database put away before taking it is in none of these):
  // - rejected: SendGrid will not take them, or their tries are used up;
  // - retried: SendGrid was busy, they wait out their lease to be tried again;
  // - released: given back to the queue untried (or tried and found SendGrid busy) with the try not
  //   counted, free at once: the campaign was stopped, or the pass stopped on a problem of the stream;
  // - deferred: refused by SendGrid in a run that stopped the pass; they keep the try they used and wait
  //   out their lease, behind the mails with fewer tries
  sent: number;
  rejected: number;
  retried: number;
  skipped: number;
  released: number;
  deferred: number;
  // campaigns finished
  finished: number;
};

const emptySummary = (reason: NewsletterPassReason): NewsletterPassSummary => ({
  reason,
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Starts the campaigns whose time has come, the oldest first. The limit of the campaigns of the shop is
// asked again for each, as the shop sets it now (it may have been lowered since the campaign was
// scheduled): one the limit leaves no room for is called off for good (cancelled, the reason `limit`),
// and a manager copies it and schedules the copy for a time that fits. One that cannot be started for
// another reason stays scheduled, the next pass tries again
async function launchDueCampaigns(
  opts: NewsletterPassOptions,
  now: Date,
): Promise<{ launched: number; cancelled: number }> {
  let launched = 0;
  let cancelled = 0;

  for (const campaign of await dueCampaigns(now, opts.campaignIds)) {
    try {
      // the data of the products is taken outside any transaction (it is many queries) and fixed for
      // the campaign
      const snapshot = await resolveCampaignProducts(campaign.content, { now });
      const started = await startCampaign(campaign.id, snapshot, shopSettings().shopLocale, now);

      // not scheduled any more: cancelled, or started by another pass, meanwhile
      if (started.status === 'not_scheduled') continue;

      if (started.status === 'over_limit') {
        cancelled += 1;
        opts.log.warn(
          { campaignId: campaign.id, limit: started.limit, campaigns: started.campaigns },
          'newsletter campaign was called off, the limit of the campaigns left no room',
        );
        continue;
      }

      launched += 1;
      opts.log.info(
        { campaignId: campaign.id, planned: started.planned },
        'newsletter campaign started',
      );
    } catch (err) {
      opts.log.error(
        { campaignId: campaign.id, ...failureOf(err) },
        'newsletter campaign could not be started, it stays scheduled',
      );
    }
  }

  return { launched, cancelled };
}

// where each way a mail can end is counted in the summary (a mail that is gone counts nowhere, and a
// mail that is held counts when it is judged: judgeHeld, releaseHeld)
const COUNTED_IN: Record<DeliveryResult, 'sent' | 'rejected' | 'skipped' | 'released' | null> = {
  sent: 'sent',
  held: null,
  rejected: 'rejected',
  skipped: 'skipped',
  released: 'released',
  gone: null,
};

// Sends one portion, a few mails at once. Returns null when it went through, or why it stopped: the
// mails not tried and the mails held (the ones that showed the problem) are settled (giveBack), the
// ones that were tried and judged keep their outcome
async function sendPortion(
  rows: ClaimedRecipient[],
  ctx: DeliveryContext,
  summary: NewsletterPassSummary,
  concurrency: number,
): Promise<PassHalt | null> {
  const settled = new Set<number>();

  try {
    await mapWithLimit(rows, concurrency, async (row) => {
      let result: DeliveryResult;

      try {
        result = await deliverRecipient(row, ctx);
      } catch (err) {
        throw err instanceof PassHalt
          ? err
          : new PassHalt('database_failed', {
              reason: String(failureOf(err).code ?? failureOf(err).type),
            });
      }

      settled.add(row.recipientId);
      const counter = COUNTED_IN[result];
      if (counter) summary[counter] += 1;
    });

    // the last mail of the portion may be the one that showed the stream has a problem
    return ctx.halted === null ? null : await giveBack(rows, settled, ctx, summary, ctx.halted);
  } catch (err) {
    const halt = err instanceof PassHalt ? err : new PassHalt('database_failed');

    return giveBack(rows, settled, ctx, summary, halt);
  }
}

// The pass stops on a problem of the stream. The mails not tried lose the try their lease counted: a
// stopped pass must not wear them out. The mails held, the ones whose failures showed the problem, are
// settled by releaseHeld: none is rejected for it; a mail that found SendGrid busy goes back like the
// ones not tried, a mail that was refused keeps its try and waits out its lease. A mail SendGrid has
// taken is not given back, whatever failed after it took it: it stays as it is, and if its row could
// not be written down it is free when its lease runs out
async function giveBack(
  rows: ClaimedRecipient[],
  settled: Set<number>,
  ctx: DeliveryContext,
  summary: NewsletterPassSummary,
  halt: PassHalt,
): Promise<PassHalt> {
  try {
    const untried = rows
      .filter((row) => !settled.has(row.recipientId) && !ctx.accepted.has(row.recipientId))
      .map((row) => row.recipientId);
    summary.released += await releaseRecipients(untried);
    await releaseHeld(ctx);
  } catch (releaseErr) {
    ctx.log.warn(
      failureOf(releaseErr),
      'newsletter mails that were taken could not be given back, they are free after their lease',
    );
  }

  return halt;
}

// the portions: until nothing is left to take now, the day's limit is spent, the time is up, or the
// stream has a problem
async function sendWithinLimit(
  opts: NewsletterPassOptions,
  summary: NewsletterPassSummary,
  clock: () => Date,
  deadlineAt: number,
): Promise<NewsletterPassReason> {
  const dailyLimit = opts.dailyLimit ?? env.NEWSLETTER_DAILY_LIMIT;
  const batchSize = opts.batchSize ?? BATCH_SIZE;
  const concurrency = opts.concurrency ?? CONCURRENCY;
  const pauseMs = opts.pauseMs ?? PAUSE_MS;

  const ctx: DeliveryContext = {
    log: opts.log,
    clock,
    material: materialReader(),
    held: { refused: [], unavailable: [] },
    tally: summary,
    halted: null,
    accepted: new Set(),
    failures: new Map(),
  };

  const reason = await sendPortions(opts, summary, clock, deadlineAt, ctx, {
    dailyLimit,
    batchSize,
    concurrency,
    pauseMs,
  });

  // a pass that was not stopped by a problem of the stream judges the mails still held: the streaks
  // are over, and no streak was long enough to be the fault of the stream
  if (reason !== 'halted') await judgeHeld(ctx);

  return reason;
}

async function sendPortions(
  opts: NewsletterPassOptions,
  summary: NewsletterPassSummary,
  clock: () => Date,
  deadlineAt: number,
  ctx: DeliveryContext,
  {
    dailyLimit,
    batchSize,
    concurrency,
    pauseMs,
  }: {
    dailyLimit: number;
    batchSize: number;
    concurrency: number;
    pauseMs: number;
  },
): Promise<NewsletterPassReason> {
  while (true) {
    if (Date.now() >= deadlineAt) return 'deadline';

    // the mails the provider took today, in every campaign, count against the limit; what does not
    // fit stays queued for the next day
    const left = dailyLimit - (await mailsSentOnDayOf(clock()));
    if (left <= 0) return 'daily_limit';

    const rows = await claimRecipients(Math.min(batchSize, left), opts.campaignIds);
    if (rows.length === 0) return 'done';
    summary.claimed += rows.length;
    // a mail held for an earlier try, whose lease ran out within the pass, is judged by this one
    dropHeld(
      ctx,
      rows.map((row) => row.recipientId),
    );

    ctx.failures.clear();
    const halt = await sendPortion(rows, ctx, summary, concurrency);

    if (ctx.failures.size > 0) {
      opts.log.warn(
        { failures: Object.fromEntries(ctx.failures) },
        'newsletter mails were not taken by the provider',
      );
    }

    if (halt) {
      opts.log.error(
        { why: halt.why, ...halt.detail },
        'newsletter pass stopped, the mails not tried stay queued',
      );
      await markHalted(opts, halt, clock());
      return 'halted';
    }

    await sleep(pauseMs);
  }
}

// writes the stop for the alert of the admins (the time of the last stop); a failure of redis is only
// told: the pass has done what it could
async function markHalted(opts: NewsletterPassOptions, halt: PassHalt, at: Date): Promise<void> {
  try {
    await markSendingHalted(halt.why, at);
  } catch (err) {
    opts.log.warn(
      failureOf(err),
      'the stop of the newsletter pass could not be written for the alert',
    );
  }
}

// Takes the stop away once the stream has proved sound: a pass that took a mail, or that found no mail
// of a sending campaign left in the queue at all (queued or leased). A pass that proved nothing leaves
// it as it is: the limit of the day was spent, its time was up at once, or the claim came back empty only
// because the mails that wait are leased to a try that is not over (SendGrid was busy again). A pass
// that stopped on a problem has just written the stop
async function clearHalted(opts: NewsletterPassOptions, summary: NewsletterPassSummary) {
  if (summary.reason === 'halted') return;

  try {
    if (summary.sent === 0 && (await mailsWaiting(opts.campaignIds))) return;

    await clearSendingHalt();
  } catch (err) {
    opts.log.warn(failureOf(err), 'the stop of the newsletter pass could not be taken away');
  }
}

export async function runNewsletterPass(
  opts: NewsletterPassOptions,
): Promise<NewsletterPassSummary> {
  const clock = () => opts.now ?? new Date();
  const deadlineMs = opts.deadlineMs ?? PASS_DEADLINE_MS;
  const deadlineAt = Date.now() + deadlineMs;

  // throws 503 REDIS_UNAVAILABLE while redis is down: the lock keeps two passes from spending the limit
  // twice, so no pass runs without it
  const lock = await takeRedisLock(redisKeys.newsletterPassLock, deadlineMs + LOCK_MARGIN_MS);
  if (!lock) {
    opts.log.info('newsletter pass skipped, another pass is running');
    return emptySummary('locked');
  }

  const summary = emptySummary('done');

  try {
    const launch = await launchDueCampaigns(opts, clock());
    summary.launched = launch.launched;
    summary.cancelled = launch.cancelled;
    summary.reason = await sendWithinLimit(opts, summary, clock, deadlineAt);
    await clearHalted(opts, summary);
    summary.finished = await finishCampaigns(clock(), opts.campaignIds);
  } finally {
    if (!(await lock.release())) {
      opts.log.warn('newsletter pass lock had run out before the pass ended');
    }
  }

  opts.log.info({ ...summary }, 'newsletter pass finished');
  return summary;
}
