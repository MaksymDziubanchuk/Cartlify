import type { NewsletterCampaignStatus as CampaignStatus, Prisma } from '@prisma/client';

import type { LimitCampaign } from '@helpers/newsletterLimit.js';

type Tx = Prisma.TransactionClient;

// What the limit of the campaigns of the shop (at most `count` in any window of `days` days,
// checkSendingLimit) reads from the database, and the lock that keeps it honest. A manager scheduling a
// campaign (campaignSchedule.service.ts) and the pass that starts one (sendingStore.helper.ts) both take
// the lock first and read the campaigns that count under it, so two of them never pass together.

// the key of the lock, one for the whole shop (a transaction lock of the database: it goes with the
// transaction, a crash leaves nothing held)
export const NEWSLETTER_SCHEDULE_LOCK = 'cartlify.newsletter_schedule';

// the states in which a campaign went out, and counts at the time it began
export const STARTED_STATUSES: CampaignStatus[] = ['sending', 'finished', 'stopped'];

const DAY_MS = 24 * 60 * 60 * 1000;

// Takes the lock of the schedule until the end of the transaction
export async function lockSchedule(db: Tx): Promise<void> {
  await db.$executeRaw`select pg_advisory_xact_lock(hashtext(${NEWSLETTER_SCHEDULE_LOCK}))`;
}

// The campaigns that count and lie within a window of `at`, without the campaign `exceptId`: the ones
// that went out (sending, finished, stopped) at the time they began, and, when `counting` is 'all', the
// scheduled ones at their time. A campaign further than the length of a window from `at` cannot share
// one with it, so only the ones nearer are read. A draft and a cancelled campaign never count.
// - Scheduling counts 'all': a campaign goes in beside everything that is planned.
// - A campaign about to start counts 'started': the ones that went out. The ones that are scheduled
//   still wait for their turn and are judged when it comes (the earlier ones are judged before it, the
//   pass takes them by their time), so the campaign that is first in line is never refused for the sake
//   of one that comes after it.
export async function campaignsNear(
  db: Tx,
  at: Date,
  days: number,
  exceptId: number,
  counting: 'all' | 'started' = 'all',
): Promise<LimitCampaign[]> {
  const span = days * DAY_MS;
  const within = { gt: new Date(at.getTime() - span), lt: new Date(at.getTime() + span) };

  const rows = await db.newsletterCampaign.findMany({
    where: {
      id: { not: exceptId },
      OR: [
        ...(counting === 'all' ? [{ status: 'scheduled' as const, scheduledAt: within }] : []),
        { status: { in: STARTED_STATUSES }, startedAt: within },
      ],
    },
    select: { id: true, name: true, status: true, scheduledAt: true, startedAt: true },
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    at: (row.status === 'scheduled' ? row.scheduledAt : row.startedAt) as Date,
  }));
}
