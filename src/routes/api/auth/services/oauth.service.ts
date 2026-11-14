import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';

import {
  AppError,
  AlreadyAuthenticatedError,
  BadRequestError,
  ForbiddenError,
  InternalError,
} from '@utils/errors.js';

import { enabledLocaleOf } from '@helpers/locale.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { canManageMoneyOf } from '@helpers/moneyManager.js';
import { canManageNewslettersOf } from '@helpers/newsletterManager.js';
import { subscribeAtRegistration } from '@routes/api/newsletters/services/helpers/registrationSubscription.helper.js';
import { avatarOf } from '@utils/avatar.util.js';

import { migrateGuestDataToUser } from './helpers/guestMigration.helper.js';
import { insertLoginLog } from './helpers/loginLogs.helper.js';
import { issueTokensOnLogin } from './helpers/tokenRotation.helper.js';
import { upsertOAuthUserByEmail } from './helpers/oauthUserUpsert.helper.js';
import { acceptedOfState, takeConsentAtOAuthLogin } from './helpers/oauthConsent.helper.js';
import { newsletterOfState } from './helpers/oauthNewsletter.helper.js';
import {
  copyProviderAvatar,
  type OAuthAvatarRole,
  type OAuthLoginOutcome,
} from './helpers/providerAvatar.helper.js';

import type { IdentityProvider } from '@providers/identity/index.js';
import type {
  LoginResponseDto,
  OAuthCallbackDto,
  OAuthStartDto,
  OAuthStartResponseDto,
} from 'types/dto/auth.dto.js';

// The login of a guest with an account of theirs at a provider (src/providers/identity), the same
// for every provider: the start sends the browser to the provider with a signed state, the
// callback checks the state, takes the person the provider vouches for, and makes or links the
// account of the shop by the proven address

export async function oauthStart(
  provider: IdentityProvider,
  { guestId, role, acceptedDocumentIds = [], newsletter = false }: OAuthStartDto,
): Promise<OAuthStartResponseDto> {
  if (role !== 'GUEST') {
    throw new AlreadyAuthenticatedError({ flow: 'OAUTH_START', provider: provider.name });
  }
  if (!guestId) throw new BadRequestError('GUEST_ID_REQUIRED');

  return { url: provider.startUrl(String(guestId), acceptedDocumentIds, newsletter) };
}

export async function oauthCallback(
  provider: IdentityProvider,
  { code, state, guestId, role, ip, userAgent, log }: OAuthCallbackDto,
): Promise<{
  result: LoginResponseDto;
  refreshToken: string;
  accessToken: string;
}> {
  // a signed-in user cannot finish a login, the same as at the start
  if (role !== 'GUEST') {
    throw new AlreadyAuthenticatedError({ flow: 'OAUTH_CALLBACK', provider: provider.name });
  }
  if (!guestId) throw new BadRequestError('GUEST_ID_REQUIRED');
  if (!code) throw new BadRequestError('MISSING_CODE');
  if (!state) throw new BadRequestError('MISSING_STATE');

  // the state, and that this guest started the login, before the code is used: a code from
  // someone else's login is never redeemed here
  const verified = provider.readState(state, String(guestId));
  const accepted = acceptedOfState(verified);
  const subscribe = newsletterOfState(verified);

  const person = await provider.readPerson(code, state);

  const sub = person.sub.trim();
  if (!sub) throw new BadRequestError('OAUTH_SUB_MISSING');

  const email = person.email.trim().toLowerCase();
  if (!email) throw new BadRequestError('OAUTH_EMAIL_MISSING');
  assertEmail(email);

  // only an address the provider vouches for counts: an unproven one could take over an
  // unverified local account of the same address
  if (!person.emailVerified) throw new ForbiddenError('OAUTH_EMAIL_NOT_VERIFIED');

  // a language the shop does not answer in, or the wrong shape, is dropped
  const locale = enabledLocaleOf(person.locale);

  let login: OAuthLoginOutcome;

  try {
    login = await prisma.$transaction(async (tx) => {
      // create or link the account by the proven address
      const u = await upsertOAuthUserByEmail(tx, {
        email,
        authProvider: provider.authProvider,
        providerSub: sub,
        emailVerified: true,
        name: person.name,
        locale,
        userNotFoundAfterConflictMsg: 'USER_NOT_FOUND_AFTER_CONFLICT',
        providerSubMismatchMsg: 'OAUTH_SUB_MISMATCH',
      });

      await migrateGuestDataToUser(tx, guestId, { id: u.id, role: u.role as Role });

      await insertLoginLog(tx, {
        userId: u.id as any,
        email,
        role: u.role as any,
        event: `login.${provider.name}`,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });

      // issue tokens for session
      const { accessToken, refreshToken } = await issueTokensOnLogin(tx, {
        userId: u.id,
        role: u.role as Role,
        rememberMe: true,
        ...(userAgent ? { userAgent } : {}),
      });

      // the consent the login started with: every version in force for an account it makes,
      // the ones that came in force since the last consent for an account the shop has
      await takeConsentAtOAuthLogin(tx, {
        userId: u.id,
        role: u.role,
        created: u.created,
        accepted,
      });

      assertEmail(u.email);

      const result: LoginResponseDto = {
        id: u.id,
        email: u.email,
        role: u.role,
        isVerified: u.isVerified,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        ...(u.name ? { name: u.name } : {}),
        ...avatarOf(u),
        canManageNewsletters: canManageNewslettersOf(u),
        canManageMoney: canManageMoneyOf(u),
        ...(u.locale ? { locale: u.locale } : {}),
        ...(u.phone ? { phone: u.phone } : {}),
      };

      return { result, accessToken, refreshToken, created: u.created, role: u.role, userId: u.id };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;

    throw new InternalError({ reason: 'OAUTH_SERVICE_UNEXPECTED', provider: provider.name }, err);
  }

  // the box of the newsletter the page ticked at the start subscribes a new account, never an
  // account the shop had; whatever comes of it the login goes on
  if (login.created && subscribe) {
    await subscribeAtRegistration(
      { userId: login.userId, ip: ip ?? null, userAgent: userAgent ?? null },
      log,
    );
  }

  // a new account takes the picture of the provider; the login goes on whatever comes of it
  if (login.created && person.avatarUrl) {
    const copied = await copyProviderAvatar({
      userId: login.userId,
      role: login.role as OAuthAvatarRole,
      provider,
      pictureUrl: person.avatarUrl,
      log,
    });
    if (copied) {
      login.result = {
        ...login.result,
        ...avatarOf({
          ...login.result,
          id: login.userId,
          name: login.result.name ?? null,
          avatarUrl: copied,
        }),
      };
    }
  }

  return { result: login.result, accessToken: login.accessToken, refreshToken: login.refreshToken };
}
