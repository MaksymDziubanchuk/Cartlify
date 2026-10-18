import type { IdParam, UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';
import type { Email } from 'types/common.js';
import type { ReviewResponseDto } from './products.dto.js';
import type { VoteReviewResponseDto } from './reviews.dto.js';
import type { MultipartFile } from '@fastify/multipart';
import type { UploadImageResult } from '@utils/cloudinary.util.js';
import type { AccountDeletionLogger } from '@routes/api/users/services/helpers/accountDeletedEmail.helper.js';

export type AvatarUrls = {
  url32: string;
  url64: string;
  url128: string;
  url256: string;
};

export type AvatarPart = {
  file: NodeJS.ReadableStream;
  mimetype: string;
  filename?: string;
};

export interface GetUserByIdParamsDto {
  userId: IdParam;
}

export interface FindUserByIdDto {
  actorId: UserId;
  actorRole: Role;
  userId: UserId;
}

export interface FindMeByIdDto {
  userId: UserId;
}

export type UserReviewResponseDto = Omit<ReviewResponseDto, 'comment' | 'rating'> & {
  comment: string;
  rating: number;
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

// public profile of any user: no email, role, verification, phone or reviews
export type UserByIdResponseDto = Omit<
  UserResponseDto,
  'email' | 'isVerified' | 'reviews' | 'role' | 'phone' | 'locale'
>;

export interface UpdateMeBodyDto {
  name?: string;
  locale?: string;
  phone?: string;
  avatar?: MultipartFile;
}

export interface UpdateMeDto {
  userId: UserId;
  userRole: Role;

  name?: string;
  locale?: string;
  phone?: string;

  avatarUploaded?: UploadImageResult | null;
}

export interface DeleteUserByIdDto {
  actorId: UserId;
  userId: UserId;
  // the steps after the database (stripe, the avatar file, the mail) only log their failures
  log: AccountDeletionLogger;
}

export interface DeleteMeBodyDto {
  // a local account confirms the deletion with its password
  password?: string;
  // true goes on although the account has an order waiting for payment, paid or shipped
  confirmOpenOrders?: boolean;
}

export interface DeleteMeDto {
  userId: UserId;
  password?: string;
  confirmOpenOrders?: boolean;
  log: AccountDeletionLogger;
}
