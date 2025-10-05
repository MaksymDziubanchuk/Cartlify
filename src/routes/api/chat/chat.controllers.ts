import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import type { GetChatsQueryDto, FindChatsDto } from 'types/dto/chats.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { chatsServices } from './chat.services.js';

export const getChats: ControllerRouter<{}, {}, GetChatsQueryDto, MessageResponseDto> = async (
  req,
  reply,
) => {
  const { id } = req.user as UserEntity;

  const { page: qp, limit: ql, status, type } = req.query;
  const page = qp ? Number(qp) : 1;
  const limit = ql ? Number(ql) : 10;

  const args = pickDefined<FindChatsDto>({ userId: id, page, limit }, { status, type });
  const result = await chatsServices.findChats(args);
  return reply.code(200).send(result);
};
