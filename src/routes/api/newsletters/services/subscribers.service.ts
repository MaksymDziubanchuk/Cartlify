import { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { writeNewsletterAuditLog } from '@db/adminAudit.helper.js';
import { setUserContext } from '@db/dbContext.service.js';
import { NotFoundError } from '@utils/errors.js';
import type {
  EraseSubscriberDto,
  FindSubscribersDto,
  NewsletterLocaleBucketDto,
  NewsletterManagerDto,
  NewsletterSubscriberErasedResponseDto,
  NewsletterSubscriberItemDto,
  NewsletterSubscribersResponseDto,
  NewsletterSubscribersSummaryDto,
} from 'types/dto/newsletters.dto.js';

import { withNewsletterErrors } from './helpers/newsletterErrors.helper.js';
import {
  buildSubscribersCountQuery,
  buildSubscribersPageQuery,
  normalizeSubscribersQuery,
  subscribersNextCursor,
  type SubscriberRow,
} from './helpers/subscribersList.helper.js';

type Tx = Prisma.TransactionClient;

// The subscribers for the people who run the newsletters (root, and an admin whom root allowed; the
// routes have the guard). Every query runs as the actor, so the policies of the database let it read
// every subscription: the rows are the ones of every person, addresses included, and the columns are
// named one by one, never the hash of a token, the salt or the HMAC of an address

const toItem = (row: SubscriberRow): NewsletterSubscriberItemDto => ({
  id: row.id,
  email: row.email,
  source: row.source,
  locale: row.locale,
  status: row.status,
  userId: row.userId,
  createdAt: row.createdAt,
  confirmedAt: row.confirmedAt,
  endedAt: row.endedAt,
  endReason: row.endReason,
});

type GroupRow = { status: string; source: string; locale: string | null; count: number };

// the buckets by language, the largest first, equal ones by language, the one without a language last
const bucketOrder = (a: NewsletterLocaleBucketDto, b: NewsletterLocaleBucketDto) =>
  b.count - a.count ||
  (a.locale === null ? 1 : b.locale === null ? -1 : a.locale.localeCompare(b.locale));

// the numbers of the subscriptions: in force (active) in all, by language and by source, and the
// ones that wait for their confirmation, that a complaint paused and that a bounce stopped. One
// statement; a subscription that ended is counted nowhere
export async function getSubscribersSummary(
  dto: NewsletterManagerDto,
): Promise<NewsletterSubscribersSummaryDto> {
  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const groups = await db.$queryRaw<GroupRow[]>`
        SELECT s.status::text AS status, s.source::text AS source, s.locale, count(*)::int AS count
        FROM cartlify.newsletter_subscriptions s
        WHERE s.status IN ('pending', 'active', 'paused_complaint', 'stopped_bounce')
        GROUP BY s.status, s.source, s.locale
      `;

      const byStatus = (status: string) =>
        groups.filter((group) => group.status === status).reduce((sum, g) => sum + g.count, 0);
      const active = groups.filter((group) => group.status === 'active');

      const buckets = new Map<string | null, number>();
      for (const group of active) {
        buckets.set(group.locale, (buckets.get(group.locale) ?? 0) + group.count);
      }
      const bySource = (source: string) =>
        active.filter((group) => group.source === source).reduce((sum, g) => sum + g.count, 0);

      return {
        active: byStatus('active'),
        byLocale: [...buckets].map(([locale, count]) => ({ locale, count })).sort(bucketOrder),
        bySource: { form: bySource('form'), account: bySource('account') },
        pending: byStatus('pending'),
        pausedComplaint: byStatus('paused_complaint'),
        stoppedBounce: byStatus('stopped_bounce'),
      };
    }),
  );
}

export async function findSubscribers(
  dto: FindSubscribersDto,
): Promise<NewsletterSubscribersResponseDto> {
  // a cursor the list did not give is refused before the database is asked
  const q = normalizeSubscribersQuery(dto);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const rows = await db.$queryRaw<SubscriberRow[]>(buildSubscribersPageQuery(q));
      const [count] = await db.$queryRaw<{ total: number }[]>(buildSubscribersCountQuery(q));

      const hasNext = rows.length > q.limit;
      const page = hasNext ? rows.slice(0, q.limit) : rows;
      const last = page.at(-1);

      return {
        items: page.map(toItem),
        limit: q.limit,
        nextCursor: hasNext && last ? subscribersNextCursor(last) : null,
        total: count?.total ?? 0,
      };
    }),
  );
}

// what the audit line of an erasure says of the subscription: its state and its source, and never the
// address or anything that finds the person again
async function stateOf(db: Tx, id: number) {
  const rows = await db.$queryRaw<{ status: string; source: string }[]>`
    SELECT s.status::text AS status, s.source::text AS source
    FROM cartlify.newsletter_subscriptions s
    WHERE s.id = ${id}
  `;

  return rows[0] ?? null;
}

// The erasure of a subscriber on the word of the person: nothing is deleted, every subscription the
// address ever had is made anonymous in place (newsletter_admin_erase_address: the address becomes the
// placeholder of the row, what is live ends, the links and the hashes are replaced, the address and the
// browser of the journal are emptied; the rows stay as the proof of the consent, the blocklist and the
// mails of the campaigns are not touched). The line of the admin log is written in the same transaction,
// only when the function says it made a row anonymous, and names the subscriber by its id and never by
// the address. No mail goes to the person
export async function eraseSubscriber(
  dto: EraseSubscriberDto,
): Promise<NewsletterSubscriberErasedResponseDto> {
  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId: dto.actorId, role: dto.actorRole });

      const before = await stateOf(db, dto.subscriberId);
      if (!before) throw new NotFoundError('NEWSLETTER_SUBSCRIBER_NOT_FOUND');

      const rows = await db.$queryRaw<{ erased: number }[]>`
        select cartlify.newsletter_admin_erase_address(${dto.subscriberId}::int) as erased
      `;
      const erased = rows[0]?.erased ?? 0;

      // nothing left to erase: another admin erased the address between the read and the call, or
      // the subscription is gone, or it was anonymous already: the same answer as for an id that was
      // never there, and nothing to write
      if (erased < 1) throw new NotFoundError('NEWSLETTER_SUBSCRIBER_NOT_FOUND');

      // the state of the row named, after: a live one has ended, one that had ended stays as it was
      const after = await stateOf(db, dto.subscriberId);

      // the state, that the address is gone (never the address itself) and how many subscriptions of
      // the address were made anonymous
      await writeNewsletterAuditLog(db, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        event: 'newsletter.subscriber_erased',
        entityId: dto.subscriberId,
        changes: [
          { field: 'status', old: before.status, new: after?.status ?? null },
          { field: 'email', old: 'present', new: 'erased' },
          { field: 'subscriptions', old: null, new: erased },
        ],
      });

      return { erased: true as const, subscriptions: erased };
    }),
  );
}
