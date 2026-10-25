import type { FastifyBaseLogger } from 'fastify';
import type { Role } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { hashPass, verifyPass } from '@helpers/safePass.js';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  isAppError,
  NotFoundError,
} from '@utils/errors.js';

import { sendPasswordChangedEmail } from './helpers/sendPasswordChangedEmail.helper.js';
import { revokeAllActiveRefreshTokens } from './helpers/tokenRotation.helper.js';
import { currentSessionIdOf } from './sessions.service.js';

type ChangePasswordDto = {
  userId: number;
  role: Role;
  refreshToken?: string;
  currentPassword: string;
  newPassword: string;
  log: Pick<FastifyBaseLogger, 'warn'>;
};

// a signed-in person changes the password, knowing the current one: the other sessions of the
// account end (a session somebody else holds), this one goes on, the pending reset links close,
// and the owner gets a mail. An account of google, github or linkedin has no password of ours
export async function changePassword({
  userId,
  role,
  refreshToken,
  currentPassword,
  newPassword,
  log,
}: ChangePasswordDto): Promise<void> {
  // spaces at the edges of a password are dropped, the same at registration, login and reset
  const cleanNewPassword = newPassword?.trim();
  if (!cleanNewPassword) throw new BadRequestError('NEW_PASSWORD_REQUIRED');
  if (cleanNewPassword.length < 6) throw new BadRequestError('PASSWORD_TOO_SHORT');

  const passwordHash = await hashPass(cleanNewPassword);
  const now = new Date();

  let mail: { to: string; userName?: string };
  try {
    mail = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId, role });

      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          name: true,
          passwordHash: true,
          authProvider: true,
          deletedAt: true,
        },
      });
      if (!user || user.deletedAt) throw new NotFoundError('USER_NOT_FOUND');
      if (user.authProvider !== 'LOCAL' || !user.passwordHash) {
        throw new ConflictError('PASSWORD_NOT_SET');
      }

      // a password kept with its edge spaces by the registration of old is checked as typed too,
      // the same as the login does
      const cleanCurrent = currentPassword?.trim() ?? '';
      const ok =
        (cleanCurrent !== '' && (await verifyPass(cleanCurrent, user.passwordHash))) ||
        (cleanCurrent !== currentPassword &&
          (await verifyPass(currentPassword, user.passwordHash)));
      if (!ok) throw new ForbiddenError('PASSWORD_INVALID');

      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, updatedAt: now },
        select: { id: true },
      });

      await revokeAllActiveRefreshTokens(tx, {
        userId,
        at: now,
        keepSessionId: await currentSessionIdOf(tx, userId, refreshToken),
      });

      await tx.userToken.updateMany({
        where: { userId, type: 'RESET_PASSWORD', usedAt: null },
        data: { usedAt: now },
      });

      return { to: user.email, ...(user.name ? { userName: user.name } : {}) };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PASSWORD_CHANGE_UNEXPECTED' }, err);
  }

  // the password is changed either way: a mail that did not go is only logged, without the address
  try {
    await sendPasswordChangedEmail({ ...mail, changedAt: now });
  } catch (err) {
    log.warn({ err, userId }, 'password changed mail was not sent');
  }
}
