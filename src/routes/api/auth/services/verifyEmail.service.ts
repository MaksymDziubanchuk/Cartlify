import { prisma } from '@db/client.js';
import { AppError, BadRequestError } from '@utils/errors.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { makeVerifyToken } from '@helpers/makeTokens.js';

import type { ResendVerifyDto, VerifyEmailDto } from 'types/dto/auth.dto.js';
import type { MessageResponseDto } from 'types/common.js';

import { setGuestNullContext } from '@db/dbContext.service.js';

// resend verify email flow
// create new verify token
export async function resendVerify({ email }: ResendVerifyDto): Promise<MessageResponseDto> {
  assertEmail(email);

  const cleanEmail = email.trim().toLowerCase();
  const { token, expiresAt } = makeVerifyToken();

  await prisma.$transaction(async (tx) => {
    await setGuestNullContext(tx);

    // call db resend function
    const rows = await tx.$queryRaw<{ user_id: number; token: string; expires_at: Date }[]>`
      select * from cartlify.auth_resend_verify(${cleanEmail}, ${token}, ${expiresAt})
    `;

    // log only when user exists
    if (rows.length) {
      console.log('[VERIFY_EMAIL_RESEND]', { email: cleanEmail, rows });
    }
  });

  // generic response
  return { message: 'If the email exists, a verification link was sent.' };
}

export async function verifyEmail({ token }: VerifyEmailDto): Promise<MessageResponseDto> {
  const cleanToken = token?.trim();
  if (!cleanToken) throw new BadRequestError('Token is required');

  const ok = await prisma.$transaction(async (tx) => {
    await setGuestNullContext(tx);

    // call db verify function
    const rows = await tx.$queryRaw<{ ok: boolean }[]>`
      select cartlify.auth_verify_email(${cleanToken}::text) as ok
    `;

    return Boolean(rows[0]?.ok);
  });

  // reject invalid token
  if (!ok) throw new AppError('Invalid or expired token', 400);

  return { message: 'Email verified' };
}
