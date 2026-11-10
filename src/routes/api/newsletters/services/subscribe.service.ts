import type { FastifyBaseLogger } from 'fastify';
import type { Prisma } from '@prisma/client';

import { tx } from '@db/client.js';
import { setActorContext, setUserContext } from '@db/dbContext.service.js';
import { enabledLocaleOf, mailLocaleOf } from '@helpers/locale.js';
import {
  emailHmacOf,
  makeConfirmToken,
  makeManageSalt,
  manageHashOf,
  manageTokenOf,
  normalizeEmail,
  unsubscribeTokenOf,
} from '@helpers/newsletterTokens.js';
import { verifyCaptcha } from '@services/captcha/turnstile.service.js';
import { BadRequestError, ConflictError, ForbiddenError, InternalError } from '@utils/errors.js';
import type {
  NewsletterSubscriptionDto,
  SubscribeDto,
  SubscribeResultDto,
} from 'types/dto/newsletters.dto.js';

import { withNewsletterErrors } from './helpers/newsletterErrors.helper.js';
import { readProfileSubscription } from './helpers/subscriptionState.helper.js';
import {
  sendAfterAnswer,
  sendSubscriptionAlreadyMail,
  sendSubscriptionConfirmMail,
} from './helpers/subscriptionMail.helper.js';

type Tx = Prisma.TransactionClient;
type SubscribeLog = Pick<FastifyBaseLogger, 'warn' | 'error'>;

// what cartlify.newsletter_request decides, for the server to mail
type RequestRow = {
  outcome: 'confirm' | 'already' | 'nothing';
  locale: string | null;
  manage_salt: string | null;
};

// The language the person asked for: one the shop answers in, case and a region ignored. A language
// that was given and is not one is refused, and no other is put in its place
function askedLocaleOf(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;

  const locale = enabledLocaleOf(raw);
  if (!locale) throw new BadRequestError('LOCALE_INVALID');

  return locale;
}

// The signed-in user for their own address: the subscription of the account, in force at once. The
// salt and the hash of the link of management are made here, the database keeps them
async function subscribeAccount(
  db: Tx,
  dto: SubscribeDto,
  userId: number,
  asked: string | undefined,
  accountLocale: string | null,
): Promise<NewsletterSubscriptionDto> {
  // the language asked, then the one of the account if the shop still answers in it, then none
  const locale = asked ?? enabledLocaleOf(accountLocale);
  const salt = makeManageSalt();
  const manageHash = manageHashOf(manageTokenOf(salt));
  const unsubscribeHash = manageHashOf(unsubscribeTokenOf(salt));

  const rows = await db.$queryRaw<{ outcome: 'created' | 'converted' | 'already' }[]>`
    select cartlify.newsletter_subscribe_account(
      ${userId}::int, ${locale}::text, ${salt}::text, ${manageHash}::text,
      ${unsubscribeHash}::text, 'profile'::text, ${dto.ip}::text, ${dto.userAgent}::text
    ) as outcome
  `;

  // a subscription is in force already (made by the account or by the form); nothing was changed
  if (rows[0]?.outcome === 'already') throw new ConflictError('NEWSLETTER_ALREADY_SUBSCRIBED');

  const subscription = await readProfileSubscription(db, userId);
  if (!subscription) throw new InternalError({ reason: 'NEWSLETTER_SUBSCRIPTION_LOST' });

  return subscription;
}

// A request about an address that is not the person's own, from a guest or from a signed-in user.
// The database decides what to mail (a confirmation, "you are already subscribed", or nothing) and
// records the request; the mail goes after it is committed, and the answer does not depend on any
// of it
async function requestSubscription(
  dto: SubscribeDto,
  email: string,
  locale: string,
  log: SubscribeLog,
): Promise<void> {
  const confirm = makeConfirmToken();
  const salt = makeManageSalt();
  const manageHash = manageHashOf(manageTokenOf(salt));
  const unsubscribeHash = manageHashOf(unsubscribeTokenOf(salt));
  const hmac = emailHmacOf(email);

  const row = await tx(async (db) => {
    await setActorContext(db, { actorId: dto.actorId, role: dto.actorRole });

    const rows = await db.$queryRaw<RequestRow[]>`
      select * from cartlify.newsletter_request(
        ${email}::text, ${hmac}::text, ${locale}::text, ${confirm.hash}::text, ${salt}::text,
        ${manageHash}::text, ${unsubscribeHash}::text, ${dto.ip}::text, ${dto.userAgent}::text
      )
    `;

    return rows[0];
  });

  if (!row) throw new InternalError({ reason: 'NEWSLETTER_REQUEST_EMPTY' });

  // the mail goes after the answer (sendAfterAnswer): the answer takes as long whatever is mailed
  if (row.outcome === 'confirm') {
    sendAfterAnswer(
      sendSubscriptionConfirmMail(
        { to: email, token: confirm.token, locale: mailLocaleOf(row.locale) },
        log,
      ),
    );
  } else if (row.outcome === 'already') {
    // the salt of the subscription that exists gives the token of its link of management
    if (!row.manage_salt) throw new InternalError({ reason: 'NEWSLETTER_ALREADY_WITHOUT_SALT' });

    sendAfterAnswer(
      sendSubscriptionAlreadyMail(
        {
          to: email,
          manageToken: manageTokenOf(row.manage_salt),
          locale: mailLocaleOf(row.locale),
        },
        log,
      ),
    );
  }
}

// What the route hands the service for the steps that belong to the request itself
export type SubscribeHooks = {
  // Run after the captcha has passed and before the request is recorded: the route counts the
  // requests about one email here (a refusal is the rate limit, 429). It is after the captcha, so a
  // request that fails the captcha spends no count of the email, and only for an address a mail may be
  // sent to, so the subscription of an account to its own address spends none either
  afterCaptcha?: () => Promise<void>;
};

// The form of the public page. Two ways in, by who asks and about which address:
//  - a signed-in user for their own address (or with none given): the subscription of the account,
//    in force at once, no captcha, no mail; 409 when one is in force already;
//  - anybody else (a guest, or a signed-in user about another address): the captcha is checked, the
//    database records a request and says what to mail, and the answer is the same whatever the
//    state of the address is, a blocked one included, so it cannot be used to find out who is
//    subscribed. A mail that cannot be sent is only logged.
// A request about an address that is not the person's own names a language: the mail goes to the
// owner of the address, who is not the person who asks, and the language of the account of the one
// who asks is no language of theirs
export async function subscribe(
  dto: SubscribeDto,
  log: SubscribeLog,
  hooks: SubscribeHooks = {},
): Promise<SubscribeResultDto> {
  return withNewsletterErrors(async () => {
    const asked = askedLocaleOf(dto.locale);

    // a signed-in user: their address and language are read first, in one transaction with the
    // subscription of the account, which is made there if the address is theirs
    if (dto.actorRole !== 'GUEST') {
      const userId = Number(dto.actorId);

      const attempt = await tx(async (db) => {
        await setUserContext(db, { userId, role: dto.actorRole });

        const me = await db.user.findUnique({
          where: { id: userId },
          select: { email: true, locale: true },
        });
        if (!me) throw new ForbiddenError('NEWSLETTER_FORBIDDEN');

        const own =
          dto.email === undefined || normalizeEmail(dto.email) === normalizeEmail(me.email);
        if (!own) return { own: false as const };

        return {
          own: true as const,
          subscription: await subscribeAccount(db, dto, userId, asked, me.locale),
        };
      });

      if (attempt.own) return { kind: 'subscribed', subscription: attempt.subscription };
    }

    // from here the request is about an address nobody has proved is theirs
    if (dto.email === undefined || dto.email === '') throw new BadRequestError('EMAIL_REQUIRED');

    // the language of the mail: the one asked for, from a guest and from a signed-in user alike (the
    // cheap checks come before the captcha, which costs a call to Cloudflare and works once)
    if (!asked) throw new BadRequestError('LOCALE_INVALID');

    await verifyCaptcha({ token: dto.captchaToken, ip: dto.ip ?? undefined, log });
    await hooks.afterCaptcha?.();

    await requestSubscription(dto, normalizeEmail(dto.email), asked, log);

    return { kind: 'accepted' };
  });
}
