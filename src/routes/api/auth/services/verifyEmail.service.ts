import { prisma } from '@db/client.js';
import { AppError, BadRequestError, InternalError } from '@utils/errors.js';
import { assertEmail } from '@helpers/validateEmail.js';
import { makeVerifyToken } from '@helpers/makeTokens.js';
import { hashToken } from '@helpers/tokenHash.js';

import { sendVerifyEmail } from './helpers/sendVerifyEmail.helper.js';

import type { FastifyBaseLogger } from 'fastify';

import type { ResendVerifyDto, VerifyEmailDto } from 'types/dto/auth.dto.js';
import type { MessageResponseDto } from 'types/common.js';

import { setAdminContext, setGuestNullContext } from '@db/dbContext.service.js';

import { migrateGuestDataToUser } from './helpers/guestMigration.helper.js';

import type { Role } from 'types/user.js';

// the mail of a new link of confirmation, and the account it is for (the log names the account,
// not the email)
type VerifyMailJob = { to: string; token: string; expiresAt: Date; userId: number };

// resend verify email flow
// create new verify token
export async function resendVerify(
  { email }: ResendVerifyDto,
  log: Pick<FastifyBaseLogger, 'error'>,
): Promise<MessageResponseDto> {
  assertEmail(email);

  const cleanEmail = email.trim().toLowerCase();
  const { token, expiresAt } = makeVerifyToken();

  let sendPayload: VerifyMailJob | null = null;

  await prisma.$transaction(async (tx) => {
    await setGuestNullContext(tx);

    // the database gets the hash and closes the earlier links, the mail carries the new link
    const rows = await tx.$queryRaw<{ user_id: number; token: string; expires_at: Date }[]>`
      select * from cartlify.auth_resend_verify(${cleanEmail}, ${hashToken(token)}, ${expiresAt})
    `;

    // schedule email only when user exists
    if (rows.length) {
      sendPayload = {
        to: cleanEmail,
        token,
        expiresAt: rows[0].expires_at,
        userId: rows[0].user_id,
      };
    }
  });

  // avoid user enumeration: a mail the provider did not take is only logged, another answer than
  // the generic one would tell that an unconfirmed account has this email
  if (sendPayload) {
    // set inside the transaction, which the narrowing of typescript does not follow
    const { userId, ...mail } = sendPayload as VerifyMailJob;
    try {
      await sendVerifyEmail(mail);
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 502) {
        log.error({ err, userId }, 'verification mail was not sent');
      } else if (err instanceof AppError) {
        throw err;
      } else {
        throw new InternalError({ reason: 'VERIFY_EMAIL_RESEND_SEND_FAILED' }, err);
      }
    }
  }

  // generic response
  return { message: 'If the email exists, a verification link was sent.' };
}

// the link proves the email: the favorites, the chats and the cart of the guest of the browser
// that opens it move to the account, the same as at a login
export async function verifyEmail({ token, guestId }: VerifyEmailDto): Promise<MessageResponseDto> {
  const cleanToken = token?.trim();
  if (!cleanToken) throw new BadRequestError('TOKEN_REQUIRED');

  // the database keeps only the hash of the link
  const tokenHash = hashToken(cleanToken);

  try {
    const ok = await prisma.$transaction(async (tx) => {
      // the account of the link, read by the system: a guest sees neither links nor users
      await setAdminContext(tx);
      const [link] = await tx.$queryRaw<{ userId: number; role: Role }[]>`
        select t."userId" as "userId", u.role
        from cartlify.user_tokens as t
        join cartlify.users as u on u.id = t."userId"
        where t.type = 'VERIFY_EMAIL'::cartlify."UserTokenType" and t.token = ${tokenHash}
      `;

      await setGuestNullContext(tx);
      const rows = await tx.$queryRaw<{ ok: boolean }[]>`
        select cartlify.auth_verify_email(${tokenHash}::text) as ok
      `;
      const verified = Boolean(rows[0]?.ok);

      if (verified && link && guestId) {
        await migrateGuestDataToUser(tx, guestId, { id: link.userId, role: link.role });
      }

      return verified;
    });

    // reject invalid token
    if (!ok) throw new BadRequestError('VERIFY_TOKEN_INVALID_OR_EXPIRED');

    return { message: 'Email verified' };
  } catch (err) {
    if (err instanceof AppError) throw err;

    throw new InternalError({ reason: 'VERIFY_EMAIL_UNEXPECTED' }, err);
  }
}
