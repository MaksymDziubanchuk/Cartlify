import type { FastifyBaseLogger } from 'fastify';

import { tx } from '@db/client.js';
import { setGuestNullContext } from '@db/dbContext.service.js';
import { enabledLocaleOf } from '@helpers/locale.js';
import { clearSpamReport } from '@services/email/clearSpamReport.js';
import { BadRequestError, InternalError } from '@utils/errors.js';
import type {
  ManageActionDto,
  ManageLocaleDto,
  ManageStateDto,
  NewsletterExportResponseDto,
  NewsletterManageStateDto,
  NewsletterUnsubscribedResponseDto,
} from 'types/dto/newsletters.dto.js';

import { tokenHashOf } from './confirm.service.js';
import { withNewsletterErrors } from './helpers/newsletterErrors.helper.js';
import { readManagedSubscription } from './helpers/subscriptionState.helper.js';

// The page "Manage the subscription" of the frontend, behind the link of every mail to a subscriber.
// The token is the proof, so these steps ask nothing of who sends them (a guest, a signed-in user);
// the database function finds the subscription by the hash of the token and refuses with
// NEWSLETTER_LINK_INVALID the token that opens nothing, whether nobody was given it or its
// subscription is over: the same answer for both. Opening the page changes nothing, each change is a
// button

// the state of the subscription behind the link
export async function getManagedSubscription(
  dto: ManageStateDto,
): Promise<NewsletterManageStateDto> {
  const hash = tokenHashOf(dto.token);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setGuestNullContext(db);
      return readManagedSubscription(db, hash);
    }),
  );
}

// the language of a subscription of the form (a subscription of an account is changed in the
// profile: NEWSLETTER_LOCALE_NOT_ALLOWED); the new state is the answer
export async function setManagedLocale(dto: ManageLocaleDto): Promise<NewsletterManageStateDto> {
  const locale = enabledLocaleOf(dto.locale);
  if (!locale) throw new BadRequestError('LOCALE_INVALID');

  const hash = tokenHashOf(dto.token);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setGuestNullContext(db);

      await db.$queryRaw`
        select cartlify.newsletter_manage_set_locale(
          ${hash}::text, ${locale}::text, ${dto.ip}::text, ${dto.userAgent}::text
        ) as changed
      `;

      return readManagedSubscription(db, hash);
    }),
  );
}

// ends the subscription. A second press, or a link whose subscription ended some other way, answers
// the same: the person asked for the subscription to be over, and it is
export async function unsubscribeManaged(
  dto: ManageActionDto,
): Promise<NewsletterUnsubscribedResponseDto> {
  const hash = tokenHashOf(dto.token);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setGuestNullContext(db);

      await db.$queryRaw`
        select cartlify.newsletter_manage_unsubscribe(
          ${hash}::text, null::int, 'manage_page'::text, ${dto.ip}::text, ${dto.userAgent}::text
        ) as ended
      `;

      return { unsubscribed: true as const };
    }),
  );
}

// puts a subscription a complaint paused back in force. After the database has done it, the
// address leaves the list of complaints of the mail provider, or the provider would go on
// dropping every mail to it; that call can fail without undoing the resume, so it is only logged
export async function resumeManaged(
  dto: ManageActionDto,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<NewsletterManageStateDto> {
  const hash = tokenHashOf(dto.token);

  const { state, resumed } = await withNewsletterErrors(() =>
    tx(async (db) => {
      await setGuestNullContext(db);

      // refuses a link that opens nothing; true when the subscription was paused and is in force now
      const rows = await db.$queryRaw<{ resumed: boolean }[]>`
        select cartlify.newsletter_manage_resume(
          ${hash}::text, ${dto.ip}::text, ${dto.userAgent}::text
        ) as resumed
      `;

      return {
        resumed: rows[0]?.resumed === true,
        state: await readManagedSubscription(db, hash),
      };
    }),
  );

  if (resumed) await clearSpamReport(state.email, log);

  return state;
}

// the data of the subscription behind the link and its journal, for the person to keep
export async function exportManaged(dto: ManageStateDto): Promise<NewsletterExportResponseDto> {
  const hash = tokenHashOf(dto.token);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setGuestNullContext(db);

      const rows = await db.$queryRaw<{ data: NewsletterExportResponseDto | null }[]>`
        select cartlify.newsletter_manage_export(${hash}::text) as data
      `;

      const data = rows[0]?.data;
      if (!data) throw new InternalError({ reason: 'NEWSLETTER_MANAGE_EXPORT_EMPTY' });

      return data;
    }),
  );
}
