import env from '@config/env.js';
import { getPgMessage, prisma } from '@db/client.js';
import { writeAdminAuditLog } from '@db/adminAudit.helper.js';
import { setUserContext } from '@db/dbContext.service.js';
import { ForbiddenError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import type { RemoveUserAvatarDto, RemoveUserAvatarResponseDto } from 'types/dto/users.dto.js';

import {
  avatarRemovalChange,
  countAvatarRemovals,
  deleteAvatarFile,
  sendAvatarRemovedEmail,
} from './helpers/avatarRemovals.helper.js';

// a moderator takes the avatar of another account away. cartlify.remove_user_avatar decides who
// may (an admin takes it from a user, root from any account) and changes only the avatar of the
// row. A removal goes to the journal of the admins and counts there; after the commit the file goes
// and the person gets a mail with the count. The answer tells the admin how many removals the
// account has against the limit: past it the page asks to take the account to root
export async function removeUserAvatar({
  actorId,
  actorRole,
  userId,
  log,
}: RemoveUserAvatarDto): Promise<RemoveUserAvatarResponseDto> {
  const id = Number(userId);
  const limit = env.AVATAR_REMOVALS_LIMIT;

  let outcome: {
    removed: boolean;
    avatarRemovals: number;
    publicId: string | null;
    mailTo: string | null;
    userName: string | null;
  };

  try {
    outcome = await prisma.$transaction(async (tx) => {
      await setUserContext(tx, { userId: actorId, role: actorRole });

      // what the account had: the function gives the id of the file only, an old address of a
      // provider has none
      const target = await tx.user.findUnique({
        where: { id },
        select: { email: true, name: true, avatarUrl: true, publicId: true, deletedAt: true },
      });
      if (!target) throw new NotFoundError('USER_NOT_FOUND');

      await tx.$queryRaw`select cartlify.remove_user_avatar(${id}::int) as "publicId"`;

      const removed = target.avatarUrl !== null || target.publicId !== null;
      if (removed) {
        await writeAdminAuditLog(tx, {
          actorId,
          actorRole,
          entityType: 'user',
          entityId: id,
          action: 'OTHER',
          changes: [avatarRemovalChange(target.publicId ?? target.avatarUrl)],
        });
      }

      return {
        removed,
        avatarRemovals: await countAvatarRemovals(tx, id),
        publicId: target.publicId,
        // a deleted account has no avatar and no address to write to
        mailTo: target.deletedAt ? null : target.email,
        userName: target.name,
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    const code = getPgMessage(err);
    if (code === 'USER_AVATAR_REMOVE_FORBIDDEN') throw new ForbiddenError(code);
    if (code === 'USER_NOT_FOUND') throw new NotFoundError(code);

    throw new InternalError({ reason: 'USER_AVATAR_REMOVE_UNEXPECTED' }, err);
  }

  if (outcome.removed) {
    await deleteAvatarFile(outcome.publicId, log);

    if (outcome.mailTo) {
      await sendAvatarRemovedEmail(
        {
          userId: id,
          to: outcome.mailTo,
          userName: outcome.userName,
          removals: outcome.avatarRemovals,
          limit,
        },
        log,
      );
    }
  }

  return {
    removed: outcome.removed,
    avatarRemovals: outcome.avatarRemovals,
    avatarRemovalsLimit: limit,
  };
}
