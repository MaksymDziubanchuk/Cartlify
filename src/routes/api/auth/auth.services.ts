import { Prisma, UserTokenType, Role } from '@prisma/client';
import { prisma } from '@db/client.js';
import { AppError, BadRequestError } from '@utils/errors.js';
import { makeVerifyToken } from '@helpers/makeTokens.js';
import { hashPass } from '@helpers/safePass.js';

import type {
  LoginDto,
  RegisterDto,
  ResendVerifyDto,
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
}: RegisterDto): Promise<MessageResponseDto> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanName = name?.trim() || undefined;

  if (!cleanEmail) throw new BadRequestError('Email is required');
  if (!password || password.length < 6) {
    throw new BadRequestError('Password must be at least 6 characters');
  }

  const passwordHash = await hashPass(password);
  const { token, expiresAt } = makeVerifyToken();

  try {
    await prisma.$transaction(async (tx) => {
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

      await tx.$executeRaw`
        insert into cartlify.user_tokens ("userId", type, token, "expiresAt")
        values (
          ${id},
          'VERIFY_EMAIL'::cartlify."UserTokenType",
          ${token},
          ${expiresAt}
        )
      `;
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

  // TODO: відправка листа з token (verify link)
  return { message: 'Registered. Email verification required.' };
}

async function login({
  email,
  password,
  rememberMe = false,
  ip,
  userAgent,
}: LoginDto): Promise<MessageResponseDto> {
  return { message: 'login not implemented' };
}

async function resendVerify({ userId }: ResendVerifyDto): Promise<MessageResponseDto> {
  return { message: 'verify resend not implemented' };
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
  passwordForgot,
  passwordReset,
  logout,
  refresh,
};
