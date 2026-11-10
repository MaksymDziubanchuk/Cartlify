import type { Prisma } from '@prisma/client';

import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import type { Role } from 'types/user.js';

type Tx = Prisma.TransactionClient;

// What the export of a person says of the newsletter: the subscriptions their own address has had
// and the journal of each. The fields are agreed by name (notes/newsletter-steps.md, step 5; the
// list of the export in notes/users.md): a column a table gets later never joins the export by
// itself. Never a token, a hash, a salt, the HMAC of the address, an id of a row or of an admin.
export type ExportedNewsletterEvent = {
  event: string;
  place: string;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
  // the version of the privacy policy a line of consent was written under
  privacyVersion: number | null;
  // the campaign an unsubscribe came from
  campaignId: number | null;
};

export type ExportedNewsletterSubscription = {
  status: string;
  source: string;
  locale: string | null;
  createdAt: string;
  confirmedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  events: ExportedNewsletterEvent[];
};

// what cartlify.newsletter_profile_export gives: more than the export keeps (the address, the
// language of each line), the list below is what stays
type SubscriptionJson = {
  subscriptions: (Omit<ExportedNewsletterSubscription, 'events'> & {
    events: (ExportedNewsletterEvent & { locale: string | null })[];
  })[];
};

// The subscriptions of the account that the person confirmed, whichever made them (the account or
// the form), the ones that ended too, the oldest first; an empty list for an account that has none.
// A request that never was confirmed is not given: nobody agreed to it, and it may have been made by
// someone else who typed the address. The function serves the owner of the account and the system
// only, so root asking for another person's data asks as the system for this one step, and the
// context goes back to root's after it. An account that is alive must have proved its address (the
// function refuses it otherwise): for an account that never did, nothing that sits on the address is
// its data, and the export gives an empty list instead of failing. A deleted account has no address of
// its own any more, so the function finds its subscriptions by its id: those the account made
// (userId) and those of the form that its deletion ended (endedUserId)
export async function newsletterSubscriptionsOf(
  tx: Tx,
  who: {
    subjectId: number;
    actorId: number;
    actorRole: Role;
    isVerified: boolean;
    isDeleted: boolean;
  },
): Promise<ExportedNewsletterSubscription[]> {
  if (!who.isVerified && !who.isDeleted) return [];

  const asSystem = who.actorId !== who.subjectId;
  if (asSystem) await setAdminContext(tx);

  const rows = await tx.$queryRaw<{ data: SubscriptionJson }[]>`
    select cartlify.newsletter_profile_export(${who.subjectId}::int) as data
  `;

  if (asSystem) await setUserContext(tx, { userId: who.actorId, role: who.actorRole });

  return (rows[0]?.data.subscriptions ?? []).map((subscription) => ({
    status: subscription.status,
    source: subscription.source,
    locale: subscription.locale,
    createdAt: subscription.createdAt,
    confirmedAt: subscription.confirmedAt,
    endedAt: subscription.endedAt,
    endReason: subscription.endReason,
    events: subscription.events.map((line) => ({
      event: line.event,
      place: line.place,
      createdAt: line.createdAt,
      ip: line.ip,
      userAgent: line.userAgent,
      privacyVersion: line.privacyVersion,
      campaignId: line.campaignId,
    })),
  }));
}
