import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';
import type { Email } from 'types/common.js';

export interface GetUserByIdParamsDto {
  userId: UserId;
}

export interface FindUserByIdDto {
  userId: UserId;
}

export interface FindMeByIdDto {
  userId: UserId;
}

export interface UserResponseDto {
  id: UserId;
  email: Email;
  role: Role;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;

  name?: string;
  avatarUrl?: string;
  locale?: string;
  phone?: string;
}

export interface UpdateMeBodyDto {
  name?: string;
  avatarUrl?: string;
  locale?: string;
  phone?: string;
}

export interface UpdateMeDto extends UpdateMeBodyDto {
  userId: UserId;
}
