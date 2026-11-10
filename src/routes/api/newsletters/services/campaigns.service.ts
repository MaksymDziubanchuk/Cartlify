import { Prisma, type NewsletterCampaignStatus as CampaignStatus } from '@prisma/client';

import { shopSettings } from '@config/shopSettings.js';
import { tx } from '@db/client.js';
import { writeNewsletterAuditLog, type AuditChange } from '@db/adminAudit.helper.js';
import { setUserContext } from '@db/dbContext.service.js';
import { assertLimit } from '@helpers/assertLimit.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { newsletterAllowedDomains, newsletterTrustedDomains } from '@helpers/newsletterDomains.js';
import { webOrigin } from '@helpers/webOrigin.js';
import { BadRequestError, ConflictError, NotFoundError } from '@utils/errors.js';
import { NEWSLETTER_CAMPAIGNS_DEFAULT_LIMIT } from '@schemas/dto/newslettersCampaign.dtoSchemas.js';
import type {
  CampaignActionDto,
  CreateCampaignDto,
  FindCampaignsDto,
  NewsletterCampaignDeletedResponseDto,
  NewsletterCampaignDto,
  NewsletterCampaignItemDto,
  NewsletterCampaignsResponseDto,
  NewsletterContentDto,
  NewsletterContentInputDto,
  UpdateCampaignDto,
} from 'types/dto/newsletters.dto.js';

import { withNewsletterErrors } from './helpers/newsletterErrors.helper.js';
import { shareCondition, type CampaignShare } from './helpers/campaignShares.helper.js';
import {
  checkNewsletterContent,
  disabledAmong,
  disabledLocalesOf,
  emptyNewsletterContent,
  localesForContent,
  missingInContent,
} from './helpers/newsletterContent.helper.js';

type Tx = Prisma.TransactionClient;

// The content as it is now: the structure judged again against the languages the shop answers in and
// its address (they may have changed since it was written), and what it still lacks. A language root
// turned off since stays in the content and is not refused for it, and nothing is asked of its text:
// it does not go out (nobody has the language, the sending takes the language of each person at the
// start), and it goes again if the language is turned on and someone chooses it, so the campaign is
// judged by the languages that are on. Asked when a campaign is scheduled and when the text of a
// scheduled one changes: a scheduled campaign is always one that can go out
export function assertCampaignComplete(content: NewsletterContentDto): void {
  const { enabledLocales, shopLocale } = shopSettings();
  const checked = checkNewsletterContent(content as NewsletterContentInputDto, {
    locales: localesForContent(enabledLocales, content),
    origin: webOrigin,
    domains: newsletterAllowedDomains(),
    trusted: newsletterTrustedDomains(),
  });

  const missing = missingInContent(checked, shopLocale, enabledLocales);
  if (missing.length > 0) throw new BadRequestError('NEWSLETTER_CONTENT_INCOMPLETE', { missing });
}

// The campaigns of the newsletters for the people who run them (root, and an admin whom root
// allowed; the routes have the guard). Every query runs as the actor, so the policies of the
// database see the right again: all of them see every campaign. The text of a campaign changes only
// while it is a draft or a scheduled campaign; the guard of the database holds that too, but the
// conditions here come first, so the answer is a code and not a refusal of the database. Changing the
// time and the state of a campaign is for the routes that schedule, cancel and stop it.

const NAME_MAX = 200;

// the states in which the text may change, and the one in which a campaign may be deleted
const EDITABLE: CampaignStatus[] = ['draft', 'scheduled'];

const ITEM_SELECT = {
  id: true,
  name: true,
  status: true,
  scheduledAt: true,
  cancelReason: true,
  missingLocale: true,
  plannedCount: true,
  sentCount: true,
  rejectedCount: true,
  undeliveredCount: true,
  complaintCount: true,
  unsubscribedCount: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.NewsletterCampaignSelect;

// the data of the products taken at the start is not part of the answer
const FULL_SELECT = {
  ...ITEM_SELECT,
  content: true,
  updatedById: true,
  copiedFromId: true,
  startedAt: true,
  finishedAt: true,
  stoppedAt: true,
  cancelledAt: true,
} satisfies Prisma.NewsletterCampaignSelect;

type ItemRow = Prisma.NewsletterCampaignGetPayload<{ select: typeof ITEM_SELECT }>;
export type FullRow = Prisma.NewsletterCampaignGetPayload<{ select: typeof FULL_SELECT }>;

// `disabledLocales`: the languages the campaign has a subject in that the shop does not answer in
// now. Its text in them stays (and can be kept and edited) but does not go out
const itemOf = (row: ItemRow, disabledLocales: string[]): NewsletterCampaignItemDto => ({
  id: row.id,
  name: row.name,
  status: row.status,
  scheduledAt: row.scheduledAt,
  cancelReason: row.cancelReason,
  missingLocale: row.missingLocale,
  counters: {
    planned: row.plannedCount,
    sent: row.sentCount,
    rejected: row.rejectedCount,
    undelivered: row.undeliveredCount,
    complaints: row.complaintCount,
    unsubscribed: row.unsubscribedCount,
  },
  disabledLocales,
  createdById: row.createdById,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export const campaignOf = (row: FullRow): NewsletterCampaignDto => ({
  ...itemOf(row, disabledLocalesOf(row.content, shopSettings().enabledLocales)),
  content: row.content as unknown as NewsletterContentDto,
  updatedById: row.updatedById,
  copiedFromId: row.copiedFromId,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  stoppedAt: row.stoppedAt,
  cancelledAt: row.cancelledAt,
});

// The content to keep: judged against the languages the shop answers in now and its address. A
// content that replaces a stored one (`stored`) may also keep the languages that one has and root
// turned off since, but never bring a new one in
const checkedContent = (
  content: NewsletterContentInputDto,
  stored?: unknown,
): NewsletterContentDto =>
  checkNewsletterContent(content, {
    locales: localesForContent(shopSettings().enabledLocales, stored),
    origin: webOrigin,
    domains: newsletterAllowedDomains(),
    trusted: newsletterTrustedDomains(),
  });

// the same json whatever the order of the keys (the database keeps the keys of a json in its own order)
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

// The name of a copy: "Copy of" and the name, cut to the 200 characters a name may have (counted as
// characters, so a sign of two halves is not cut in the middle), without a space left at the end
function copyNameOf(name: string): string {
  return Array.from(`Copy of ${name}`).slice(0, NAME_MAX).join('').trim();
}

export const campaignOrNotFound = async (db: Tx, id: number): Promise<FullRow> => {
  const row = await db.newsletterCampaign.findUnique({ where: { id }, select: FULL_SELECT });
  if (!row) throw new NotFoundError('NEWSLETTER_CAMPAIGN_NOT_FOUND');

  return row;
};

// A draft in the name of the actor. Without a content it has no language and no block
export async function createCampaign(dto: CreateCampaignDto): Promise<NewsletterCampaignDto> {
  const name = dto.name.trim();
  const missingLocale = dto.missingLocale ?? 'shop_locale';
  const content = dto.content ? checkedContent(dto.content) : emptyNewsletterContent();

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const row = await db.newsletterCampaign.create({
        data: {
          name,
          missingLocale,
          content: content as unknown as Prisma.InputJsonValue,
          createdById: Number(dto.actorId),
          updatedById: Number(dto.actorId),
        },
        select: FULL_SELECT,
      });

      await writeNewsletterAuditLog(db, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        event: 'newsletter.campaign_created',
        entityId: row.id,
        changes: [
          { field: 'name', old: null, new: name },
          { field: 'missingLocale', old: null, new: missingLocale },
          ...(dto.content ? [{ field: 'content', old: null, new: null }] : []),
        ],
      });

      return campaignOf(row);
    }),
  );
}

// the states of the filter of the list: one or several through commas, each once
const statusesOf = (value: string | undefined): CampaignStatus[] | null =>
  value ? ([...new Set(value.split(','))] as CampaignStatus[]) : null;

// The shares of the filters, each the share of the mails of its own kind, in the unit of the share:
// per cent for the first two, thousandths for the complaints (SHARE_UNITS)
const SHARE_FILTERS = [
  ['undelivered', 'undeliveredOver'],
  ['rejected', 'rejectedOver'],
  ['complaints', 'complaintsOver'],
] as const satisfies ReadonlyArray<readonly [CampaignShare, keyof FindCampaignsDto]>;

// The ids of the campaigns whose shares are all over the numbers asked (the rule of a share is one
// place, shareCondition: the alerts count with it). A comparison of two columns is no filter of
// Prisma, so the campaigns are picked by the database first
async function campaignsOverShares(db: Tx, dto: FindCampaignsDto): Promise<number[] | null> {
  const conditions = SHARE_FILTERS.flatMap(([share, name]) => {
    const over = dto[name];
    return typeof over === 'number' ? [shareCondition(share, over)] : [];
  });
  if (conditions.length === 0) return null;

  const rows = await db.$queryRaw<{ id: number }[]>`
    select t.id from cartlify.newsletter_campaigns as t where ${Prisma.join(conditions, ' and ')}
  `;
  return rows.map((row) => row.id);
}

// The languages each campaign has a subject in, by id: the list shows which of them the shop has
// turned off, and reads only the keys of the subjects, not the contents
async function languagesOfCampaigns(db: Tx, ids: number[]): Promise<Map<number, string[]>> {
  if (ids.length === 0) return new Map();

  const rows = await db.$queryRaw<{ id: number; languages: string[] }[]>`
    select t.id,
      array(
        select k.key
        from jsonb_object_keys(
          case when jsonb_typeof(t.content -> 'subject') = 'object'
            then t.content -> 'subject' else '{}'::jsonb end
        ) as k(key)
      ) as languages
    from cartlify.newsletter_campaigns as t
    where t.id in (${Prisma.join(ids)})
  `;

  return new Map(rows.map((row) => [row.id, row.languages]));
}

// The campaigns of every state and every maker, the newest first, a page at a time (the cursor names
// the last row of the page before). No content: it is long, and the list is for choosing. The filters
// are the ones the alerts of the newsletters send to: the states, when a campaign started, is
// scheduled for or was called off (a time with a bound taken in is `from`, a bound left out is
// `to`), why it was called off, and the share of its mails that went wrong
export async function findCampaigns(
  dto: FindCampaignsDto,
): Promise<NewsletterCampaignsResponseDto> {
  // a cursor the list did not give is refused before the database is asked
  const limit = assertLimit(dto.limit ?? NEWSLETTER_CAMPAIGNS_DEFAULT_LIMIT);
  const after = dto.cursor ? decodeCursor(dto.cursor).id : null;
  const statuses = statusesOf(dto.status);
  const started: Prisma.DateTimeNullableFilter = {
    ...(dto.startedFrom ? { gte: new Date(dto.startedFrom) } : {}),
    ...(dto.startedTo ? { lt: new Date(dto.startedTo) } : {}),
  };

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const overShares = await campaignsOverShares(db, dto);
      const filters: Prisma.NewsletterCampaignWhereInput = {
        ...(statuses ? { status: { in: statuses } } : {}),
        ...(Object.keys(started).length > 0 ? { startedAt: started } : {}),
        ...(dto.scheduledTo ? { scheduledAt: { lt: new Date(dto.scheduledTo) } } : {}),
        ...(dto.cancelReason ? { cancelReason: dto.cancelReason } : {}),
        ...(dto.cancelledFrom ? { cancelledAt: { gte: new Date(dto.cancelledFrom) } } : {}),
        ...(overShares ? { id: { in: overShares } } : {}),
      };

      const rows = await db.newsletterCampaign.findMany({
        where: after === null ? filters : { AND: [filters, { id: { lt: after } }] },
        orderBy: { id: 'desc' },
        take: limit + 1,
        select: ITEM_SELECT,
      });
      const total = await db.newsletterCampaign.count({ where: filters });

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      const languages = await languagesOfCampaigns(
        db,
        page.map((row) => row.id),
      );
      const enabled = shopSettings().enabledLocales;

      return {
        items: page.map((row) => itemOf(row, disabledAmong(languages.get(row.id) ?? [], enabled))),
        limit,
        nextCursor: rows.length > limit && last ? encodeCursor({ id: last.id, v: null }) : null,
        total,
      };
    }),
  );
}

export async function getCampaign(dto: CampaignActionDto): Promise<NewsletterCampaignDto> {
  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      return campaignOf(await campaignOrNotFound(db, dto.campaignId));
    }),
  );
}

// Changes the name, the rule for a language without a text, or the whole content (replaced, not
// merged). Only while the campaign is a draft or scheduled: the write itself carries the condition,
// so a campaign the system started between the read and the write is refused too. A request that
// changes nothing writes nothing (the maker and the time of the last change stay) and has no line in
// the admin log; the line names the fields that changed and never the texts
export async function updateCampaign(dto: UpdateCampaignDto): Promise<NewsletterCampaignDto> {
  const name = dto.name?.trim();

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      // The new content is judged against the stored one: the languages the campaign has that root
      // turned off since may stay in it, a new one may not. A content that is refused is refused
      // before a campaign that is not there, and before a campaign that cannot be changed
      const found = await db.newsletterCampaign.findUnique({
        where: { id: dto.campaignId },
        select: FULL_SELECT,
      });
      if (!found) {
        if (dto.content) checkedContent(dto.content);
        throw new NotFoundError('NEWSLETTER_CAMPAIGN_NOT_FOUND');
      }

      const current = found;
      const content = dto.content ? checkedContent(dto.content, current.content) : undefined;
      if (!EDITABLE.includes(current.status)) {
        throw new ConflictError('NEWSLETTER_CAMPAIGN_NOT_EDITABLE');
      }

      const data: Prisma.NewsletterCampaignUncheckedUpdateManyInput = {};
      const changes: AuditChange[] = [];

      if (name !== undefined && name !== current.name) {
        data.name = name;
        changes.push({ field: 'name', old: current.name, new: name });
      }
      if (dto.missingLocale !== undefined && dto.missingLocale !== current.missingLocale) {
        data.missingLocale = dto.missingLocale;
        changes.push({
          field: 'missingLocale',
          old: current.missingLocale,
          new: dto.missingLocale,
        });
      }
      if (content !== undefined && !sameJson(content, current.content)) {
        // a scheduled campaign stays one that can go out: its new text is as complete as scheduling
        // asked (a draft may be unfinished)
        if (current.status === 'scheduled') assertCampaignComplete(content);

        data.content = content as unknown as Prisma.InputJsonValue;
        changes.push({ field: 'content', old: null, new: null });
      }

      if (changes.length === 0) return campaignOf(current);

      // the state that was read: a draft scheduled meanwhile was not checked for completeness
      const written = await db.newsletterCampaign.updateMany({
        where: { id: dto.campaignId, status: current.status },
        data: { ...data, updatedById: Number(dto.actorId) },
      });

      if (written.count === 0) {
        // not editable any more, or deleted: the system started it, or a manager removed it
        const again = await db.newsletterCampaign.findUnique({
          where: { id: dto.campaignId },
          select: { id: true },
        });
        if (!again) throw new NotFoundError('NEWSLETTER_CAMPAIGN_NOT_FOUND');

        throw new ConflictError('NEWSLETTER_CAMPAIGN_NOT_EDITABLE');
      }

      await writeNewsletterAuditLog(db, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        event: 'newsletter.campaign_updated',
        entityId: dto.campaignId,
        changes,
      });

      return campaignOf(await campaignOrNotFound(db, dto.campaignId));
    }),
  );
}

// Deletes a draft. A campaign in any other state is kept: what was planned or sent stays in the
// logs and the totals. The delete carries the condition of the state, as the change does
export async function deleteCampaign(
  dto: CampaignActionDto,
): Promise<NewsletterCampaignDeletedResponseDto> {
  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const current = await campaignOrNotFound(db, dto.campaignId);
      if (current.status !== 'draft') throw new ConflictError('NEWSLETTER_CAMPAIGN_NOT_DELETABLE');

      const removed = await db.newsletterCampaign.deleteMany({
        where: { id: dto.campaignId, status: 'draft' },
      });

      if (removed.count === 0) {
        // another manager deleted it, or it is not a draft any more
        const again = await db.newsletterCampaign.findUnique({
          where: { id: dto.campaignId },
          select: { id: true },
        });
        if (!again) throw new NotFoundError('NEWSLETTER_CAMPAIGN_NOT_FOUND');

        throw new ConflictError('NEWSLETTER_CAMPAIGN_NOT_DELETABLE');
      }

      await writeNewsletterAuditLog(db, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        event: 'newsletter.campaign_deleted',
        entityId: dto.campaignId,
        changes: [{ field: 'name', old: current.name, new: null }],
      });

      return { deleted: true as const };
    }),
  );
}

// A new draft with the name ("Copy of" and the old one), the rule for a language without a text and
// the content of a campaign in any state. The data of its products is not copied: it is taken again
// when the copy starts
export async function copyCampaign(dto: CampaignActionDto): Promise<NewsletterCampaignDto> {
  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const source = await campaignOrNotFound(db, dto.campaignId);
      const name = copyNameOf(source.name);

      const row = await db.newsletterCampaign.create({
        data: {
          name,
          missingLocale: source.missingLocale,
          content: source.content as Prisma.InputJsonValue,
          createdById: Number(dto.actorId),
          updatedById: Number(dto.actorId),
          copiedFromId: source.id,
        },
        select: FULL_SELECT,
      });

      await writeNewsletterAuditLog(db, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        event: 'newsletter.campaign_copied',
        entityId: row.id,
        changes: [
          { field: 'name', old: null, new: name },
          { field: 'copiedFromId', old: null, new: source.id },
        ],
      });

      return campaignOf(row);
    }),
  );
}
