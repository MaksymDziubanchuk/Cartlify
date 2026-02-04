import type { Role } from '@prisma/client';
import { prisma } from '@db/client.js';

import { AppError, BadRequestError, UnauthorizedError, ForbiddenError } from '@utils/errors.js';

import env from '@config/env.js';
import { assertEmail } from '@helpers/validateEmail.js';

import { buildGoogleAuthUrl } from '@utils/googleOAuth.js';
import {
  verifyGoogleOAuthState,
  exchangeGoogleCodeForTokens,
  decodeJwtPayload,
} from '@utils/googleOAuth.js';

import type {
  GoogleStartDto,
  GoogleStartResponseDto,
  GoogleCallbackDto,
  LoginResponseDto,
} from 'types/dto/auth.dto.js';
import type { GoogleIdTokenPayload } from '@utils/googleOAuth.js';

import { migrateGuestDataToUser } from './helpers/guestMigration.service.js';
import { insertLoginLog } from './helpers/loginLogs.service.js';
import { issueTokensOnLogin } from './helpers/tokenRotation.service.js';
import { upsertOAuthUserByEmail } from './helpers/oauthUserUpsert.service.js';

export async function googleStart({
  guestId,
  role,
}: GoogleStartDto): Promise<GoogleStartResponseDto> {
  if (role !== 'GUEST') throw new AppError('Already authenticated', 409);
  if (!guestId) throw new AppError('Guest id is required', 400);

  const url = buildGoogleAuthUrl(String(guestId));
  return { url };
}

export async function googleCallback({ code, state, ip, userAgent }: GoogleCallbackDto): Promise<{
  result: LoginResponseDto;
  refreshToken: string;
  accessToken: string;
}> {
  if (!code) throw new BadRequestError('MISSING_CODE');
  if (!state) throw new BadRequestError('MISSING_STATE');

  const st = verifyGoogleOAuthState(state);
  if (!st) throw new BadRequestError('INVALID_STATE');
  const guestId = st.guestId;

  const tokens = await exchangeGoogleCodeForTokens(code);
  if (!tokens.id_token) throw new BadRequestError('GOOGLE_NO_ID_TOKEN');

  const idp = decodeJwtPayload<GoogleIdTokenPayload>(tokens.id_token);

  const now = Math.floor(Date.now() / 1000);
  if (typeof idp.exp === 'number' && idp.exp <= now) {
    throw new UnauthorizedError('GOOGLE_ID_TOKEN_EXPIRED');
  }

  if (idp.iss && idp.iss !== 'https://accounts.google.com' && idp.iss !== 'accounts.google.com') {
    throw new UnauthorizedError('GOOGLE_ID_TOKEN_BAD_ISS');
  }
  if (idp.aud && idp.aud !== env.GOOGLE_CLIENT_ID) {
    throw new UnauthorizedError('GOOGLE_ID_TOKEN_BAD_AUD');
  }

  const sub = (idp.sub ?? '').trim();
  if (!sub) throw new BadRequestError('GOOGLE_SUB_MISSING');

  const email = (idp.email ?? '').trim().toLowerCase();
  if (!email) throw new BadRequestError('GOOGLE_EMAIL_MISSING');
  assertEmail(email);

  const emailVerified = idp.email_verified === true;
  if (!emailVerified) throw new ForbiddenError('GOOGLE_EMAIL_NOT_VERIFIED');

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

  return prisma
    .$transaction(async (tx) => {
      const u = await upsertOAuthUserByEmail(tx, {
        email,
        provider: 'GOOGLE',
        providerSub: sub,
        emailVerified,
        name,
        avatarUrl,
        locale,
        userNotFoundAfterConflictMsg: 'USER_NOT_FOUND_AFTER_CONFLICT',
        providerSubMismatchMsg: 'GOOGLE_SUB_MISMATCH',
      });

      await migrateGuestDataToUser(tx, guestId, u.id);

      await insertLoginLog(tx, {
        userId: u.id as any,
        email,
        role: u.role as any,
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });

      const rememberMe = true;

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
    })
    .catch((err) => {
      if (err instanceof AppError) throw err;
      throw new AppError('Something went wrong', 500);
    });
}
