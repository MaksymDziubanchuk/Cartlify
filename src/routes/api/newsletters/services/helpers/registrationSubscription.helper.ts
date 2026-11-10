import { getPgCode, getPgMessage, tx } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { enabledLocaleOf } from '@helpers/locale.js';
import {
  makeManageSalt,
  manageHashOf,
  manageTokenOf,
  unsubscribeTokenOf,
} from '@helpers/newsletterTokens.js';
import { isAppError } from '@utils/errors.js';

export type RegistrationSubscriptionArgs = {
  userId: number;
  // the address and the browser of the request that made the choice, which the journal keeps
  ip: string | null;
  userAgent: string | null;
};

// the request logger of Fastify, or whatever has a warn like it
export type RegistrationSubscriptionLog = { warn: (obj: unknown, msg?: string) => void };

// The subscription of an account that has just come into being or just proved its address, made
// at the registration (place registration): after the email is verified for a registration with a
// password, at once for a login by a provider that made the account. The server acts as the system:
// the person has no session yet at the first and has just got one at the second, and the address
// is the one of the account, which the function reads itself and refuses unless the account
// proved it. The language is the one of the account if the shop still answers in it, none
// otherwise.
//
// Nothing of the outcome is told to anybody: an address that is subscribed already (by the form or
// by an account), a request of the form that waits (it becomes the subscription of the account) and
// a new subscription all end the same, so the answer of the registration cannot be used to find out
// whether somebody else's address is subscribed. A subscription that cannot be made never undoes
// what the registration or the login did: it is logged as a warning with the account, never the
// address, and the person finds the box unticked in the profile
export async function subscribeAtRegistration(
  { userId, ip, userAgent }: RegistrationSubscriptionArgs,
  log: RegistrationSubscriptionLog,
): Promise<void> {
  try {
    const salt = makeManageSalt();
    const manageHash = manageHashOf(manageTokenOf(salt));
    const unsubscribeHash = manageHashOf(unsubscribeTokenOf(salt));

    await tx(async (db) => {
      await setAdminContext(db);

      const [account] = await db.$queryRaw<{ locale: string | null }[]>`
        select locale from cartlify.users where id = ${userId}::int
      `;
      const locale = enabledLocaleOf(account?.locale);

      await db.$queryRaw`
        select cartlify.newsletter_subscribe_account(
          ${userId}::int, ${locale}::text, ${salt}::text, ${manageHash}::text,
          ${unsubscribeHash}::text, 'registration'::text, ${ip}::text, ${userAgent}::text
        )
      `;
    });
  } catch (err) {
    // the message of a refusal of the database is a code (NEWSLETTER_FORBIDDEN and the like); the
    // text of a failed check is not logged, it may name the row
    const refusal = /NEWSLETTER_[A-Z_]+/.exec(getPgMessage(err) ?? '')?.[0];

    log.warn(
      {
        userId,
        pgCode: getPgCode(err),
        ...(refusal ? { refusal } : {}),
        ...(isAppError(err) ? { errorCode: err.errorCode } : {}),
      },
      'newsletter subscription at registration was not made',
    );
  }
}
