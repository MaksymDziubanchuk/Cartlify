import { prisma } from '@db/client.js';

import { AppError, BadRequestError, isAppError } from '@utils/errors.js';

import { assertEmail } from '@helpers/validateEmail.js';
import { hashPass } from '@helpers/safePass.js';

import env from '@config/env.js';
import { createPlaceholder } from '@helpers/placeholder.js';
import { hashToken } from '@helpers/tokenHash.js';

import { sendResetPasswordEmail } from '@routes/api/auth/services/helpers/sendResetPasswordEmail.helper.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';

import type { PasswordForgotDto, PasswordResetDto } from 'types/dto/auth.dto.js';
import type { MessageResponseDto } from 'types/common.js';
import type { Role } from 'types/user.js';

// password reset request flow
// create reset token row
// return generic response
export async function passwordForgot({ email }: PasswordForgotDto): Promise<MessageResponseDto> {
  const cleanEmail = email?.trim().toLowerCase();
  if (!cleanEmail) throw new BadRequestError('Email is required');

  assertEmail(cleanEmail);

  const genericOk = { message: 'If account exists, reset email will be sent' };

  let sendJob: { to: string; resetToken: string; expiresAt: Date } | null = null;

  try {
    const res = await prisma.$transaction(async (tx) => {
      await setAdminContext(tx);

      // load user by email
      const rows = await tx.$queryRaw<
        { id: number; email: string; authProvider: 'LOCAL' | 'GOOGLE' | 'GITHUB' | 'LINKEDIN' }[]
      >`
      select id, email, "authProvider" as "authProvider"
      from cartlify.users
      where email = ${cleanEmail}
      limit 1
    `;

      // keep response generic
      if (!rows.length) return genericOk;

      const u = rows[0];

      // skip non-local accounts
      if (u.authProvider !== 'LOCAL') {
        return genericOk;
      }

      // issue reset token row
      const rawToken = createPlaceholder();
      const tokenHash = hashToken(rawToken);
      const expiresAt = new Date(Date.now() + env.RESET_TTL_MS);

      // store reset token in db
      await tx.userToken.create({
        data: {
          userId: u.id,
          type: 'RESET_PASSWORD',
          token: tokenHash,
          expiresAt,
        },
      });

      // revoke all active refresh tokens for this user
      const now = new Date();

      await tx.userToken.updateMany({
        where: { userId: u.id, type: 'REFRESH_TOKEN', usedAt: null },
        data: { usedAt: now },
      });

      // schedule email send
      sendJob = { to: cleanEmail, resetToken: rawToken, expiresAt };

      // return generic ok
      return genericOk;
    });

    // avoid user enumeration
    if (!sendJob) return res;

    try {
      await sendResetPasswordEmail(sendJob);
    } catch {
      throw new AppError('PASSWORD_FORGOT_EMAIL_SEND_FAILED', 500);
    }

    return res;
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new AppError(`passwordForgot: unexpected`, 500);
  }
}

// password reset flow
// consume reset token once
// rotate password and revoke sessions
export async function passwordReset({
  token,
  newPassword,
}: PasswordResetDto): Promise<MessageResponseDto> {
  const cleanToken = token?.trim();
  if (!cleanToken) throw new BadRequestError('TOKEN_REQUIRED');

  const cleanNewPassword = newPassword?.trim();
  if (!cleanNewPassword) throw new BadRequestError('NEW_PASSWORD_REQUIRED');
  if (cleanNewPassword.length < 6) throw new BadRequestError('PASSWORD_TOO_SHORT');

  // hash new password
  const passwordHash = await hashPass(cleanNewPassword);

  // hash incoming reset token
  const tokenHash = hashToken(cleanToken);
  const now = new Date();
  try {
    return await prisma.$transaction(async (tx) => {
      await setAdminContext(tx);

      // consume valid reset token
      const consumed = await tx.$queryRaw<{ userId: number }[]>`
      update cartlify.user_tokens ut
      set "usedAt" = ${now}
      where ut.type = 'RESET_PASSWORD'::cartlify."UserTokenType"
        and ut."usedAt" is null
        and ut."expiresAt" > now()
        and ut.token = ${tokenHash}
      returning ut."userId" as "userId"
    `;

      // require consumed token row
      const userId = consumed[0]?.userId;
      if (!userId) throw new AppError('Invalid or expired token', 400);

      // load user role and switch into owner context
      const userRows = await tx.$queryRaw<{ id: number; role: Role }[]>`
        select id, role
        from cartlify.users
        where id = ${userId}::int
        limit 1
      `;

      const u = userRows[0];
      if (!u) throw new AppError('USER_NOT_FOUND_FOR_RESET', 500);

      await setUserContext(tx, { userId: u.id, role: u.role });

      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          updatedAt: now,
        },
        select: { id: true },
      });

      // revoke active refresh tokens
      await tx.userToken.updateMany({
        where: { userId, type: 'REFRESH_TOKEN', usedAt: null },
        data: { usedAt: now },
      });

      return { message: 'Password reset successful' };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new AppError(`passwordReset: unexpected`, 500);
  }
}
