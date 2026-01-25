import type { UserId } from 'types/ids.js';
import type { UserResponseDto } from 'types/dto/users.dto.js';
import type { Role } from 'types/user.js';

export interface GetAdminsQueryDto {
  page?: number;
  limit?: number;
  search?: string;
}

export interface FindAdminsDto {
  page: number;
  limit: number;
  search?: string;
}

export type AdminItemDto = UserResponseDto;

export interface GetAdminsResponseDto {
  items: AdminItemDto[];
  page?: number;
  limit?: number;
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

export type AddAdminResponseDto = AdminItemDto;

export interface DeleteAdminParamsDto {
  adminId: UserId;
}

export interface DeleteAdminDto {
  actorId: UserId;
  actorRole: Role;
  adminId: UserId;
}

export interface DeleteAdminResponseDto {
  message: string;
}
