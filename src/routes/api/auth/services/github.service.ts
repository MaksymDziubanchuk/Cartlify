import { prisma } from '@db/client.js';
import {
  AppError,
  AlreadyAuthenticatedError,
  BadRequestError,
  ForbiddenError,
  InternalError,
} from '@utils/errors.js';

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
import { acceptedOfState, takeConsentAtOAuthLogin } from './helpers/oauthConsent.helper.js';
import {
  copyProviderAvatar,
  type OAuthAvatarRole,
  type OAuthLoginOutcome,
} from './helpers/providerAvatar.helper.js';

import { avatarOf } from '@utils/avatar.util.js';

export async function githubStart({
  guestId,
  role,
  acceptedDocumentIds = [],
}: GithubStartDto): Promise<GithubStartResponseDto> {
  if (role !== 'GUEST') {
    throw new AlreadyAuthenticatedError({ flow: 'GITHUB_START' });
  }
  if (!guestId) {
    throw new BadRequestError('GUEST_ID_REQUIRED', {
      flow: 'GITHUB_START',
    });
  }
  // build oauth redirect url
  const url = buildGithubAuthUrl(String(guestId), acceptedDocumentIds);
  return { url };
}

export async function githubCallback({
  code,
  state,
  guestId,
  role,
  ip,
  userAgent,
  log,
}: GithubCallbackDto): Promise<{
  result: LoginResponseDto;
  refreshToken: string;
  accessToken: string;
}> {
  // a signed-in user cannot finish a login, the same as at the start
  if (role !== 'GUEST') throw new AlreadyAuthenticatedError({ flow: 'GITHUB_CALLBACK' });
  if (!guestId) {
    throw new BadRequestError('GUEST_ID_REQUIRED', {
      flow: 'GITHUB_CALLBACK',
    });
  }
  if (!code) {
    throw new BadRequestError('MISSING_CODE', {
      flow: 'GITHUB_CALLBACK',
    });
  }
  if (!state) {
    throw new BadRequestError('MISSING_STATE', {
      flow: 'GITHUB_CALLBACK',
    });
  }

  // verify oauth state payload and that this guest started the login,
  // before the code is used: a code from someone else's login is never redeemed here
  const accepted = acceptedOfState(verifyGithubOAuthState(state, String(guestId)));

  // exchange code for oauth tokens
  const tokens = await exchangeGithubCodeForTokens(code, state);
  if (!tokens.access_token) {
    throw new BadRequestError('GITHUB_NO_ACCESS_TOKEN');
  }

  // fetch github user and emails
  const ghUser = await fetchGithubUser(tokens.access_token);
  const ghEmails = await fetchGithubEmails(tokens.access_token);

  // build provider subject id
  const sub = String(ghUser.id ?? '').trim();
  if (!sub) {
    throw new BadRequestError('GITHUB_SUB_MISSING');
  }

  // pick best email address
  const picked = pickBestGithubEmail(ghUser, ghEmails);
  const email = (picked ?? '').trim().toLowerCase();
  if (!email) {
    throw new BadRequestError('GITHUB_EMAIL_MISSING');
  }
  assertEmail(email);

  const isVerified = ghEmails.some(
    (e) => e.verified === true && e.email.trim().toLowerCase() === email,
  );
  if (!isVerified) {
    throw new ForbiddenError('GITHUB_EMAIL_NOT_VERIFIED');
  }

  const name = typeof ghUser.name === 'string' && ghUser.name.trim() ? ghUser.name.trim() : null;

  const avatarUrl =
    typeof ghUser.avatar_url === 'string' && ghUser.avatar_url.trim()
      ? ghUser.avatar_url.trim()
      : null;

  const locale = null;

  let login: OAuthLoginOutcome;

  try {
    login = await prisma.$transaction(async (tx) => {
      // try to create user
      const u = await upsertOAuthUserByEmail(tx, {
        email,
        authProvider: 'GITHUB',
        providerSub: sub,
        emailVerified: true,
        name,
        locale,
        userNotFoundAfterConflictMsg: 'USER_NOT_FOUND_AFTER_CONFLICT',
        providerSubMismatchMsg: 'GITHUB_SUB_MISMATCH',
      });

      await migrateGuestDataToUser(tx, guestId, { id: u.id, role: u.role });

      await insertLoginLog(tx, {
        userId: u.id as any,
        email,
        role: u.role as any,
        event: 'login.github',
        ip: ip ?? null,
        userAgent: userAgent ?? null,
      });

      const rememberMe = true;

      // issue tokens for session
      const { accessToken, refreshToken } = await issueTokensOnLogin(tx, {
        userId: u.id,
        role: u.role as any,
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
        ...(u.locale ? { locale: u.locale } : {}),
        ...(u.phone ? { phone: u.phone } : {}),
      };

      return { result, accessToken, refreshToken, created: u.created, role: u.role, userId: u.id };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;

    throw new InternalError(
      {
        reason: 'GITHUB_SERVICE_UNEXPECTED',
        flow: 'GITHUB_CALLBACK',
      },
      err,
    );
  }

  // a new account takes the picture of the provider; the login goes on whatever comes of it
  if (login.created && avatarUrl) {
    const copied = await copyProviderAvatar({
      userId: login.userId,
      role: login.role as OAuthAvatarRole,
      provider: 'GITHUB',
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
