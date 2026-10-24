import type { Prisma } from '@prisma/client';

import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';

import type { ChatMessageItemDto } from 'types/dto/chats.dto.js';

// the messages of a chat one page gives: a chat with the bot is never closed, the whole history
// came with every page load
export const CHAT_HISTORY_PAGE = 50;

export interface ChatHistoryPageDto {
  messages: ChatMessageItemDto[];
  // leads to the messages before the page, null at the start of the chat
  nextCursor: string | null;
}

// the newest messages of the chat, before the cursor when there is one, oldest first; in the order
// they were written, the id
export async function readChatHistoryPage(
  db: Prisma.TransactionClient,
  threadId: string,
  cursor?: string,
): Promise<ChatHistoryPageDto> {
  const before = cursor === undefined ? null : decodeCursor(cursor).id;

  const rows = await db.chatMessage.findMany({
    where: { threadId, ...(before === null ? {} : { id: { lt: before } }) },
    orderBy: { id: 'desc' },
    take: CHAT_HISTORY_PAGE + 1,
  });

  const messages = rows.slice(0, CHAT_HISTORY_PAGE).reverse();

  return {
    messages,
    nextCursor:
      rows.length > CHAT_HISTORY_PAGE ? encodeCursor({ id: messages[0]!.id, v: null }) : null,
  };
}
