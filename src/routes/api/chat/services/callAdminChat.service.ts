import { isRetryableTxError, prisma } from '@db/client.js';
import { setActorContext } from '@db/dbContext.service.js';
import {
  ConflictError,
  ForbiddenError,
  InternalError,
  isAppError,
  NotFoundError,
  ResourceBusyError,
} from '@utils/errors.js';

import { writeBotTurn } from './bot/chatBot.service.js';
import { readAdminCallOffer, withdrawAdminCall } from './helpers/adminCall.helper.js';

import type { CallAdminChatDto, CallAdminChatResponseDto } from 'types/dto/chats.dto.js';

// what the bot writes when the customer gave the chat to the admins by the button: the same ask as
// the bot makes when it passes a chat on, the description of the issue is what the admins read first
export const ADMIN_CALL_TEXT =
  'I have passed this chat to an admin. Please describe your issue in a message, an admin will answer when they are available.';

// The customer gives the chat with the bot to the admins by the button the bot's failure put on it.
// Only a user with a confirmed email, only the own open chat that is still with the bot, and only
// while the chat has the mark (the bot could not answer lately). The chat goes to the admins the way
// the bot gives it: with a message of the bot, and it enters the queue of the admins with the next
// message of the customer
export async function callAdminChatService({
  actorId,
  actorRole,
  threadId,
}: CallAdminChatDto): Promise<CallAdminChatResponseDto> {
  if (actorRole !== 'USER') throw new ForbiddenError('CHAT_THREAD_FORBIDDEN');

  try {
    await assertCanCallAdmin(Number(actorId), threadId);

    if (!(await readAdminCallOffer(threadId))) {
      throw new ConflictError('CHAT_ADMIN_CALL_UNAVAILABLE');
    }

    // of two calls at once only one finds the chat with the bot: the other one gets nothing
    const written = await writeBotTurn({
      actorId,
      actorRole: 'USER',
      threadId,
      content: ADMIN_CALL_TEXT,
      toAdmin: true,
    });
    if (!written) throw new ConflictError('CHAT_ADMIN_CALL_UNAVAILABLE');

    await withdrawAdminCall(threadId);

    return { thread: written.thread, message: written.botMessage };
  } catch (err) {
    if (isAppError(err)) throw err;

    // the chat was locked by another step for longer than the bot waits: try again
    if (isRetryableTxError(err)) throw new ResourceBusyError();

    throw new InternalError({ reason: 'CHAT_ADMIN_CALL_UNEXPECTED' }, err);
  }
}

// the chat is the customer's own, open and with the bot, and the customer confirmed the email
async function assertCanCallAdmin(userId: number, threadId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await setActorContext(tx, { actorId: userId, role: 'USER' });

    const thread = await tx.chatThread.findUnique({
      where: { id: threadId },
      select: { userId: true, status: true, type: true },
    });
    // another customer's chat is hidden from the user by the row security: it is not found
    if (!thread || thread.userId !== userId) throw new NotFoundError('CHAT_THREAD_NOT_FOUND');
    if (thread.status === 'closed') throw new ConflictError('CHAT_THREAD_CLOSED');
    if (thread.type !== 'bot') throw new ConflictError('CHAT_ADMIN_CALL_UNAVAILABLE');

    const user = await tx.user.findUnique({
      where: { id: userId },
      select: { isVerified: true },
    });
    if (!user?.isVerified) throw new ForbiddenError('CHAT_ADMIN_EMAIL_NOT_CONFIRMED');
  });
}
