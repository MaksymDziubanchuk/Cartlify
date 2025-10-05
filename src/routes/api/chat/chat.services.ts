import type { FindChatsDto } from 'types/dto/chats.dto.js';
import type { MessageResponseDto } from 'types/common.js';

async function findChats({
  userId,
  page,
  limit,
  status,
  type,
}: FindChatsDto): Promise<MessageResponseDto> {
  return { message: 'chat not implemented' };
}

export const chatsServices = {
  findChats,
};
