import { Prisma } from '@prisma/client';

import { assertLimit } from '@helpers/assertLimit.js';
import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
import { likePattern } from '@helpers/likePattern.js';
import type { FindSubscribersDto } from 'types/dto/newsletters.dto.js';

// The list of subscribers for the people who run the newsletters: GET /api/newsletters/subscribers.
// The rows of every state that the filters keep, the newest first (the id grows with the time a
// subscription was asked for), one page and the number of all the rows the filters find

export const SUBSCRIBERS_DEFAULT_LIMIT = 20;
export const SUBSCRIBER_STATUSES = [
  'pending',
  'active',
  'paused_complaint',
  'stopped_bounce',
  'ended',
] as const;
export const SUBSCRIBER_SOURCES = ['form', 'account'] as const;
// the filter value for the subscriptions that have no language (their mails go in the shop's own)
export const NO_LOCALE_FILTER = 'none';

export type SubscribersQuery = {
  limit: number;
  email: string | null;
  statuses: string[] | null;
  sources: string[] | null;
  locales: string[] | null;
  withoutLocale: boolean;
  // the id of the last row of the page before; the rows after it are the next page
  after: number | null;
};

export type SubscriberRow = {
  id: number;
  email: string;
  source: 'form' | 'account';
  locale: string | null;
  status: 'pending' | 'active' | 'paused_complaint' | 'stopped_bounce' | 'ended';
  userId: number | null;
  createdAt: Date;
  confirmedAt: Date | null;
  endedAt: Date | null;
  endReason:
    | 'unsubscribed'
    | 'account_deleted'
    | 'removed_by_admin'
    | 'expired'
    | 'not_me'
    | 'bounced'
    | null;
};

// one value of the list or several through commas, each once
const namesOf = (value: string | undefined): string[] | null =>
  value ? [...new Set(value.split(',').map((name) => name.trim()))] : null;

export function normalizeSubscribersQuery(dto: FindSubscribersDto): SubscribersQuery {
  const email = dto.email?.trim();
  const locales = namesOf(dto.locale);

  return {
    limit: assertLimit(dto.limit ?? SUBSCRIBERS_DEFAULT_LIMIT),
    email: email ? email : null,
    statuses: namesOf(dto.status),
    sources: namesOf(dto.source),
    locales: locales ? locales.filter((locale) => locale !== NO_LOCALE_FILTER) : null,
    withoutLocale: locales?.includes(NO_LOCALE_FILTER) ?? false,
    // the cursor only names the row after which the page starts: it holds no value of the row, and
    // the order is one
    after: dto.cursor ? decodeCursor(dto.cursor).id : null,
  };
}

// the filters, the same for a page and for the total
function filtersOf(q: SubscribersQuery): Prisma.Sql[] {
  const parts: Prisma.Sql[] = [];

  // addresses are kept in lower case; the trigram index serves ilike
  if (q.email) parts.push(Prisma.sql`s.email ILIKE ${likePattern(q.email)} ESCAPE '\\'`);
  if (q.statuses) parts.push(Prisma.sql`s.status::text = ANY(${q.statuses}::text[])`);
  if (q.sources) parts.push(Prisma.sql`s.source::text = ANY(${q.sources}::text[])`);
  if (q.locales !== null) {
    const codes = q.locales;
    parts.push(
      q.withoutLocale
        ? Prisma.sql`(s.locale = ANY(${codes}::text[]) OR s.locale IS NULL)`
        : Prisma.sql`s.locale = ANY(${codes}::text[])`,
    );
  }

  return parts;
}

const whereOf = (parts: Prisma.Sql[]): Prisma.Sql =>
  parts.length ? Prisma.sql`WHERE ${Prisma.join(parts, ' AND ')}` : Prisma.empty;

// one page and one row more, which tells there is a next page. The columns are named one by one: a
// hash, a salt or a token of a subscription is not in a row of the list
export function buildSubscribersPageQuery(q: SubscribersQuery): Prisma.Sql {
  const parts = filtersOf(q);
  if (q.after !== null) parts.push(Prisma.sql`s.id < ${q.after}`);

  return Prisma.sql`
    SELECT
      s.id,
      s.email,
      s.source::text AS source,
      s.locale,
      s.status::text AS status,
      s."userId",
      s."createdAt",
      s."confirmedAt",
      s."endedAt",
      s."endReason"::text AS "endReason"
    FROM cartlify.newsletter_subscriptions s
    ${whereOf(parts)}
    ORDER BY s.id DESC
    LIMIT ${q.limit + 1}
  `;
}

export function buildSubscribersCountQuery(q: SubscribersQuery): Prisma.Sql {
  return Prisma.sql`
    SELECT count(*)::int AS total
    FROM cartlify.newsletter_subscriptions s
    ${whereOf(filtersOf(q))}
  `;
}

export const subscribersNextCursor = (last: SubscriberRow): string =>
  encodeCursor({ id: last.id, v: null });
