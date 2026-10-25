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
  buildLinkedInAuthUrl,
  verifyLinkedInOAuthState,
  exchangeLinkedInCodeForTokens,
} from '@utils/linkedinOAuth.js';
import { verifyOidcIdToken } from '@utils/oidcIdTokenVerify.js';

import { avatarOf } from '@utils/avatar.util.js';

import type {
  LinkedInStartDto,
  LinkedInStartResponseDto,
  LinkedInCallbackDto,
  LoginResponseDto,
} from 'types/dto/auth.dto.js';
import type { LinkedInIdTokenPayload } from '@utils/linkedinOAuth.js';

import { migrateGuestDataToUser } from './helpers/guestMigration.helper.js';
import { insertLoginLog } from './helpers/loginLogs.helper.js';
import { issueTokensOnLogin } from './helpers/tokenRotation.helper.js';
import { upsertOAuthUserByEmail } from './helpers/oauthUserUpsert.helper.js';
import {
  copyProviderAvatar,
  type OAuthAvatarRole,
  type OAuthLoginOutcome,
} from './helpers/providerAvatar.helper.js';

export async function linkedInStart({
  guestId,
  role,
}: LinkedInStartDto): Promise<LinkedInStartResponseDto> {
  if (role !== 'GUEST') {
    throw new AlreadyAuthenticatedError({ flow: 'LINKEDIN_START' });
  }
  if (!guestId) throw new BadRequestError('GUEST_ID_REQUIRED');

  // build oauth redirect url
  const url = buildLinkedInAuthUrl(String(guestId));
  return { url };
}

export async function linkedInCallback({
  code,
  state,
  guestId,
  role,
  ip,
  userAgent,
  log,
}: LinkedInCallbackDto): Promise<{
  result: LoginResponseDto;
  refreshToken: string;
  accessToken: string;
}> {
  // a signed-in user cannot finish a login, the same as at the start
  if (role !== 'GUEST') throw new AlreadyAuthenticatedError({ flow: 'LINKEDIN_CALLBACK' });
  if (!guestId) throw new BadRequestError('GUEST_ID_REQUIRED');
  if (!code) throw new BadRequestError('MISSING_CODE');
  if (!state) throw new BadRequestError('MISSING_STATE');

  // verify oauth state payload and that this guest started the login,
  // before the code is used: a code from someone else's login is never redeemed here
  verifyLinkedInOAuthState(state, String(guestId));

  // exchange code for provider tokens
  const tokens = await exchangeLinkedInCodeForTokens(code);

  if (!tokens.id_token)
    throw new BadRequestError('LINKEDIN_NO_ID_TOKEN', { stage: 'TOKEN_EXCHANGE' });

  // verify id_token signature and core claims
  const idp = await verifyOidcIdToken<LinkedInIdTokenPayload>(tokens.id_token, {
    jwksUri: 'https://www.linkedin.com/oauth/openid/jwks',
    issuers: ['https://www.linkedin.com/oauth'],
    audience: env.LINKEDIN_CLIENT_ID,
    algorithms: ['RS256'],
  });

  const sub = (idp.sub ?? '').trim();
  if (!sub) throw new BadRequestError('LINKEDIN_SUB_MISSING');

  // normalize and validate email
  const email = (idp.email ?? '').trim().toLowerCase();
  if (!email) throw new BadRequestError('LINKEDIN_EMAIL_MISSING');
  assertEmail(email);

  // only an email linkedin vouches for counts, the same as with google: without the claim
  // nobody has proven the address, and it could take over an unverified local account with it;
  // the claim is taken as a boolean or as the string "true"
  const emailVerified = idp.email_verified === true || idp.email_verified === 'true';
  if (!emailVerified) {
    throw new ForbiddenError('LINKEDIN_EMAIL_NOT_VERIFIED');
  }

  const name = typeof idp.name === 'string' && idp.name.trim() ? idp.name.trim() : null;
  const avatarUrl =
    typeof idp.picture === 'string' && idp.picture.trim() ? idp.picture.trim() : null;

  const locale = null;
  let login: OAuthLoginOutcome;

  try {
    login = await prisma.$transaction(async (tx) => {
      // create or link oauth user by verified email
      const u = await upsertOAuthUserByEmail(tx, {
        email,
        authProvider: 'LINKEDIN',
        providerSub: sub,
        emailVerified: true,
        name,
        locale,
        userNotFoundAfterConflictMsg: 'USER_NOT_FOUND_AFTER_CONFLICT',
        providerSubMismatchMsg: 'LINKEDIN_SUB_MISMATCH',
      });

      // migrate guest data into the authenticated account
      await migrateGuestDataToUser(tx, guestId, { id: u.id, role: u.role });

      // persist login audit record for security review
      await insertLoginLog(tx, {
        userId: u.id as any,
        email,
        role: u.role as any,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });

      const rememberMe = true;

      // issue session tokens after successful oauth linking
      const { accessToken, refreshToken } = await issueTokensOnLogin(tx, {
        userId: u.id,
        role: u.role as Role,
        rememberMe,
        ...(userAgent ? { userAgent } : {}),
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

    throw new InternalError({ reason: 'LINKEDIN_SERVICE_UNEXPECTED' }, err);
  }

  // a new account takes the picture of the provider; the login goes on whatever comes of it
  if (login.created && avatarUrl) {
    const copied = await copyProviderAvatar({
      userId: login.userId,
      role: login.role as OAuthAvatarRole,
      provider: 'LINKEDIN',
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
