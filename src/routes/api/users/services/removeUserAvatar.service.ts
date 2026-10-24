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

      // who gets the mail
      const target = await tx.user.findUnique({
        where: { id },
        select: { email: true, name: true, deletedAt: true },
      });
      if (!target) throw new NotFoundError('USER_NOT_FOUND');

      // the function reads the avatar under the lock of the row and says whether it took one: of
      // two moderators at once only one writes the line, counts and mails. An old address of a
      // provider has no id of a file
      const [taken] = await tx.$queryRaw<
        { removed: boolean; public_id: string | null; avatar_url: string | null }[]
      >`select * from cartlify.remove_user_avatar(${id}::int)`;

      const removed = taken?.removed === true;
      if (removed) {
        await writeAdminAuditLog(tx, {
          actorId,
          actorRole,
          entityType: 'user',
          entityId: id,
          action: 'OTHER',
          changes: [avatarRemovalChange(taken!.public_id ?? taken!.avatar_url)],
        });
      }

      return {
        removed,
        avatarRemovals: await countAvatarRemovals(tx, id),
        publicId: removed ? taken!.public_id : null,
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
