import type { Prisma } from '@prisma/client';

import { getPgMessage, tx } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';
import { writeAdminAuditLog, writeNewsletterAuditLog } from '@db/adminAudit.helper.js';

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

// Root gives an admin a right or takes it away: the right to run the newsletters, the right to handle
// the money the way root does, one of them or both. Each right is a column no statement changes:
// root's function of the database does (newsletter_set_manager, money_set_manager, db/05), which says
// whether the right really changed. Only then a line goes into the admin log, with the event of the
// grant or of the revoke of that right: the same value again is an answer and nothing else. A right
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

  const newsletters = dto.canManageNewsletters;
  const money = dto.canManageMoney;

  // the schema of the body asks for one right at least
  if (newsletters === undefined && money === undefined) {
    throw new BadRequestError('VALIDATION_ERROR');
  }

  try {
    return await tx(async (db) => {
      await setUserContext(db, { userId: actorId, role: 'ROOT' });

      // load the target for 404 and for the role guard
      const before = await db.user.findUnique({
        where: { id: adminId },
        select: { id: true, role: true, deletedAt: true },
      });

      if (!before) throw new NotFoundError('USER_NOT_FOUND');

      // only an admin has the rights
      if (before.role !== 'ADMIN') throw new ConflictError('USER_NOT_ADMIN');

      // a deleted account is no account to give a right, as to make an admin; a right it had is
      // taken away all the same
      if (before.deletedAt && (newsletters || money)) throw new NotFoundError('USER_NOT_FOUND');

      if (newsletters !== undefined) {
        if (await setRight(db, 'newsletter_set_manager', adminId, newsletters)) {
          await writeNewsletterAuditLog(db, {
            actorId,
            actorRole: dto.actorRole,
            event: newsletters ? 'newsletter.manager_granted' : 'newsletter.manager_revoked',
            entityId: adminId,
            changes: [{ field: 'canManageNewsletters', old: !newsletters, new: newsletters }],
          });
        }
      }

      if (money !== undefined) {
        if (await setRight(db, 'money_set_manager', adminId, money)) {
          await writeAdminAuditLog(db, {
            actorId,
            actorRole: dto.actorRole,
            entityType: 'user',
            entityId: adminId,
            action: 'MONEY_MANAGER_CHANGE',
            event: money ? 'payment.manager_granted' : 'payment.manager_revoked',
            changes: [{ field: 'canManageMoney', old: !money, new: money }],
          });
        }
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
    const message = getPgMessage(err);
    if (
      message?.includes('NEWSLETTER_TARGET_NOT_ADMIN') ||
      message?.includes('MONEY_TARGET_NOT_ADMIN')
    ) {
      throw new ConflictError('USER_NOT_ADMIN');
    }

    throw new InternalError({ reason: 'ROOT_ADMINS_UPDATE_UNEXPECTED' }, err);
  }
}

// a right of the admin as root's function of the database sets it: true when the column really
// changed
async function setRight(
  db: Prisma.TransactionClient,
  fn: 'newsletter_set_manager' | 'money_set_manager',
  adminId: number,
  value: boolean,
): Promise<boolean> {
  const rows =
    fn === 'newsletter_set_manager'
      ? await db.$queryRaw<{ changed: boolean | null }[]>`
          select cartlify.newsletter_set_manager(${adminId}::int, ${value}::boolean) as changed
        `
      : await db.$queryRaw<{ changed: boolean | null }[]>`
          select cartlify.money_set_manager(${adminId}::int, ${value}::boolean) as changed
        `;

  return rows[0]?.changed === true;
}
