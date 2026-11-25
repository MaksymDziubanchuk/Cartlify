import type { FastifyBaseLogger } from 'fastify';
import type { Role } from '@prisma/client';

import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { closeAllSessions } from '@routes/api/auth/services/helpers/tokenRotation.helper.js';
import { sendTwoFactorNoticeEmail } from '@routes/api/auth/services/helpers/sendTwoFactorNoticeEmail.helper.js';
import { ConflictError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';
import type { UserId } from 'types/ids.js';

// Root resets the second step of the login of an admin who lost the phone and the recovery codes:
// the secret, the codes and the trusted browsers go, every session of the admin ends, and the next
// login sets the app up again. The admin gets a mail. Root has no one above, a root without the
// codes is reset in the database by hand (docs/two-factor.md).
export async function resetAdminTwoFactor(args: {
  actorId: number;
  actorRole: Role;
  adminId: number;
  log: FastifyBaseLogger;
}): Promise<void> {
  const now = new Date();
  let admin: { email: string; name: string | null; locale: string | null };

  try {
    admin = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: args.actorId, role: args.actorRole });

      const target = await tx.user.findUnique({
        where: { id: args.adminId },
        select: { role: true, email: true, name: true, locale: true, deletedAt: true },
      });
      if (!target || target.deletedAt) throw new NotFoundError('USER_NOT_FOUND');
      if (target.role !== 'ADMIN') throw new ConflictError('USER_NOT_ADMIN');

      const removed = await tx.userTwoFactor.deleteMany({ where: { userId: args.adminId } });
      if (removed.count === 0) throw new NotFoundError('TWO_FACTOR_NOT_FOUND');

      await closeAllSessions(tx, { userId: args.adminId, at: now });

      await writeAdminAuditLog(tx, {
        actorId: args.actorId as UserId,
        actorRole: args.actorRole,
        entityType: 'user',
        entityId: args.adminId,
        action: 'OTHER',
        event: 'two_factor.reset',
        changes: [{ field: 'twoFactor', old: 'enabled', new: null }],
      });

      return { email: target.email, name: target.name, locale: target.locale };
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'ROOT_TWO_FACTOR_RESET_UNEXPECTED' }, err);
  }

  await sendTwoFactorNoticeEmail(
    { kind: 'reset', to: admin.email, at: now, userName: admin.name, locale: admin.locale },
    args.log,
  );
}
