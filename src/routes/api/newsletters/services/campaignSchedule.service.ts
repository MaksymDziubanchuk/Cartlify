import type { NewsletterCampaignStatus as CampaignStatus, Prisma } from '@prisma/client';

import env from '@config/env.js';
import { newsletterLimit } from '@config/shopSettings.js';
import { tx } from '@db/client.js';
import { writeNewsletterAuditLog } from '@db/adminAudit.helper.js';
import { setUserContext } from '@db/dbContext.service.js';
import { checkSendingLimit } from '@helpers/newsletterLimit.js';
import { parseShopTime } from '@helpers/shopTime.js';
import { BadRequestError, ConflictError, NotFoundError } from '@utils/errors.js';
import type {
  CampaignActionDto,
  NewsletterCampaignDto,
  NewsletterContentDto,
  ScheduleCampaignDto,
} from 'types/dto/newsletters.dto.js';

import { assertCampaignComplete, campaignOf, campaignOrNotFound } from './campaigns.service.js';
import { campaignsNear, lockSchedule } from './helpers/campaignLimit.helper.js';
import { withNewsletterErrors } from './helpers/newsletterErrors.helper.js';

type Tx = Prisma.TransactionClient;

// Scheduling, calling off and stopping a campaign: the three moves of a campaign that a manager makes
// after its text is written (the text itself is campaigns.service.ts). Every write carries the
// condition of the state it moves from, so a campaign the system started, or another manager moved,
// between the read and the write is refused with a code and not overwritten.
//
// Scheduling asks the limit of the shop (at most `count` campaigns in any window of `days` days,
// checkSendingLimit). Two managers scheduling at once must never both pass, so the whole request runs
// under a lock of the database, taken first and held until the write is committed: the campaigns that
// count are read again under it (campaignLimit.helper.ts). The pass that starts a campaign asks the
// limit again under the same lock (sendingStore.helper.ts).

// the states a campaign can be scheduled from
const SCHEDULABLE: CampaignStatus[] = ['draft', 'scheduled'];

// a write that moved no row: the campaign is gone (404) or is in a state the move does not start from
// (409, with the code of the move)
async function refuseLostRace(db: Tx, campaignId: number, code: string): Promise<never> {
  const again = await db.newsletterCampaign.findUnique({
    where: { id: campaignId },
    select: { id: true },
  });
  if (!again) throw new NotFoundError('NEWSLETTER_CAMPAIGN_NOT_FOUND');

  throw new ConflictError(code);
}

// Schedules a draft, or moves the time of a scheduled campaign. The time is exact when it has an
// offset and is read in the time zone of the shop when it has none; `runNow` is the moment the request
// is served. The refusals come in this order: a time that is no time (400, `VALIDATION_ERROR`), the
// campaign (404), its state (409), a time in the past (400, not for `runNow`), a content that is not
// whole (400), the limit of the shop (409). Lowering the limit touches no campaign that is scheduled
export async function scheduleCampaign(dto: ScheduleCampaignDto): Promise<NewsletterCampaignDto> {
  const asked = dto.runNow ? null : parseShopTime(dto.scheduledAt ?? '', env.SHOP_TIME_ZONE);
  if (!dto.runNow && asked === null) {
    throw new BadRequestError('VALIDATION_ERROR', [
      { in: 'body', field: 'scheduledAt', message: 'must be a time in ISO 8601 that exists' },
    ]);
  }

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });
      await lockSchedule(db);

      const current = await campaignOrNotFound(db, dto.campaignId);
      if (!SCHEDULABLE.includes(current.status)) {
        throw new ConflictError('NEWSLETTER_CAMPAIGN_NOT_SCHEDULABLE');
      }

      const now = new Date();
      const at = asked ?? now;
      if (at.getTime() < now.getTime()) {
        throw new BadRequestError('NEWSLETTER_SCHEDULE_IN_PAST', {
          scheduledAt: at.toISOString(),
          now: now.toISOString(),
        });
      }

      assertCampaignComplete(current.content as unknown as NewsletterContentDto);

      const limit = newsletterLimit();
      const verdict = checkSendingLimit(
        await campaignsNear(db, at, limit.days, current.id),
        { id: current.id, at },
        limit,
      );
      if (!verdict.allowed) {
        throw new ConflictError('NEWSLETTER_LIMIT_REACHED', {
          campaigns: verdict.campaigns.map(({ id, name, at: when }) => ({
            id,
            name,
            at: when.toISOString(),
          })),
          limit,
        });
      }

      const written = await db.newsletterCampaign.updateMany({
        where: { id: current.id, status: { in: SCHEDULABLE } },
        data: { status: 'scheduled', scheduledAt: at, updatedById: Number(dto.actorId) },
      });
      if (written.count === 0) {
        return refuseLostRace(db, current.id, 'NEWSLETTER_CAMPAIGN_NOT_SCHEDULABLE');
      }

      await writeNewsletterAuditLog(db, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        event: 'newsletter.campaign_scheduled',
        entityId: current.id,
        changes: [
          ...(current.status === 'scheduled'
            ? []
            : [{ field: 'status', old: current.status, new: 'scheduled' }]),
          {
            field: 'scheduledAt',
            old: current.scheduledAt?.toISOString() ?? null,
            new: at.toISOString(),
          },
        ],
      });

      return campaignOf(await campaignOrNotFound(db, current.id));
    }),
  );
}

// Calls off a scheduled campaign: it is cancelled and no longer counts against the limit. Only a
// scheduled campaign can be (one that began is stopped instead); the write carries the condition
export async function cancelCampaign(dto: CampaignActionDto): Promise<NewsletterCampaignDto> {
  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const current = await campaignOrNotFound(db, dto.campaignId);
      if (current.status !== 'scheduled') {
        throw new ConflictError('NEWSLETTER_CAMPAIGN_NOT_CANCELLABLE');
      }

      const written = await db.newsletterCampaign.updateMany({
        where: { id: current.id, status: 'scheduled' },
        data: { status: 'cancelled', cancelledAt: new Date(), updatedById: Number(dto.actorId) },
      });
      if (written.count === 0) {
        return refuseLostRace(db, current.id, 'NEWSLETTER_CAMPAIGN_NOT_CANCELLABLE');
      }

      await writeNewsletterAuditLog(db, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        event: 'newsletter.campaign_cancelled',
        entityId: current.id,
        changes: [{ field: 'status', old: 'scheduled', new: 'cancelled' }],
      });

      return campaignOf(await campaignOrNotFound(db, current.id));
    }),
  );
}

// Stops a campaign that is going out: what has been sent stays sent, and whoever has not been sent
// the mail yet will not be (the sending honours the state). Only a sending campaign can be stopped
export async function stopCampaign(dto: CampaignActionDto): Promise<NewsletterCampaignDto> {
  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const current = await campaignOrNotFound(db, dto.campaignId);
      if (current.status !== 'sending') {
        throw new ConflictError('NEWSLETTER_CAMPAIGN_NOT_STOPPABLE');
      }

      const written = await db.newsletterCampaign.updateMany({
        where: { id: current.id, status: 'sending' },
        data: { status: 'stopped', stoppedAt: new Date(), updatedById: Number(dto.actorId) },
      });
      if (written.count === 0) {
        return refuseLostRace(db, current.id, 'NEWSLETTER_CAMPAIGN_NOT_STOPPABLE');
      }

      await writeNewsletterAuditLog(db, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        event: 'newsletter.campaign_stopped',
        entityId: current.id,
        changes: [{ field: 'status', old: 'sending', new: 'stopped' }],
      });

      return campaignOf(await campaignOrNotFound(db, current.id));
    }),
  );
}
