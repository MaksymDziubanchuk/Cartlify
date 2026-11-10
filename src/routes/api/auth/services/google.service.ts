import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';

import {
  AppError,
  AlreadyAuthenticatedError,
  BadRequestError,
  ForbiddenError,
  InternalError,
} from '@utils/errors.js';

import env from '@config/env.js';
import { enabledLocaleOf } from '@helpers/locale.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { canManageNewslettersOf } from '@helpers/newsletterManager.js';

import {
  buildGoogleAuthUrl,
  verifyGoogleOAuthState,
  exchangeGoogleCodeForTokens,
} from '@utils/googleOAuth.js';
import { verifyOidcIdToken } from '@utils/oidcIdTokenVerify.js';

import { migrateGuestDataToUser } from './helpers/guestMigration.helper.js';
import { insertLoginLog } from './helpers/loginLogs.helper.js';
import { issueTokensOnLogin } from './helpers/tokenRotation.helper.js';
import { upsertOAuthUserByEmail } from './helpers/oauthUserUpsert.helper.js';
import { acceptedOfState, takeConsentAtOAuthLogin } from './helpers/oauthConsent.helper.js';
import { newsletterOfState } from './helpers/oauthNewsletter.helper.js';
import { subscribeAtRegistration } from '@routes/api/newsletters/services/helpers/registrationSubscription.helper.js';
import {
  copyProviderAvatar,
  type OAuthAvatarRole,
  type OAuthLoginOutcome,
} from './helpers/providerAvatar.helper.js';

import { avatarOf } from '@utils/avatar.util.js';

import type {
  GoogleStartDto,
  GoogleStartResponseDto,
  GoogleCallbackDto,
  LoginResponseDto,
} from 'types/dto/auth.dto.js';
import type { GoogleIdTokenPayload } from '@utils/googleOAuth.js';

export async function googleStart({
  guestId,
  role,
  acceptedDocumentIds = [],
  newsletter = false,
}: GoogleStartDto): Promise<GoogleStartResponseDto> {
  if (role !== 'GUEST') throw new AlreadyAuthenticatedError({ flow: 'GOOGLE_START' });
  if (!guestId) throw new BadRequestError('GUEST_ID_REQUIRED');
  // build oauth redirect url
  const url = buildGoogleAuthUrl(String(guestId), acceptedDocumentIds, newsletter);
  return { url };
}

export async function googleCallback({
  code,
  state,
  guestId,
  role,
  ip,
  userAgent,
  log,
}: GoogleCallbackDto): Promise<{
  result: LoginResponseDto;
  refreshToken: string;
  accessToken: string;
}> {
  // a signed-in user cannot finish a login, the same as at the start
  if (role !== 'GUEST') throw new AlreadyAuthenticatedError({ flow: 'GOOGLE_CALLBACK' });
  if (!guestId) throw new BadRequestError('GUEST_ID_REQUIRED');
  if (!code) throw new BadRequestError('MISSING_CODE');
  if (!state) throw new BadRequestError('MISSING_STATE');

  // verify oauth state payload and that this guest started the login,
  // before the code is used: a code from someone else's login is never redeemed here
  const verified = verifyGoogleOAuthState(state, String(guestId));
  const accepted = acceptedOfState(verified);
  const subscribe = newsletterOfState(verified);

  // exchange code for google tokens
  const tokens = await exchangeGoogleCodeForTokens(code);
  if (!tokens.id_token) throw new BadRequestError('GOOGLE_NO_ID_TOKEN');

  // decode id_token claims
  const idp = await verifyOidcIdToken<GoogleIdTokenPayload>(tokens.id_token, {
    jwksUri: 'https://www.googleapis.com/oauth2/v3/certs',
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    audience: env.GOOGLE_CLIENT_ID,
    algorithms: ['RS256'],
  });

  const sub = (idp.sub ?? '').trim();
  if (!sub) throw new BadRequestError('GOOGLE_SUB_MISSING');

  // normalize and validate email
  const email = (idp.email ?? '').trim().toLowerCase();
  if (!email) throw new BadRequestError('GOOGLE_EMAIL_MISSING');
  assertEmail(email);

  const emailVerified = idp.email_verified === true;
  if (!emailVerified) throw new ForbiddenError('GOOGLE_EMAIL_NOT_VERIFIED');

  const name = typeof idp.name === 'string' && idp.name.trim() ? idp.name.trim() : null;
  const avatarUrl =
    typeof idp.picture === 'string' && idp.picture.trim() ? idp.picture.trim() : null;
  // a language the shop does not answer in, or the wrong shape, is dropped
  const locale = enabledLocaleOf(typeof idp.locale === 'string' ? idp.locale : null);

  let login: OAuthLoginOutcome;

  try {
    login = await prisma.$transaction(async (tx) => {
      // create or link oauth user
      const u = await upsertOAuthUserByEmail(tx, {
        email,
        authProvider: 'GOOGLE',
        providerSub: sub,
        emailVerified,
        name,
        locale,
        userNotFoundAfterConflictMsg: 'USER_NOT_FOUND_AFTER_CONFLICT',
        providerSubMismatchMsg: 'GOOGLE_SUB_MISMATCH',
      });

      await migrateGuestDataToUser(tx, guestId, { id: u.id, role: u.role as Role });

      await insertLoginLog(tx, {
        userId: u.id as any,
        email,
        role: u.role as any,
        event: 'login.google',
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });

      const rememberMe = true;

      // issue tokens for session
      const { accessToken, refreshToken } = await issueTokensOnLogin(tx, {
        userId: u.id,
        role: u.role as Role,
        rememberMe,
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
        ...(u.locale ? { locale: u.locale } : {}),
        ...(u.phone ? { phone: u.phone } : {}),
      };

      return { result, accessToken, refreshToken, created: u.created, role: u.role, userId: u.id };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;

    throw new InternalError({ reason: 'GOOGLE_SERVICE_UNEXPECTED' }, err);
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
  if (login.created && avatarUrl) {
    const copied = await copyProviderAvatar({
      userId: login.userId,
      role: login.role as OAuthAvatarRole,
      provider: 'GOOGLE',
      pictureUrl: avatarUrl,
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
