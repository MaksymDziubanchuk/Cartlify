import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import {
  BadRequestError,
  ConflictError,
  InternalError,
  NotFoundError,
  isAppError,
} from '@utils/errors.js';

import type { DeleteAdminDto, DeleteAdminResponseDto } from 'types/dto/root.dto.js';

export async function removeAdmin(dto: DeleteAdminDto): Promise<DeleteAdminResponseDto> {
  // normalize ids
  const adminId = typeof dto.adminId === 'string' ? Number(dto.adminId) : dto.adminId;

  if (!Number.isInteger(adminId) || adminId <= 0) {
    throw new BadRequestError('USER_ID_INVALID');
  }

  try {
    await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, {
        userId: dto.actorId,
        role: dto.actorRole,
      });

      // load target for 404 and role guard
      const before = await tx.user.findUnique({
        where: { id: adminId },
        select: { id: true, role: true },
      });

      if (!before) throw new NotFoundError('USER_NOT_FOUND');

      // demote only admins
      if (before.role === 'USER') {
        throw new ConflictError('USER_NOT_ADMIN');
      }

      // never demote root
      if (before.role === 'ROOT') {
        throw new ConflictError('ROOT_CANNOT_BE_DEMOTED');
      }

      // apply role change
      await tx.user.update({
        where: { id: adminId },
        data: { role: 'USER' },
        select: { id: true, role: true },
      });

      // write admin audit log for role change
      await writeAdminAuditLog(tx, {
        actorId: dto.actorId,
        actorRole: dto.actorRole,
        entityType: 'user',
        entityId: before.id,
        action: 'USER_ROLE_CHANGE',
        changes: [{ field: 'role', old: before.role, new: 'USER' }],
      });
    });

    return { message: 'admin removed' };
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'ROOT_ADMINS_DELETE_UNEXPECTED' }, err);
  }
}
