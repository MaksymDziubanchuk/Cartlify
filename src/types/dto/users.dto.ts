import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';
import type { Email } from 'types/common.js';
import type { ReviewResponseDto } from './products.dto.js';
import type { VoteReviewResponseDto } from './reviews.dto.js';
import type { MultipartFile } from '@fastify/multipart';

export type AvatarUrls = {
  url32: string;
  url64: string;
  url128: string;
  url256: string;
};

export interface GetUserByIdParamsDto {
  userId: UserId;
}

export interface FindUserByIdDto {
  userId: UserId;
}

export interface FindMeByIdDto {
  userId: UserId;
}

export type UserReviewResponseDto = Omit<ReviewResponseDto, 'comment' | 'rating'> & {
  comment: string;
} & Pick<VoteReviewResponseDto, 'upVotes' | 'downVotes' | 'userVote' | 'updatedAt'>;

export interface UserResponseDto {
  id: UserId;
  email: Email;
  role: Role;
  isVerified: boolean;
  createdAt: Date;
  updatedAt: Date;

  name?: string;
  avatarUrls?: AvatarUrls;
  locale?: string;
  phone?: string;
  reviews?: UserReviewResponseDto[];
}

export type UserByIdResponseDto = Omit<
  UserResponseDto,
  'isVerified' | 'reviews' | 'role' | 'phone' | 'locale'
>;

export interface UpdateMeBodyDto {
  name?: string;
  locale?: string;
  phone?: string;
  avatar?: MultipartFile;
}

export interface UpdateMeDto extends UpdateMeBodyDto {
  userId: UserId;
}

export interface DeleteUserByIdDto {
  actorId: UserId;
  userId: UserId;
}
