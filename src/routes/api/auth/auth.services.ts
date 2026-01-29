import { Prisma, Role } from '@prisma/client';
import { prisma } from '@db/client.js';
import { AppError, BadRequestError } from '@utils/errors.js';
import { buildGoogleAuthUrl } from '@utils/googleOAuth.js';
import { makeVerifyToken } from '@helpers/makeTokens.js';
import { hashPass, verifyPass } from '@helpers/safePass.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { signAccessToken } from '@utils/jwt.js';
import {
  verifyGoogleOAuthState,
  exchangeGoogleCodeForTokens,
  decodeJwtPayload,
} from '@utils/googleOAuth.js';

import type {
  LoginDto,
  LoginResponseDto,
  RegisterDto,
  RegisterResponseDto,
  GoogleStartDto,
  GoogleStartResponseDto,
  GoogleCallbackDto,
  ResendVerifyDto,
  VerifyEmailDto,
  PasswordForgotDto,
  PasswordResetDto,
  LogoutDto,
  RefreshDto,
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
}: LoginDto): Promise<LoginResponseDto> {
  const cleanEmail = email.trim().toLowerCase();

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
        { id: number; password_hash: string; role: Role; is_verified: boolean }[]
      >`select * from cartlify.auth_get_user_for_login(${cleanEmail})`;

      const u = rows[0];
      if (!u) throw invalidCreds();

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
      const accessToken = signAccessToken({ userId: u.id, role: u.role }, rememberMe);

      const dto: LoginResponseDto = {
        accessToken,
        user: {
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
        },
      };

      return dto;
    })
    .catch((err) => {
      if (err instanceof AppError) throw err;

      throw new AppError('Something went wrong', 500);
    });
}

export async function googleStart({
  guestId,
  role,
}: GoogleStartDto): Promise<GoogleStartResponseDto> {
  if (role !== 'GUEST') throw new AppError('Already authenticated', 409);
  if (!guestId) throw new AppError('Guest id is required', 400);

  const url = buildGoogleAuthUrl(String(guestId));
  return { url };
}

export async function googleCallback({
  code,
  state,
  ip,
  userAgent,
}: GoogleCallbackDto): Promise<MessageResponseDto> {
  if (!code) throw new BadRequestError('MISSING_CODE');
  if (!state) throw new BadRequestError('MISSING_STATE');

  // 1) Витягаємо guestId зі state (і перевіряємо підпис/час в твоїй verifyGoogleOAuthState)
  const st = verifyGoogleOAuthState(state); // очікую щось типу { guestId, nonce, iat }
  if (!st) throw new AppError('INVALID_STATE', 500);
  const guestId = st.guestId;

  // 2) Міняємо code -> tokens (access_token + id_token)
  const tokens = await exchangeGoogleCodeForTokens(code);

  // 3) Дістаємо профіль з id_token (це JWT). Поки без крипто-верифікації підпису — лише для логів.
  const idp = decodeJwtPayload<GoogleIdTokenPayload>(tokens.id_token);

  const googleUser = {
    sub: idp.sub, // унікальний id юзера в Google
    email: idp.email ?? null,
    emailVerified: idp.email_verified ?? null,
    name: idp.name ?? null,
    avatarUrl: idp.picture ?? null,
    locale: idp.locale ?? null,
  };

  // 4) Оце “план” що ми б робили з БД (поки тільки LOG)
  const dbPlan = {
    lookup: {
      byEmail: googleUser.email, // якщо null → доведеться відмовити
    },
    createUserIfNotExists: {
      email: googleUser.email,
      role: 'USER',
      isVerified: googleUser.emailVerified === true,
      name: googleUser.name,
      avatarUrl: googleUser.avatarUrl,
      locale: googleUser.locale,
      // у тебе passwordHash NOT NULL → або міняти схему, або ставити випадковий пароль (поки планом)
      passwordHash: '<hash(randomBytes(32))>',
    },
    createProviderRowIfYouAddTable: {
      provider: 'google',
      providerSubject: googleUser.sub,
      email: googleUser.email,
      userId: '<resolved_user_id>',
    },
    loginLog: {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
      guestId,
      userId: '<resolved_user_id>',
      role: 'USER',
    },
    guestMigration: {
      guestId,
      userId: '<resolved_user_id>',
      fn: 'cartlify.migrate_guest_data_to_user',
    },
    jwtIssue: {
      accessToken: '<signAccessToken({ userId, role })>',
      ttl: '<short/long by rememberMe>',
    },
  };

  console.log('[GOOGLE_OAUTH_CALLBACK]', {
    guestId,
    tokens: {
      token_type: tokens.token_type,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      has_refresh_token: Boolean(tokens.refresh_token),
      has_access_token: Boolean(tokens.access_token),
      has_id_token: Boolean(tokens.id_token),
    },
    googleUser,
    dbPlan,
  });

  return { message: 'Google callback received (stub). See server logs.' };
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
  return { message: 'password forgot not implemented' };
}

async function passwordReset({
  token,
  newPassword,
}: PasswordResetDto): Promise<MessageResponseDto> {
  return { message: 'password reset not implemented' };
}

async function logout({ userId }: LogoutDto): Promise<void> {
  return;
}

async function refresh({ userId }: RefreshDto): Promise<MessageResponseDto> {
  return { message: 'refresh not implemented' };
}

export const authServices = {
  login,
  register,
  googleStart,
  googleCallback,
  resendVerify,
  verifyEmail,
  passwordForgot,
  passwordReset,
  logout,
  refresh,
};
