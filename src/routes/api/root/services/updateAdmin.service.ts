import { getPgMessage, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeNewsletterAuditLog } from '@db/adminAudit.helper.js';

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  isAppError,
} from '@utils/errors.js';

import { adminItemOf, adminItemSelect } from './helpers/adminItem.helper.js';

import type { UpdateAdminDto, UpdateAdminResponseDto } from 'types/dto/root.dto.js';

// Root gives an admin the right to run the newsletters or takes it away. The right is a column no
// statement changes: root's function of the database does (newsletter_set_manager, db/05), which
// says whether the right really changed. Only then a line goes into the admin log, with the event
// of the grant or of the revoke: the same value again is an answer and nothing else. The right
// works at once, also in a session that is open, because every request reads it from the database
export async function updateAdmin(dto: UpdateAdminDto): Promise<UpdateAdminResponseDto> {
  // validate actor (root only)
  const actorId = typeof dto.actorId === 'string' ? Number(dto.actorId) : dto.actorId;

  if (!Number.isInteger(actorId) || actorId <= 0) {
    throw new BadRequestError('ACTOR_ID_INVALID');
  }

  if (dto.actorRole !== 'ROOT') {
    throw new ForbiddenError('FORBIDDEN_ROLE');
  }

  const adminId = typeof dto.adminId === 'string' ? Number(dto.adminId) : dto.adminId;

  if (!Number.isInteger(adminId) || adminId <= 0) {
    throw new BadRequestError('USER_ID_INVALID');
  }

  const allowed = dto.canManageNewsletters;

  try {
    return await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: 'ROOT' });

      // load the target for 404 and for the role guard
      const before = await db.user.findUnique({
        where: { id: adminId },
        select: { id: true, role: true, deletedAt: true },
      });

      if (!before) throw new NotFoundError('USER_NOT_FOUND');

      // only an admin has the right
      if (before.role !== 'ADMIN') throw new ConflictError('USER_NOT_ADMIN');

      // a deleted account is no account to give a right, as to make an admin; the right it had is
      // taken away all the same
      if (before.deletedAt && allowed) throw new NotFoundError('USER_NOT_FOUND');

      // true when the column really changed
      const rows = await db.$queryRaw<{ changed: boolean | null }[]>`
        select cartlify.newsletter_set_manager(${adminId}::int, ${allowed}::boolean) as changed
      `;

      if (rows[0]?.changed === true) {
        await writeNewsletterAuditLog(db, {
          actorId,
          actorRole: dto.actorRole,
          event: allowed ? 'newsletter.manager_granted' : 'newsletter.manager_revoked',
          entityId: adminId,
          changes: [{ field: 'canManageNewsletters', old: !allowed, new: allowed }],
        });
      }

      const after = await db.user.findUnique({
        where: { id: adminId },
        select: adminItemSelect,
      });

      if (!after) throw new InternalError({ reason: 'ROOT_ADMINS_UPDATE_TARGET_LOST' });

      return adminItemOf(after);
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    // root demoted the account between the read and the call
    if (getPgMessage(err)?.includes('NEWSLETTER_TARGET_NOT_ADMIN')) {
      throw new ConflictError('USER_NOT_ADMIN');
    }

    throw new InternalError({ reason: 'ROOT_ADMINS_UPDATE_UNEXPECTED' }, err);
  }
}
