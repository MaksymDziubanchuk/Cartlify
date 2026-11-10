import type { Prisma } from '@prisma/client';

import { InternalError } from '@utils/errors.js';
import type {
  NewsletterLiveStatus,
  NewsletterManageStateDto,
  NewsletterSource,
  NewsletterSubscriptionDto,
} from 'types/dto/newsletters.dto.js';

type Tx = Prisma.TransactionClient;

// a row of cartlify.newsletter_profile_get: the subscription in force on the address of an account
type ProfileRow = {
  source: NewsletterSource;
  locale: string | null;
  status: NewsletterLiveStatus;
  can_change_locale: boolean;
  subscribed_at: Date;
};

// a row of cartlify.newsletter_manage_get: the subscription behind a link of management
type ManageRow = {
  email: string;
  source: NewsletterSource;
  locale: string | null;
  status: NewsletterLiveStatus;
  can_change_locale: boolean;
};

// The subscription in force on the address of the account, whichever made it; null when there is
// none. The function checks the owner (the context of the transaction is the account's) and that
// the address is verified (NEWSLETTER_EMAIL_NOT_VERIFIED)
export async function readProfileSubscription(
  db: Tx,
  userId: number,
): Promise<NewsletterSubscriptionDto | null> {
  const rows = await db.$queryRaw<ProfileRow[]>`
    select * from cartlify.newsletter_profile_get(${userId}::int)
  `;
  const row = rows[0];
  if (!row) return null;

  return {
    subscribed: true,
    source: row.source,
    status: row.status,
    locale: row.locale,
    canChangeLocale: row.can_change_locale,
    subscribedAt: row.subscribed_at,
  };
}

// The subscription behind the hash of a link of management. NEWSLETTER_LINK_INVALID when no
// subscription in force or paused has it; the answer of the function is never empty otherwise
export async function readManagedSubscription(
  db: Tx,
  manageHash: string,
): Promise<NewsletterManageStateDto> {
  const rows = await db.$queryRaw<ManageRow[]>`
    select * from cartlify.newsletter_manage_get(${manageHash}::text)
  `;
  const row = rows[0];
  if (!row) throw new InternalError({ reason: 'NEWSLETTER_MANAGE_GET_EMPTY' });

  return {
    email: row.email,
    source: row.source,
    locale: row.locale,
    status: row.status,
    canChangeLocale: row.can_change_locale,
  };
}
