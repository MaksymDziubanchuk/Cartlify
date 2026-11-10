import { tx } from '@db/client.js';
import { setGuestNullContext } from '@db/dbContext.service.js';
import { hashToken } from '@helpers/tokenHash.js';
import { BadRequestError } from '@utils/errors.js';
import type {
  ConfirmSubscriptionDto,
  ConfirmSubscriptionResponseDto,
  DeclineSubscriptionDto,
  DeclineSubscriptionResponseDto,
} from 'types/dto/newsletters.dto.js';

import { withNewsletterErrors } from './helpers/newsletterErrors.helper.js';

// The database keeps only the hash of the token of a mail. A token with nothing but spaces in it is
// one nobody was given, like any other
export function tokenHashOf(token: string): string {
  const clean = token.trim();
  if (!clean) throw new BadRequestError('NEWSLETTER_LINK_INVALID');

  return hashToken(clean);
}

// The button "Confirm the subscription" of the mail of a confirmation. The page of the frontend
// reads the token of the link and posts it here; the link opened alone changes nothing. The token
// works once, for three days, and only the newest mail's does. Open to anybody who has the token:
// the database function does not look at who asks
export async function confirmSubscription(
  dto: ConfirmSubscriptionDto,
): Promise<ConfirmSubscriptionResponseDto> {
  const hash = tokenHashOf(dto.token);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setGuestNullContext(db);

      const rows = await db.$queryRaw<
        { outcome: 'confirmed' | 'invalid'; locale: string | null }[]
      >`
        select * from cartlify.newsletter_confirm(${hash}::text, ${dto.ip}::text, ${dto.userAgent}::text)
      `;

      const row = rows[0];
      if (!row || row.outcome !== 'confirmed') throw new BadRequestError('NEWSLETTER_LINK_INVALID');

      return { status: 'active' as const, locale: row.locale };
    }),
  );
}

// The second button of the same mail, "This is not me": the address goes to the blocklist of the
// form and the request, with its journal, is removed. The token of the mail is the proof that the
// reader owns the box, as for the confirmation
export async function declineSubscription(
  dto: DeclineSubscriptionDto,
): Promise<DeclineSubscriptionResponseDto> {
  const hash = tokenHashOf(dto.token);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setGuestNullContext(db);

      const rows = await db.$queryRaw<{ done: boolean }[]>`
        select cartlify.newsletter_not_me(${hash}::text, ${dto.ip}::text, ${dto.userAgent}::text) as done
      `;

      if (rows[0]?.done !== true) throw new BadRequestError('NEWSLETTER_LINK_INVALID');

      return { blocked: true as const };
    }),
  );
}
