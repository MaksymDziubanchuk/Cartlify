import { prisma } from '@db/client.js';
import { AppError, BadRequestError, ForbiddenError } from '@utils/errors.js';

import { assertEmail } from '@helpers/validateEmail.js';

import {
  buildGithubAuthUrl,
  verifyGithubOAuthState,
  exchangeGithubCodeForTokens,
  fetchGithubUser,
  fetchGithubEmails,
  pickBestGithubEmail,
} from '@utils/githubOAuth.js';

import type {
  GithubStartDto,
  GithubStartResponseDto,
  GithubCallbackDto,
  LoginResponseDto,
} from 'types/dto/auth.dto.js';

import { migrateGuestDataToUser } from './helpers/guestMigration.helper.js';
import { insertLoginLog } from './helpers/loginLogs.helper.js';
import { issueTokensOnLogin } from './helpers/tokenRotation.helper.js';
import { upsertOAuthUserByEmail } from './helpers/oauthUserUpsert.helper.js';

import { buildImageUrls } from '@utils/cloudinary.util.js';

export async function githubStart({
  guestId,
  role,
}: GithubStartDto): Promise<GithubStartResponseDto> {
  if (role !== 'GUEST') throw new AppError('Already authenticated', 409);
  if (!guestId) throw new AppError('Guest id is required', 400);
  // build oauth redirect url
  const url = buildGithubAuthUrl(String(guestId));
  return { url };
}

export async function githubCallback({ code, state, ip, userAgent }: GithubCallbackDto): Promise<{
  result: LoginResponseDto;
  refreshToken: string;
  accessToken: string;
}> {
  if (!code) throw new BadRequestError('MISSING_CODE');
  if (!state) throw new BadRequestError('MISSING_STATE');

  // verify oauth state payload
  const st = verifyGithubOAuthState(state);
  if (!st) throw new BadRequestError('INVALID_STATE');
  const guestId = st.guestId;

  // exchange code for oauth tokens
  const tokens = await exchangeGithubCodeForTokens(code, state);
  if (!tokens.access_token) throw new BadRequestError('GITHUB_NO_ACCESS_TOKEN');

  // fetch github user and emails
  const ghUser = await fetchGithubUser(tokens.access_token);
  const ghEmails = await fetchGithubEmails(tokens.access_token);

  // build provider subject id
  const sub = String(ghUser.id ?? '').trim();
  if (!sub) throw new BadRequestError('GITHUB_SUB_MISSING');

  // pick best email address
  const picked = pickBestGithubEmail(ghUser, ghEmails);
  const email = (picked ?? '').trim().toLowerCase();
  if (!email) throw new BadRequestError('GITHUB_EMAIL_MISSING');
  assertEmail(email);

  const isVerified = ghEmails.some(
    (e) => e.verified === true && e.email.trim().toLowerCase() === email,
  );
  if (!isVerified) throw new ForbiddenError('GITHUB_EMAIL_NOT_VERIFIED');

  const name = typeof ghUser.name === 'string' && ghUser.name.trim() ? ghUser.name.trim() : null;

  const avatarUrl =
    typeof ghUser.avatar_url === 'string' && ghUser.avatar_url.trim()
      ? ghUser.avatar_url.trim()
      : null;

  const locale = null;

  try {
    return await prisma.$transaction(async (tx) => {
      // try to create user
      const u = await upsertOAuthUserByEmail(tx, {
        email,
        authProvider: 'GITHUB',
        providerSub: sub,
        emailVerified: true,
        name,
        avatarUrl,
        locale,
        userNotFoundAfterConflictMsg: 'USER_NOT_FOUND_AFTER_CONFLICT',
        providerSubMismatchMsg: 'GITHUB_SUB_MISMATCH',
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

      // issue tokens for session
      const { accessToken, refreshToken } = await issueTokensOnLogin(tx, {
        userId: u.id,
        role: u.role as any,
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
        ...(u.avatarUrl ? { avatarUrls: buildImageUrls(u.avatarUrl, 'avatar') } : {}),
        ...(u.locale ? { locale: u.locale } : {}),
        ...(u.phone ? { phone: u.phone } : {}),
      };

      return { result, accessToken, refreshToken };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;

    throw new AppError(`Github(service): unexpected`, 500);
  }
}
