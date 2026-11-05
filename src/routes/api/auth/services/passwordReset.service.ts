import { prisma } from '@db/client.js';

import { AppError, BadRequestError, InternalError, isAppError } from '@utils/errors.js';

import { assertEmail } from '@helpers/validateEmail.js';
import { mailLocaleOf } from '@helpers/locale.js';
import { hashPass } from '@helpers/safePass.js';

import env from '@config/env.js';
import { createPlaceholder } from '@helpers/placeholder.js';
import { hashToken } from '@helpers/tokenHash.js';

import { sendResetPasswordEmail } from '@routes/api/auth/services/helpers/sendResetPasswordEmail.helper.js';
import { revokeAllActiveRefreshTokens } from '@routes/api/auth/services/helpers/tokenRotation.helper.js';
import { setAdminContext, setUserContext } from '@db/dbContext.service.js';

import type { FastifyBaseLogger } from 'fastify';

import type { PasswordForgotDto, PasswordResetDto } from 'types/dto/auth.dto.js';
import type { MessageResponseDto } from 'types/common.js';
import type { Role } from 'types/user.js';

// password reset request flow
// create reset token row
// return generic response
// the mail of a link of reset, and the account it is for (the log names the account, not the email)
type ResetMailJob = {
  to: string;
  resetToken: string;
  expiresAt: Date;
  userId: number;
  locale: string;
};

export async function passwordForgot(
  { email }: PasswordForgotDto,
  log: Pick<FastifyBaseLogger, 'error' | 'warn'>,
): Promise<MessageResponseDto> {
  const cleanEmail = email?.trim().toLowerCase();
  if (!cleanEmail) throw new BadRequestError('EMAIL_REQUIRED');

  assertEmail(cleanEmail);

  const genericOk = { message: 'If account exists, reset email will be sent' };

  let sendJob: ResetMailJob | null = null;

  try {
    const res = await prisma.$transaction(async (tx) => {
      await setAdminContext(tx);

      // load user by email
      const rows = await tx.$queryRaw<
        {
          id: number;
          email: string;
          authProvider: 'LOCAL' | 'GOOGLE' | 'GITHUB' | 'LINKEDIN';
          locale: string | null;
        }[]
      >`
      select id, email, "authProvider" as "authProvider", locale
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

      // the newest link is the one the person waits for: the links mailed before are closed, an
      // old one lying in a mailbox would be a way in
      await tx.userToken.updateMany({
        where: { userId: u.id, type: 'RESET_PASSWORD', usedAt: null },
        data: { usedAt: new Date() },
      });

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

      // the sessions stay: anyone can ask for a link for any email, they end only when
      // the password is really reset (passwordReset below)

      // schedule email send
      sendJob = {
        to: cleanEmail,
        resetToken: rawToken,
        expiresAt,
        userId: u.id,
        locale: mailLocaleOf(u.locale),
      };

      // return generic ok
      return genericOk;
    });

    // avoid user enumeration
    if (!sendJob) return res;

    // set inside the transaction, which the narrowing of typescript does not follow
    const { userId, ...mail } = sendJob as ResetMailJob;
    try {
      await sendResetPasswordEmail(mail, log);
    } catch (err) {
      // a mail the provider did not take is only logged: another answer than the generic one would
      // tell that an account has this email. Our own error stays a server error
      if (!(err instanceof AppError && err.statusCode === 502)) throw err;
      log.error({ err, userId }, 'password reset mail was not sent');
    }

    return res;
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PASSWORD_FORGOT_UNEXPECTED' }, err);
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

  // spaces at the edges of a password are dropped, the same at registration and login
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
      if (!userId) throw new BadRequestError('RESET_TOKEN_INVALID_OR_EXPIRED');

      // load user role and switch into owner context
      const userRows = await tx.$queryRaw<{ id: number; role: Role }[]>`
        select id, role
        from cartlify.users
        where id = ${userId}::int
        limit 1
      `;

      const u = userRows[0];
      if (!u) throw new InternalError({ reason: 'USER_NOT_FOUND_FOR_RESET' });

      await setUserContext(tx, { userId: u.id, role: u.role });

      await tx.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          updatedAt: now,
        },
        select: { id: true },
      });

      // revoke active refresh tokens: the old cookie of a phone is then a plain refusal, the
      // session opened after the reset goes on
      await revokeAllActiveRefreshTokens(tx, { userId, at: now });

      // the other links of the account end with this one
      await tx.userToken.updateMany({
        where: { userId, type: 'RESET_PASSWORD', usedAt: null },
        data: { usedAt: now },
      });

      return { message: 'Password reset successful' };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PASSWORD_RESET_UNEXPECTED' }, err);
  }
}
