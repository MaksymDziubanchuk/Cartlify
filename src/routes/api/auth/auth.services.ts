import { Prisma, Role } from '@prisma/client';
import { prisma } from '@db/client.js';
import {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  isAppError,
} from '@utils/errors.js';
import { buildGoogleAuthUrl } from '@utils/googleOAuth.js';
import { makeVerifyToken } from '@helpers/makeTokens.js';
import { hashPass, verifyPass } from '@helpers/safePass.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { signAccessToken, signRefreshToken, verifyRefreshToken } from '@utils/jwt.js';
import { createPlaceholder } from '@utils/placeholder.js';
import { hashToken } from '@utils/tokenHash.js';
import {
  verifyGoogleOAuthState,
  exchangeGoogleCodeForTokens,
  decodeJwtPayload,
} from '@utils/googleOAuth.js';
import {
  buildGithubAuthUrl,
  verifyGithubOAuthState,
  exchangeGithubCodeForTokens,
  fetchGithubUser,
  fetchGithubEmails,
  pickBestGithubEmail,
} from '@utils/githubOAuth.js';
import env from '@config/env.js';
import { refreshAccessTokenByRefreshToken } from '@utils/resignAccessToken.js';
import { verifyTokenHash } from '@utils/tokenHash.js';

import type {
  LoginDto,
  LoginResponseDto,
  RegisterDto,
  RegisterResponseDto,
  GoogleStartDto,
  GoogleStartResponseDto,
  GoogleCallbackDto,
  GithubStartDto,
  GithubStartResponseDto,
  GithubCallbackDto,
  ResendVerifyDto,
  VerifyEmailDto,
  PasswordForgotDto,
  PasswordResetDto,
  LogoutDto,
  RefreshDto,
  RefreshResponseDto,
} from 'types/dto/auth.dto.js';
import type { GoogleIdTokenPayload } from '@utils/googleOAuth.js';
import type { MessageResponseDto } from 'types/common.js';

async function register({
  email,
  password,
  name,
  userId: guestId,
  role,
}: RegisterDto): Promise<RegisterResponseDto> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name?.trim() || undefined;

  if (!cleanEmail) throw new BadRequestError('Email is required');
  if (!password || password.length < 6) {
    throw new BadRequestError('Password must be at least 6 characters');
  }

  const passwordHash = await hashPass(password);
  const { token, expiresAt } = makeVerifyToken();

  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`select cartlify.set_current_context(
        'GUEST'::cartlify."Role",
        NULL,
        ${guestId}::uuid
        )
      `;

      await tx.$executeRaw`
        insert into cartlify.users (email, "passwordHash", role, "isVerified", name)
        values (
          ${cleanEmail},
          ${passwordHash},
          'USER'::cartlify."Role",
          false,
          ${cleanName ?? null}
        )
      `;

      const [{ id }] = await tx.$queryRaw<{ id: number }[]>`
        select currval(pg_get_serial_sequence('cartlify.users', 'id'))::int as id
      `;

      await tx.$executeRaw`select cartlify.set_current_context(
        'USER'::cartlify."Role",
        ${id}::int,
        NULL
      )`;

      await tx.$executeRaw`
        insert into cartlify.user_tokens ("userId", type, token, "expiresAt")
        values (
          ${id},
          'VERIFY_EMAIL'::cartlify."UserTokenType",
          ${token},
          ${expiresAt}
        )
      `;

      const u = await tx.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          role: true,
          isVerified: true,
          createdAt: true,
          updatedAt: true,
          name: true,
          avatarUrl: true,
          locale: true,
          phone: true,
        },
      });

      if (!u) throw new AppError('User creation failed', 500);

      return {
        id: u.id,
        email: u.email as any,
        role: u.role as Role,
        isVerified: u.isVerified,
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
        ...(u.name ? { name: u.name } : {}),
        ...(u.avatarUrl ? { avatarUrl: u.avatarUrl } : {}),
        ...(u.locale ? { locale: u.locale } : {}),
        ...(u.phone ? { phone: u.phone } : {}),
      };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError('Email already in use', 409);
    }
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2010' &&
      (err.meta as any)?.code === '23505'
    ) {
      throw new AppError('Email already in use', 409);
    }
    throw err;
  }
}

async function login({
  email,
  password,
  rememberMe = false,
  ip,
  userAgent,
  userId: guestId,
}: LoginDto): Promise<{ result: LoginResponseDto; refreshToken: string; accessToken: string }> {
  const cleanEmail = email.trim().toLowerCase();

  assertEmail(cleanEmail);

  if (!cleanEmail) throw new BadRequestError('Email is required');
  if (!password) throw new BadRequestError('Password is required');

  const invalidCreds = () => new AppError('Invalid email or password', 401);

  return await prisma
    .$transaction(async (tx) => {
      await tx.$executeRaw`select cartlify.set_current_context(
      'GUEST'::cartlify."Role",
      NULL,
      ${guestId}::uuid
    )`;

      const rows = await tx.$queryRaw<
        {
          id: number;
          password_hash: string | null;
          role: Role;
          is_verified: boolean;
          provider: 'LOCAL' | 'GOOGLE' | 'GITHUB' | 'LINKEDIN';
        }[]
      >`select * from cartlify.auth_get_user_for_login(${cleanEmail})`;

      const u = rows[0];
      if (!u) throw invalidCreds();

      if (u.provider !== 'LOCAL') {
        throw new AppError(`Use ${u.provider} login for this account`, 403);
      }

      if (!u.password_hash) {
        throw new AppError('Local account has no password hash', 500);
      }

      const ok = await verifyPass(password, u.password_hash);
      if (!ok) throw invalidCreds();

      if (!u.is_verified) {
        throw new AppError('Email is not verified', 403);
      }

      await tx.$executeRaw`select cartlify.set_current_context(
      ${u.role}::cartlify."Role",
      ${u.id}::int,
      NULL
    )`;

      await tx.$executeRaw`select cartlify.migrate_guest_data_to_user(
        ${guestId}::uuid,
        ${u.id}::int
      )`;

      await tx.$executeRaw`
      insert into cartlify.login_logs ("userId", "email", "role", "ipAddress", "userAgent")
      values (${u.id}, ${cleanEmail}, ${u.role}::cartlify."Role", ${ip}, ${userAgent})
    `;

      const user = await tx.user.findUnique({
        where: { id: u.id },
        select: {
          id: true,
          email: true,
          role: true,
          isVerified: true,
          createdAt: true,
          updatedAt: true,
          name: true,
          avatarUrl: true,
          locale: true,
          phone: true,
        },
      });

      if (!user) throw new AppError('User not found after login', 500);

      assertEmail(user.email);

      const accessToken = signAccessToken(
        { userId: u.id, role: u.role, type: 'access' },
        rememberMe,
      );

      const placeholder = createPlaceholder(32, 'hex');

      const created = await tx.$queryRaw<{ id: number }[]>`
        insert into cartlify.user_tokens ("userId", type, token, "expiresAt")
        values (
          ${u.id},
          'REFRESH_TOKEN'::cartlify."UserTokenType",
          ${placeholder},
          now() + interval '60 second'
        )
        returning id
      `;

      const jwtId = created[0]?.id;
      if (!jwtId) throw new AppError('Failed to create refresh token row', 500);

      const refreshToken = signRefreshToken(
        { userId: u.id, role: u.role, type: 'refresh', jwtId, rememberMe },
        rememberMe,
      );

      const { exp } = verifyRefreshToken(refreshToken);
      if (!exp) throw new AppError('Failed to decode refresh token exp', 500);

      const refreshExpiresAt = new Date(exp * 1000);
      const refreshHash = hashToken(refreshToken);

      await tx.$executeRaw`
        update cartlify.user_tokens
        set token = ${refreshHash}, "expiresAt" = ${refreshExpiresAt}
        where id = ${jwtId}::int
      `;

      const result: LoginResponseDto = {
        id: user.id,
        email: user.email,
        role: user.role,
        isVerified: user.isVerified,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        ...(user.name ? { name: user.name } : {}),
        ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
        ...(user.locale ? { locale: user.locale } : {}),
        ...(user.phone ? { phone: user.phone } : {}),
      };

      return { result, refreshToken, accessToken };
    })
    .catch((err) => {
      if (err instanceof AppError) throw err;

      throw new AppError('Something went wrong', 500);
    });
}

async function googleStart({ guestId, role }: GoogleStartDto): Promise<GoogleStartResponseDto> {
  if (role !== 'GUEST') throw new AppError('Already authenticated', 409);
  if (!guestId) throw new AppError('Guest id is required', 400);

  const url = buildGoogleAuthUrl(String(guestId));
  return { url };
}

async function googleCallback({ code, state, ip, userAgent }: GoogleCallbackDto): Promise<{
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
  if (typeof idp.exp === 'number' && idp.exp <= now)
    throw new UnauthorizedError('GOOGLE_ID_TOKEN_EXPIRED');

  if (idp.iss && idp.iss !== 'https://accounts.google.com' && idp.iss !== 'accounts.google.com') {
    throw new UnauthorizedError('GOOGLE_ID_TOKEN_BAD_ISS');
  }
  if (idp.aud && idp.aud !== env.GOOGLE_CLIENT_ID)
    throw new UnauthorizedError('GOOGLE_ID_TOKEN_BAD_AUD');

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
      await tx.$executeRaw`select cartlify.set_current_context(
        'ADMIN'::cartlify."Role",
        NULL,
        NULL
      )`;

      const inserted = await tx.$queryRaw<
        {
          id: number;
          email: string;
          role: Role;
          isVerified: boolean;
          createdAt: Date;
          updatedAt: Date;
          name: string | null;
          avatarUrl: string | null;
          locale: string | null;
          phone: string | null;
          authProvider: 'LOCAL' | 'GOOGLE' | 'GITHUB' | 'LINKEDIN';
          providerSub: string | null;
        }[]
      >`
        insert into cartlify.users (
          email,
          role,
          "isVerified",
          name,
          "avatarUrl",
          locale,
          "authProvider",
          "providerSub",
          "passwordHash"
        )
        values (
          ${email},
          'USER'::cartlify."Role",
          ${emailVerified},
          ${name},
          ${avatarUrl},
          ${locale},
          'GOOGLE',
          ${sub},
          null
        )
        on conflict (email) do nothing
        returning
          id,
          email,
          role,
          "isVerified",
          "createdAt",
          "updatedAt",
          name,
          "avatarUrl",
          locale,
          phone,
          "authProvider",
          "providerSub"
      `;

      let u = inserted[0];

      if (!u) {
        const rows = await tx.$queryRaw<typeof inserted>`
          select
            id,
            email,
            role,
            "isVerified",
            "createdAt",
            "updatedAt",
            name,
            "avatarUrl",
            locale,
            phone,
            "authProvider",
            "providerSub"
          from cartlify.users
          where email = ${email}
          limit 1
        `;
        u = rows[0];
        if (!u) throw new AppError('USER_NOT_FOUND_AFTER_CONFLICT', 500);

        if (u.authProvider !== 'GOOGLE') {
          throw new AppError(`Use ${u.authProvider} login for this account`, 403);
        }

        if (u.providerSub && u.providerSub !== sub) {
          throw new AppError('GOOGLE_SUB_MISMATCH', 403);
        }
      }

      await tx.$executeRaw`select cartlify.set_current_context(
        ${u.role}::cartlify."Role",
        ${u.id}::int,
        NULL
      )`;

      await tx.$executeRaw`
        update cartlify.users
        set
          "providerSub" = coalesce("providerSub", ${sub}),
          name          = coalesce(name, ${name}),
          "avatarUrl"   = coalesce("avatarUrl", ${avatarUrl}),
          locale        = coalesce(locale, ${locale})
        where id = ${u.id}::int
      `;

      await tx.$executeRaw`select cartlify.migrate_guest_data_to_user(
        ${guestId}::uuid,
        ${u.id}::int
      )`;

      await tx.$executeRaw`
        insert into cartlify.login_logs ("userId", "email", "role", "ipAddress", "userAgent")
        values (${u.id}, ${email}, ${u.role}::cartlify."Role", ${ip ?? null}, ${userAgent ?? null})
      `;

      const rememberMe = true;

      const accessToken = signAccessToken(
        { userId: u.id, role: u.role, type: 'access' },
        rememberMe,
      );

      const placeholder = createPlaceholder(32, 'hex');

      const created = await tx.$queryRaw<{ id: number }[]>`
        insert into cartlify.user_tokens ("userId", type, token, "expiresAt")
        values (
          ${u.id},
          'REFRESH_TOKEN'::cartlify."UserTokenType",
          ${placeholder},
          now() + interval '60 second'
        )
        returning id
      `;

      const jwtId = created[0]?.id;
      if (!jwtId) throw new AppError('Failed to create refresh token row', 500);

      const refreshToken = signRefreshToken(
        { userId: u.id, role: u.role, type: 'refresh', jwtId, rememberMe },
        rememberMe,
      );

      const { exp } = verifyRefreshToken(refreshToken);
      if (!exp) throw new AppError('Failed to decode refresh token exp', 500);

      const refreshExpiresAt = new Date(exp * 1000);
      const refreshHash = hashToken(refreshToken);

      await tx.$executeRaw`
        update cartlify.user_tokens
        set token = ${refreshHash}, "expiresAt" = ${refreshExpiresAt}
        where id = ${jwtId}::int
      `;

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

async function githubStart({ guestId, role }: GithubStartDto): Promise<GithubStartResponseDto> {
  if (role !== 'GUEST') throw new AppError('Already authenticated', 409);
  if (!guestId) throw new AppError('Guest id is required', 400);

  const url = buildGithubAuthUrl(String(guestId));
  return { url };
}

async function githubCallback({ code, state, ip, userAgent }: GithubCallbackDto): Promise<{
  result: LoginResponseDto;
  refreshToken: string;
  accessToken: string;
}> {
  if (!code) throw new BadRequestError('MISSING_CODE');
  if (!state) throw new BadRequestError('MISSING_STATE');

  const st = verifyGithubOAuthState(state);
  if (!st) throw new BadRequestError('INVALID_STATE');
  const guestId = st.guestId;

  const tokens = await exchangeGithubCodeForTokens(code, state);
  if (!tokens.access_token) throw new BadRequestError('GITHUB_NO_ACCESS_TOKEN');

  const ghUser = await fetchGithubUser(tokens.access_token);
  const ghEmails = await fetchGithubEmails(tokens.access_token);

  const sub = String(ghUser.id ?? '').trim();
  if (!sub) throw new BadRequestError('GITHUB_SUB_MISSING');

  const picked = pickBestGithubEmail(ghUser, ghEmails);
  const email = (picked ?? '').trim().toLowerCase();
  if (!email) throw new BadRequestError('GITHUB_EMAIL_MISSING');
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

  return prisma
    .$transaction(async (tx) => {
      await tx.$executeRaw`select cartlify.set_current_context(
        'ADMIN'::cartlify."Role",
        NULL,
        NULL
      )`;

      const inserted = await tx.$queryRaw<
        {
          id: number;
          email: string;
          role: Role;
          isVerified: boolean;
          createdAt: Date;
          updatedAt: Date;
          name: string | null;
          avatarUrl: string | null;
          locale: string | null;
          phone: string | null;
          authProvider: 'LOCAL' | 'GOOGLE' | 'GITHUB' | 'LINKEDIN';
          providerSub: string | null;
        }[]
      >`
        insert into cartlify.users (
          email,
          role,
          "isVerified",
          name,
          "avatarUrl",
          locale,
          "authProvider",
          "providerSub",
          "passwordHash"
        )
        values (
          ${email},
          'USER'::cartlify."Role",
          true,
          ${name},
          ${avatarUrl},
          ${locale},
          'GITHUB',
          ${sub},
          null
        )
        on conflict (email) do nothing
        returning
          id,
          email,
          role,
          "isVerified",
          "createdAt",
          "updatedAt",
          name,
          "avatarUrl",
          locale,
          phone,
          "authProvider",
          "providerSub"
      `;

      let u = inserted[0];

      if (!u) {
        const rows = await tx.$queryRaw<typeof inserted>`
          select
            id,
            email,
            role,
            "isVerified",
            "createdAt",
            "updatedAt",
            name,
            "avatarUrl",
            locale,
            phone,
            "authProvider",
            "providerSub"
          from cartlify.users
          where email = ${email}
          limit 1
        `;
        u = rows[0];
        if (!u) throw new AppError('USER_NOT_FOUND_AFTER_CONFLICT', 500);

        if (u.authProvider !== 'GITHUB') {
          throw new AppError(`Use ${u.authProvider} login for this account`, 403);
        }

        if (u.providerSub && u.providerSub !== sub) {
          throw new AppError('GITHUB_SUB_MISMATCH', 403);
        }
      }

      await tx.$executeRaw`select cartlify.set_current_context(
        ${u.role}::cartlify."Role",
        ${u.id}::int,
        NULL
      )`;

      await tx.$executeRaw`
        update cartlify.users
        set
          "providerSub" = coalesce("providerSub", ${sub}),
          name          = coalesce(name, ${name}),
          "avatarUrl"   = coalesce("avatarUrl", ${avatarUrl}),
          locale        = coalesce(locale, ${locale})
        where id = ${u.id}::int
      `;

      await tx.$executeRaw`select cartlify.migrate_guest_data_to_user(
        ${guestId}::uuid,
        ${u.id}::int
      )`;

      await tx.$executeRaw`
        insert into cartlify.login_logs ("userId", "email", "role", "ipAddress", "userAgent")
        values (${u.id}, ${email}, ${u.role}::cartlify."Role", ${ip ?? null}, ${userAgent ?? null})
      `;

      const rememberMe = true;

      const accessToken = signAccessToken(
        { userId: u.id, role: u.role, type: 'access' },
        rememberMe,
      );

      const placeholder = createPlaceholder(32, 'hex');

      const created = await tx.$queryRaw<{ id: number }[]>`
        insert into cartlify.user_tokens ("userId", type, token, "expiresAt")
        values (
          ${u.id},
          'REFRESH_TOKEN'::cartlify."UserTokenType",
          ${placeholder},
          now() + interval '60 second'
        )
        returning id
      `;

      const jwtId = created[0]?.id;
      if (!jwtId) throw new AppError('Failed to create refresh token row', 500);

      const refreshToken = signRefreshToken(
        { userId: u.id, role: u.role, type: 'refresh', jwtId, rememberMe },
        rememberMe,
      );

      const { exp } = verifyRefreshToken(refreshToken);
      if (!exp) throw new AppError('Failed to decode refresh token exp', 500);

      const refreshExpiresAt = new Date(exp * 1000);
      const refreshHash = hashToken(refreshToken);

      await tx.$executeRaw`
        update cartlify.user_tokens
        set token = ${refreshHash}, "expiresAt" = ${refreshExpiresAt}
        where id = ${jwtId}::int
      `;

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

      throw err;
    });
}

async function resendVerify({ email }: ResendVerifyDto): Promise<MessageResponseDto> {
  assertEmail(email);

  const cleanEmail = email.trim().toLowerCase();
  const { token, expiresAt } = makeVerifyToken();
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`select cartlify.set_current_context(
      'GUEST'::cartlify."Role",
      NULL,
      NULL
    )`;

    const rows = await tx.$queryRaw<
      { user_id: number; token: string; expires_at: Date }[]
    >`select * from cartlify.auth_resend_verify(${cleanEmail}, ${token}, ${expiresAt})`;

    if (rows.length) {
      console.log('[VERIFY_EMAIL_RESEND]', { email: cleanEmail, rows });
    }
  });

  return { message: 'If the email exists, a verification link was sent.' };
}

async function verifyEmail({ token }: VerifyEmailDto): Promise<{ message: string }> {
  const cleanToken = token?.trim();
  if (!cleanToken) throw new BadRequestError('Token is required');

  const ok = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`select cartlify.set_current_context('GUEST'::cartlify."Role", NULL, NULL)`;

    const rows = await tx.$queryRaw<{ ok: boolean }[]>`
      select cartlify.auth_verify_email(${cleanToken}::text) as ok
    `;
    return Boolean(rows[0]?.ok);
  });

  if (!ok) throw new AppError('Invalid or expired token', 400);

  return { message: 'Email verified' };
}

async function passwordForgot({ email }: PasswordForgotDto): Promise<MessageResponseDto> {
  const cleanEmail = email?.trim().toLowerCase();
  if (!cleanEmail) throw new BadRequestError('Email is required');

  assertEmail(cleanEmail);

  const genericOk = { message: 'If account exists, reset email will be sent' };

  return prisma
    .$transaction(async (tx) => {
      await tx.$executeRaw`select cartlify.set_current_context(
        'ADMIN'::cartlify."Role",
        NULL,
        NULL
      )`;

      const rows = await tx.$queryRaw<
        { id: number; email: string; authProvider: 'LOCAL' | 'GOOGLE' | 'GITHUB' | 'LINKEDIN' }[]
      >`
        select id, email, "authProvider" as "authProvider"
        from cartlify.users
        where email = ${cleanEmail}
        limit 1
      `;

      if (!rows.length) return genericOk;

      const u = rows[0];

      if (u.authProvider !== 'LOCAL') {
        return genericOk;
      }

      const rawToken = createPlaceholder();
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + env.RESET_TTL_MS);

      await tx.userToken.create({
        data: {
          userId: u.id,
          type: 'RESET_PASSWORD',
          token: tokenHash,
          expiresAt,
        },
      });

      const resetUrl = '${env.APP_URL}/web/auth/reset?token=${rawToken}';

      console.log('[PASSWORD_FORGOT_EMAIL_PREVIEW]', { email: cleanEmail, resetUrl, expiresAt });

      return genericOk;
    })
    .catch((err) => {
      if (isAppError(err)) throw err;

      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'unknown';

      throw new AppError(`passwordForgot: unexpected (${msg})`, 500);
    });
}

async function passwordReset({
  token,
  newPassword,
}: PasswordResetDto): Promise<MessageResponseDto> {
  const cleanToken = token?.trim();
  if (!cleanToken) throw new BadRequestError('TOKEN_REQUIRED');

  const cleanNewPassword = newPassword?.trim();
  if (!cleanNewPassword) throw new BadRequestError('NEW_PASSWORD_REQUIRED');
  if (cleanNewPassword.length < 6) throw new BadRequestError('PASSWORD_TOO_SHORT');

  const roundsRaw = (env as Record<string, unknown>).BCRYPT_ROUNDS;
  const rounds = typeof roundsRaw === 'string' ? Number(roundsRaw) : 12;
  if (!Number.isInteger(rounds) || rounds < 10 || rounds > 15) {
    throw new AppError('Server misconfigured: BCRYPT_ROUNDS', 500);
  }

  const tokenHash = hashToken(cleanToken);
  const now = new Date();

  return prisma
    .$transaction(async (tx) => {
      await tx.$executeRaw`select cartlify.set_current_context(
        'ADMIN'::cartlify."Role",
        NULL,
        NULL
      )`;

      const consumed = await tx.$queryRaw<{ userId: number }[]>`
        update cartlify.user_tokens ut
        set "usedAt" = ${now}
        where ut.type = 'RESET_PASSWORD'::cartlify."UserTokenType"
          and ut."usedAt" is null
          and ut."expiresAt" > now()
          and ut.token = ${tokenHash}
        returning ut."userId" as "userId"
      `;

      const userId = consumed[0]?.userId;
      if (!userId) throw new AppError('Invalid or expired token', 400);

      const passwordHash = await hashPass(cleanNewPassword);

      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          updatedAt: now,
        },
        select: { id: true },
      });

      await tx.userToken.updateMany({
        where: { userId, type: 'REFRESH_TOKEN', usedAt: null },
        data: { usedAt: now },
      });

      return { message: 'Password reset successful' };
    })
    .catch((err) => {
      if (isAppError(err)) throw err;

      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'unknown';

      throw new AppError(`passwordReset: unexpected (${msg})`, 500);
    });
}

async function logout({
  refreshToken,
  allDevices = false,
}: LogoutDto): Promise<MessageResponseDto> {
  const rt = refreshToken?.trim();

  if (!rt) return { message: 'ok' };

  let payload: { userId: number; jwtId: number; role: Role };
  try {
    const { userId, jwtId, role } = verifyRefreshToken(rt);
    payload = { userId, jwtId, role };
  } catch (err) {
    if (isAppError(err)) return { message: 'ok' };
    throw new AppError('logout: unexpected verify error', 500);
  }

  const now = new Date();

  return prisma
    .$transaction(async (tx) => {
      await tx.$executeRaw`select cartlify.set_current_context(
        ${payload.role}::cartlify."Role",
        ${payload.userId}::int,
        NULL
      )`;

      const tokenRow = await tx.userToken.findUnique({
        where: { id: payload.jwtId },
        select: {
          id: true,
          userId: true,
          type: true,
          token: true,
          usedAt: true,
        },
      });

      if (!tokenRow) return { message: 'ok' };

      if (tokenRow.userId !== payload.userId) return { message: 'ok' };
      if (tokenRow.type !== 'REFRESH_TOKEN') return { message: 'ok' };

      if (tokenRow.usedAt) return { message: 'ok' };

      const ok = verifyTokenHash(rt, tokenRow.token);
      if (!ok) return { message: 'ok' };

      if (allDevices) {
        await tx.userToken.updateMany({
          where: {
            userId: payload.userId,
            type: 'REFRESH_TOKEN',
            usedAt: null,
          },
          data: { usedAt: now },
        });
      } else {
        await tx.userToken.updateMany({
          where: { id: tokenRow.id, usedAt: null },
          data: { usedAt: now },
        });
      }

      return { message: 'ok' };
    })
    .catch((err) => {
      if (isAppError(err)) throw err;
      const msg =
        typeof err === 'object' && err !== null && 'message' in err
          ? String((err as { message: unknown }).message)
          : 'unknown';
      throw new AppError(`logout: unexpected (${msg})`, 500);
    });
}

async function refresh({ refreshToken }: RefreshDto): Promise<RefreshResponseDto> {
  const rt = refreshToken?.trim();
  if (!rt) throw new BadRequestError('REFRESH_TOKEN_REQUIRED');

  try {
    const { accessToken } = await refreshAccessTokenByRefreshToken({ refreshToken: rt });
    return { accessToken };
  } catch (err) {
    if (isAppError(err)) throw err;

    const msg =
      typeof err === 'object' && err !== null && 'message' in err
        ? String((err as { message: unknown }).message)
        : 'unknown';

    throw new AppError(`refresh(service): unexpected (${msg})`, 500);
  }
}

export const authServices = {
  login,
  register,
  googleStart,
  googleCallback,
  githubStart,
  githubCallback,
  resendVerify,
  verifyEmail,
  passwordForgot,
  passwordReset,
  logout,
  refresh,
};
