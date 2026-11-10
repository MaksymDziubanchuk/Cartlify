import { tx } from '@db/client.js';
import { setGuestNullContext } from '@db/dbContext.service.js';
import { MAX_ID } from '@schemas/idPathParam.js';
import type { NewsletterUnsubscribedResponseDto, OneClickDto } from 'types/dto/newsletters.dto.js';

import { tokenHashOf } from './confirm.service.js';
import { withNewsletterErrors } from './helpers/newsletterErrors.helper.js';

// The id of the campaign the address names in ?c=. It is only for the count of the campaign, so what
// cannot be read as the id of a row is passed over: the person pressed a button of their mail
// program, and the unsubscribe must not fail over a number
export function campaignIdOf(raw: string | undefined): number | null {
  if (raw === undefined || !/^[1-9][0-9]{0,9}$/.test(raw)) return null;

  const id = Number(raw);
  return id <= MAX_ID ? id : null;
}

// The one-click unsubscribe of a mail client (RFC 8058): every mail of the newsletters carries
// List-Unsubscribe with this address, and the client posts List-Unsubscribe=One-Click to it by
// itself when the reader presses its button. No session, no csrf token, no captcha: the token in
// the address is the proof, the token of the unsubscribe of the subscription (not the one of the page
// of management, which opens more). The subscription ends at once; a subscription that is over
// already answers the same, so a second press or a client that posts twice harms nothing. A token
// nobody was given, the token of the page of management among them, is NEWSLETTER_LINK_INVALID
export async function oneClickUnsubscribe(
  dto: OneClickDto,
): Promise<NewsletterUnsubscribedResponseDto> {
  const hash = tokenHashOf(dto.token);
  const campaign = campaignIdOf(dto.campaign);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setGuestNullContext(db);

      await db.$queryRaw`
        select cartlify.newsletter_unsubscribe_one_click(
          ${hash}::text, ${campaign}::int, ${dto.ip}::text, ${dto.userAgent}::text
        ) as ended
      `;

      return { unsubscribed: true as const };
    }),
  );
}
