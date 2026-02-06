import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';

import { AppError, BadRequestError, ForbiddenError } from '@utils/errors.js';

import env from '@config/env.js';
import { assertEmail } from '@helpers/validateEmail.js';

import {
  buildLinkedInAuthUrl,
  verifyLinkedInOAuthState,
  exchangeLinkedInCodeForTokens,
} from '@utils/linkedinOAuth.js';
import { verifyOidcIdToken } from '@utils/oidcIdTokenVerify.js';

import type {
  LinkedInStartDto,
  LinkedInStartResponseDto,
  LinkedInCallbackDto,
  LoginResponseDto,
} from 'types/dto/auth.dto.js';
import type { LinkedInIdTokenPayload } from '@utils/linkedinOAuth.js';

import { migrateGuestDataToUser } from './helpers/guestMigration.service.js';
import { insertLoginLog } from './helpers/loginLogs.service.js';
import { issueTokensOnLogin } from './helpers/tokenRotation.service.js';
import { upsertOAuthUserByEmail } from './helpers/oauthUserUpsert.service.js';

export async function linkedInStart({
  guestId,
  role,
}: LinkedInStartDto): Promise<LinkedInStartResponseDto> {
  if (role !== 'GUEST') throw new AppError('Already authenticated', 409);
  if (!guestId) throw new AppError('Guest id is required', 400);

  // build oauth redirect url
  const url = buildLinkedInAuthUrl(String(guestId));
  return { url };
}

export async function linkedInCallback({
  code,
  state,
  ip,
  userAgent,
}: LinkedInCallbackDto): Promise<{
  result: LoginResponseDto;
  refreshToken: string;
  accessToken: string;
}> {
  if (!code) throw new BadRequestError('MISSING_CODE');
  if (!state) throw new BadRequestError('MISSING_STATE');

  // verify oauth state payload
  const st = verifyLinkedInOAuthState(state);
  const guestId = st.guestId;

  // exchange code for provider tokens
  const tokens = await exchangeLinkedInCodeForTokens(code);

  if (!tokens.id_token) throw new BadRequestError('LINKEDIN_NO_ID_TOKEN');

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

  // enforce verified email when present
  if (idp.email_verified === false) {
    throw new ForbiddenError('LINKEDIN_EMAIL_NOT_VERIFIED');
  }

  const name = typeof idp.name === 'string' && idp.name.trim() ? idp.name.trim() : null;
  const avatarUrl =
    typeof idp.picture === 'string' && idp.picture.trim() ? idp.picture.trim() : null;

  const locale = null;
  try {
    return await prisma.$transaction(async (tx) => {
      // create or link oauth user by verified email
      const u = await upsertOAuthUserByEmail(tx, {
        email,
        authProvider: 'LINKEDIN',
        providerSub: sub,
        emailVerified: true,
        name,
        avatarUrl,
        locale,
        userNotFoundAfterConflictMsg: 'USER_NOT_FOUND_AFTER_CONFLICT',
        providerSubMismatchMsg: 'LINKEDIN_SUB_MISMATCH',
      });

      // migrate guest data into the authenticated account
      await migrateGuestDataToUser(tx, guestId, u.id);

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
        ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
        ...(u.locale ? { locale: u.locale } : {}),
        ...(u.phone ? { phone: u.phone } : {}),
      };

      return { result, accessToken, refreshToken };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`LinkedIn(service): unexpected (${msg})`, 500);
  }
}
