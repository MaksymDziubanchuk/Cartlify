import type { IdParam, UserId } from 'types/ids.js';
import type { UserResponseDto } from 'types/dto/users.dto.js';
import type { Role } from 'types/user.js';

export interface GetAdminsQueryDto {
  cursor?: string;
  limit?: number;
  search?: string;
}

export interface FindAdminsDto {
  actorId: UserId;
  actorRole: Role;

  limit: number;
  cursor?: string;
  search?: string;
}

// a deleted admin keeps the role, its deletedAt tells it apart
export type AdminItemDto = UserResponseDto & { deletedAt: Date | null };

export interface GetAdminsResponseDto {
  items: AdminItemDto[];
  limit?: number;
  nextCursor?: string | null;
  total?: number;
}

export interface AddAdminBodyDto {
  userId: UserId;
}

export interface AddAdminDto {
  actorId: UserId;
  actorRole: Role;
  userId: UserId;
}

export type AddAdminResponseDto = UserResponseDto;

export interface DeleteAdminParamsDto {
  adminId: IdParam;
}

export interface DeleteAdminDto {
  actorId: UserId;
  actorRole: Role;
  adminId: UserId;
}

export interface DeleteAdminResponseDto {
  message: string;
}
