import { prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import { ForbiddenError, InternalError, isAppError, NotFoundError } from '@utils/errors.js';

import { readChatHistoryPage } from './helpers/chatHistory.helper.js';

import type {
  ChatThreadMessagesResponseDto,
  GetChatThreadMessagesDto,
} from 'types/dto/chats.dto.js';

// a page of the history of a chat, the messages before the cursor. A customer reads their own
// chats, the rights of the database show no other one; an admin reads the chats given to the
// admins, open or closed, as in the admin view of a chat
export async function getChatThreadMessagesService({
  actorId,
  actorRole,
  threadId,
  cursor,
}: GetChatThreadMessagesDto): Promise<ChatThreadMessagesResponseDto> {
  try {
    return await prisma.$transaction(async (tx) => {
      await setActorContext(tx, { actorId, role: actorRole });

      const thread = await tx.chatThread.findUnique({
        where: { id: threadId },
        select: { type: true, userId: true, guestId: true },
      });

      const own =
        thread &&
        ((actorRole === 'GUEST' && thread.guestId === String(actorId)) ||
          (actorRole === 'USER' && thread.userId === Number(actorId)));
      const admin = actorRole === 'ADMIN' || actorRole === 'ROOT';

      if (!thread || (!own && !admin)) throw new NotFoundError('CHAT_THREAD_NOT_FOUND');

      // a chat with the bot is the customer's alone
      if (admin && thread.type !== 'admin') throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');

      return readChatHistoryPage(tx, threadId, cursor);
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'CHAT_THREAD_MESSAGES_UNEXPECTED' }, err);
  }
}
