import type { FastifyBaseLogger } from 'fastify';
import type { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { enabledLocaleOf } from '@helpers/locale.js';
import { clearSpamReport } from '@services/email/clearSpamReport.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '@utils/errors.js';
import type {
  NewsletterProfileResponseDto,
  NewsletterSubscriptionDto,
  NewsletterUnsubscribedResponseDto,
  ProfileActionDto,
  ProfileDto,
  ProfileLocaleDto,
} from 'types/dto/newsletters.dto.js';

import { withNewsletterErrors } from './helpers/newsletterErrors.helper.js';
import { readProfileSubscription } from './helpers/subscriptionState.helper.js';

type Tx = Prisma.TransactionClient;

// The newsletters in the profile of a signed-in user, any role. The address is the one of the
// account (it has to be verified: NEWSLETTER_EMAIL_NOT_VERIFIED, the functions say so), and what the
// profile works on is the subscription in force on that address, whether the account or the form
// made it. The context of each transaction is the account itself, the functions check the owner

function userIdOf(dto: ProfileDto): number {
  return Number(dto.actorId);
}

// the subscription in force, or the 404 of a profile that has none
async function requireSubscription(db: Tx, userId: number): Promise<NewsletterSubscriptionDto> {
  const subscription = await readProfileSubscription(db, userId);
  if (!subscription) throw new NotFoundError('NEWSLETTER_NOT_SUBSCRIBED');

  return subscription;
}

export async function getProfileSubscription(
  dto: ProfileDto,
): Promise<NewsletterProfileResponseDto> {
  const userId = userIdOf(dto);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId, role: dto.actorRole });

      return (await readProfileSubscription(db, userId)) ?? { subscribed: false as const };
    }),
  );
}

// the language of a subscription of the account; one of the form is changed on the page its mails
// link to (NEWSLETTER_LOCALE_NOT_ALLOWED)
export async function setProfileLocale(dto: ProfileLocaleDto): Promise<NewsletterSubscriptionDto> {
  const locale = enabledLocaleOf(dto.locale);
  if (!locale) throw new BadRequestError('LOCALE_INVALID');

  const userId = userIdOf(dto);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId, role: dto.actorRole });

      await db.$queryRaw`
        select cartlify.newsletter_profile_set_locale(
          ${userId}::int, ${locale}::text, ${dto.ip}::text, ${dto.userAgent}::text
        ) as changed
      `;

      return requireSubscription(db, userId);
    }),
  );
}

// ends the subscription in force on the address; with none to end the answer is the same, the
// person asked for it to be over and it is
export async function unsubscribeProfile(
  dto: ProfileActionDto,
): Promise<NewsletterUnsubscribedResponseDto> {
  const userId = userIdOf(dto);

  return withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId, role: dto.actorRole });

      await db.$queryRaw`
        select cartlify.newsletter_profile_unsubscribe(
          ${userId}::int, ${dto.ip}::text, ${dto.userAgent}::text
        ) as ended
      `;

      return { unsubscribed: true as const };
    }),
  );
}

// puts a subscription a complaint paused back in force, then takes the address off the list of
// complaints of the mail provider (only logged when that fails: the resume stands)
export async function resumeProfile(
  dto: ProfileActionDto,
  log: Pick<FastifyBaseLogger, 'warn'>,
): Promise<NewsletterSubscriptionDto> {
  const userId = userIdOf(dto);

  const { subscription, resumed, email } = await withNewsletterErrors(() =>
    tx(async (db) => {
      await setUserContext(db, { userId, role: dto.actorRole });

      // the 404 comes before anything is changed
      await requireSubscription(db, userId);

      const me = await db.user.findUnique({ where: { id: userId }, select: { email: true } });
      if (!me) throw new ForbiddenError('NEWSLETTER_FORBIDDEN');

      const rows = await db.$queryRaw<{ resumed: boolean }[]>`
        select cartlify.newsletter_profile_resume(
          ${userId}::int, ${dto.ip}::text, ${dto.userAgent}::text
        ) as resumed
      `;

      return {
        resumed: rows[0]?.resumed === true,
        email: me.email,
        subscription: await requireSubscription(db, userId),
      };
    }),
  );

  if (resumed) await clearSpamReport(email, log);

  return subscription;
}
