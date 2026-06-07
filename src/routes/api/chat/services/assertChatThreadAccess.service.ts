import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import {
  BadRequestError,
  ForbiddenError,
  InternalError,
  isAppError,
  NotFoundError,
  ConflictError
} from '@utils/errors.js';

import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

interface AssertChatThreadAccessDto {
  actorId: UserId;
  actorRole: Role;
  threadId: string;
}

function toUserId(actorId: string | number): number {
  const id = typeof actorId === 'number' ? actorId : Number(actorId);

  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestError('USER_ID_INVALID');
  }

  return id;
}

export async function assertChatThreadAccessService({
  actorId,
  actorRole,
  threadId,
}: AssertChatThreadAccessDto) {
  try {
    return await prisma.$transaction(async (tx) => {
      // set rls session context
      await setActorContext(tx, {
        actorId,
        role: actorRole,
      });

      // find target thread
      const thread = await tx.chatThread.findUnique({
        where: {
          id: threadId,
        },
      });

      if (!thread) {
        throw new NotFoundError('CHAT_THREAD_NOT_FOUND');
      }

      if (thread.status === 'closed') {
        throw new ConflictError('CHAT_THREAD_CLOSED');
      }

      // block guest from admin chat
      if (actorRole === 'GUEST' && thread.type === 'admin') {
        throw new ForbiddenError('CHAT_GUEST_ADMIN_FORBIDDEN');
      }

      // allow admin access only to escalated threads
      if (actorRole === 'ADMIN' || actorRole === 'ROOT') {
        if (thread.type !== 'admin') {
          throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
        }

        return thread;
      }

      // check guest ownership
      if (actorRole === 'GUEST') {
        if (thread.guestId !== String(actorId)) {
          throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
        }

        return thread;
      }

      // check user ownership
      if (actorRole === 'USER') {
        if (thread.userId !== toUserId(actorId)) {
          throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
        }

        return thread;
      }

      throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'CHAT_THREAD_ACCESS_UNEXPECTED' }, err);
  }
}