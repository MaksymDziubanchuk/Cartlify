import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';

import { assertEmail } from '@helpers/validateEmail.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';

import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  isAppError,
} from '@utils/errors.js';

import type { AuditChange } from '@db/adminAudit.helper.js';

import type { AddAdminDto, AddAdminResponseDto } from 'types/dto/root.dto.js';

export async function addAdmin(args: AddAdminDto): Promise<AddAdminResponseDto> {
  // validate actor (root only)
  const actorId = typeof args.actorId === 'string' ? Number(args.actorId) : args.actorId;

  if (!Number.isInteger(actorId) || actorId <= 0) {
    throw new BadRequestError('ACTOR_ID_INVALID');
  }

  if (args.actorRole !== 'ROOT') {
    throw new ForbiddenError('FORBIDDEN_ROLE');
  }

  // validate target user id
  const userId = typeof args.userId === 'string' ? Number(args.userId) : args.userId;

  if (!Number.isInteger(userId) || userId <= 0) {
    throw new BadRequestError('USER_ID_INVALID');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // set db session context for rls
      await setUserContext(tx, {
        userId: actorId,
        role: args.actorRole,
      });

      // load current role
      const before = await tx.user.findUnique({
        where: { id: userId },
        select: { id: true, role: true },
      });

      if (!before) throw new NotFoundError('USER_NOT_FOUND');

      if (before.role === 'ADMIN') {
        throw new ConflictError('USER_ALREADY_ADMIN');
      }

      if (before.role === 'ROOT') {
        throw new ConflictError('USER_IS_ROOT');
      }

      // promote to admin
      const updated = await tx.user.update({
        where: { id: userId },
        data: { role: 'ADMIN' },
        select: {
          id: true,
          email: true,
          role: true,
          isVerified: true,
          createdAt: true,
          updatedAt: true,
          name: true,
          avatarUrl: true,
          locale: true,
          phone: true,
        },
      });

      // audit role change
      const changes: AuditChange[] = [{ field: 'role', old: before.role, new: updated.role }];

      await writeAdminAuditLog(tx, {
        actorId: actorId as any,
        actorRole: args.actorRole,
        entityType: 'user',
        entityId: updated.id,
        action: 'USER_ROLE_CHANGE',
        changes,
      });

      // validate and map dto
      assertEmail(updated.email);

      return {
        id: updated.id as any,
        email: updated.email,
        role: updated.role as any,
        isVerified: updated.isVerified,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        ...(updated.name ? { name: updated.name } : {}),
        ...(updated.avatarUrl ? { avatarUrls: buildImageUrls(updated.avatarUrl, 'avatar') } : {}),
        ...(updated.locale ? { locale: updated.locale } : {}),
        ...(updated.phone ? { phone: updated.phone } : {}),
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;
    throw new InternalError({ reason: 'ROOT_ADMINS_ADD_UNEXPECTED' }, err);
  }
}
