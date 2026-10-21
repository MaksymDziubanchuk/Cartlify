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
import { assertEmail } from '@helpers/validateEmail.js';

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
}: GoogleStartDto): Promise<GoogleStartResponseDto> {
  if (role !== 'GUEST') throw new AlreadyAuthenticatedError({ flow: 'GOOGLE_START' });
  if (!guestId) throw new BadRequestError('GUEST_ID_REQUIRED');
  // build oauth redirect url
  const url = buildGoogleAuthUrl(String(guestId));
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
  verifyGoogleOAuthState(state, String(guestId));

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

  // normalize locale for app
  const normalizeLocale = (raw?: string | null) => {
    if (!raw) return undefined;
    const base = raw.trim().toLowerCase().split('-')[0];
    if (base === 'en' || base === 'uk') return base;
    return undefined;
  };

  const name = typeof idp.name === 'string' && idp.name.trim() ? idp.name.trim() : null;
  const avatarUrl =
    typeof idp.picture === 'string' && idp.picture.trim() ? idp.picture.trim() : null;
  const locale = normalizeLocale(typeof idp.locale === 'string' ? idp.locale : null) ?? null;

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
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });

      const rememberMe = true;

      // issue tokens for session
      const { accessToken, refreshToken } = await issueTokensOnLogin(tx, {
        userId: u.id,
        role: u.role as Role,
        rememberMe,
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
        ...(u.locale ? { locale: u.locale } : {}),
        ...(u.phone ? { phone: u.phone } : {}),
      };

      return { result, accessToken, refreshToken, created: u.created, role: u.role, userId: u.id };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;

    throw new InternalError({ reason: 'GOOGLE_SERVICE_UNEXPECTED' }, err);
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
