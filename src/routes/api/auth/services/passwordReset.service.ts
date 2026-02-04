import { prisma } from '@db/client.js';

import { AppError, BadRequestError, isAppError } from '@utils/errors.js';

import { assertEmail } from '@helpers/validateEmail.js';
import { hashPass } from '@helpers/safePass.js';

import env from '@config/env.js';
import { createPlaceholder } from '@utils/placeholder.js';
import { hashToken } from '@utils/tokenHash.js';

import type { PasswordForgotDto, PasswordResetDto } from 'types/dto/auth.dto.js';
import type { MessageResponseDto } from 'types/common.js';

import { setAdminNullContext } from '@db/dbContext.service.js';

export async function passwordForgot({ email }: PasswordForgotDto): Promise<MessageResponseDto> {
  const cleanEmail = email?.trim().toLowerCase();
  if (!cleanEmail) throw new BadRequestError('Email is required');

  assertEmail(cleanEmail);

  const genericOk = { message: 'If account exists, reset email will be sent' };

  return prisma
    .$transaction(async (tx) => {
      await setAdminNullContext(tx);

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

export async function passwordReset({
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
      await setAdminNullContext(tx);

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
