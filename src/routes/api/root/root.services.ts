import type { FindAdminsDto, AddAdminDto, DeleteAdminDto } from 'types/dto/root.dto.js';
import type { MessageResponseDto } from 'types/common.js';

async function findAdmins({ page, limit, search }: FindAdminsDto): Promise<MessageResponseDto> {
  return { message: 'get admins not implemented' };
}

async function addAdmin({ actorId, userId }: AddAdminDto): Promise<MessageResponseDto> {
  return { message: 'add admin not implemented' };
}

async function removeAdmin({ actorId, adminId }: DeleteAdminDto): Promise<MessageResponseDto> {
  return { message: 'delete admin not implemented' };
}

export const rootServices = {
  findAdmins,
  addAdmin,
  removeAdmin,
};
