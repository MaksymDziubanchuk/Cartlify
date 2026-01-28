import { Prisma, Role } from '@prisma/client';
import { prisma } from '@db/client.js';
import { AppError, BadRequestError } from '@utils/errors.js';
import { makeVerifyToken } from '@helpers/makeTokens.js';
import { hashPass, verifyPass } from '@helpers/safePass.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { signAccessToken } from '@utils/jwt.js';

import type {
  LoginDto,
  LoginResponseDto,
  RegisterDto,
  RegisterResponseDto,
  ResendVerifyDto,
  VerifyEmailDto,
  PasswordForgotDto,
  PasswordResetDto,
  LogoutDto,
  RefreshDto,
} from 'types/dto/auth.dto.js';
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

export async function verifyEmail({ token }: VerifyEmailDto): Promise<{ message: string }> {
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
  resendVerify,
  verifyEmail,
  passwordForgot,
  passwordReset,
  logout,
  refresh,
};
