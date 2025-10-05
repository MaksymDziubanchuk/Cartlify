import type { FindUserByIdDto, FindMeByIdDto, UpdateMeDto } from 'types/dto/users.dto.js';
import type { MessageResponseDto } from 'types/common.js';

async function findMe({ userId }: FindMeByIdDto): Promise<MessageResponseDto> {
  return { message: 'me not implemented' };
}

async function updateMe({
  userId,
  name,
  avatarUrl,
  locale,
  phone,
}: UpdateMeDto): Promise<MessageResponseDto> {
  return { message: 'update me not implemented' };
}

async function findById({ userId }: FindUserByIdDto): Promise<MessageResponseDto> {
  return { message: 'user by id not implemented' };
}

export const usersServices = {
  findMe,
  updateMe,
  findById,
};
