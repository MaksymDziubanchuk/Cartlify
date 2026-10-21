import type { IdParam, UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';
import type { Email } from 'types/common.js';
import type { ReviewResponseDto } from './products.dto.js';
import type { VoteReviewResponseDto } from './reviews.dto.js';
import type { MultipartFile } from '@fastify/multipart';
import type { UploadImageResult } from '@utils/cloudinary.util.js';
import type { AccountDeletionLogger } from '@routes/api/users/services/helpers/accountDeletedEmail.helper.js';
import type { ProfileList } from '@routes/api/users/services/helpers/adminProfile.helper.js';
import type { AvatarLogger } from '@routes/api/users/services/helpers/avatarRemovals.helper.js';
import type { AuthProvider, OrderStatus } from '@prisma/client';

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

// for an admin or root: the lists the checkboxes ask for and their period; a user's are ignored
export interface GetUserByIdQueryDto {
  include?: string;
  from?: string;
  to?: string;
}

export interface FindUserByIdDto {
  actorId: UserId;
  actorRole: Role;
  userId: UserId;
  include?: string;
  from?: string;
  to?: string;
}

export interface FindMeByIdDto {
  userId: UserId;
}

export type UsersListSortBy = 'createdAt' | 'lastLoginAt';
export type UsersListSortOrder = 'desc' | 'asc';

// the filters, the email search and the order of the admin table of users
export interface GetUsersQueryDto {
  limit?: number;
  cursor?: string;
  email?: string;
  role?: string;
  authProvider?: string;
  isVerified?: boolean;
  deleted?: boolean;
  sortBy?: UsersListSortBy;
  sortOrder?: UsersListSortOrder;
}

export interface FindUsersDto extends GetUsersQueryDto {
  actorId: UserId;
  actorRole: Role;
}

// a row of the admin table: every field is there, null when the account has none
export interface UsersListItemDto {
  id: UserId;
  email: Email;
  name: string | null;
  role: Exclude<Role, 'GUEST'>;
  authProvider: AuthProvider;
  isVerified: boolean;
  locale: string | null;
  avatarUrls: AvatarUrls;
  avatarIsDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastLoginAt: Date | null;
  deletedAt: Date | null;
}

export interface UsersListResponseDto {
  items: UsersListItemDto[];
  limit: number;
  nextCursor: string | null;
  total: number;
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
  // the own picture, or the drawn letter of an account without one
  avatarUrls: AvatarUrls;
  avatarIsDefault: boolean;
  locale?: string;
  phone?: string;
  reviews?: UserReviewResponseDto[];
}

// public profile of any user: no email, role, verification, phone or reviews
export type PublicUserProfileDto = Omit<
  UserResponseDto,
  'email' | 'isVerified' | 'reviews' | 'role' | 'phone' | 'locale'
>;

export interface AdminProfileOrderDto {
  id: number;
  status: OrderStatus;
  total: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminProfileReviewDto {
  id: number;
  productId: number;
  rating: number | null;
  comment: string | null;
  upVotes: number;
  downVotes: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminProfileFavoriteDto {
  id: number;
  productId: number;
  createdAt: Date;
}

export interface AdminProfileVoteDto {
  id: number;
  reviewId: number;
  action: 'up' | 'down';
  createdAt: Date;
}

export interface AdminProfileLoginLogDto {
  id: number;
  createdAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

export type AdminProfileListsDto = {
  orders: AdminProfileOrderDto[];
  reviews: AdminProfileReviewDto[];
  favorites: AdminProfileFavoriteDto[];
  votes: AdminProfileVoteDto[];
  loginLogs: AdminProfileLoginLogDto[];
};

// the profile an admin or root reads: everything but the password, the provider id and the id of
// the avatar file, the open chat of the user with an admin, and the lists asked for of the period
export type AdminUserProfileDto = PublicUserProfileDto &
  Pick<UserResponseDto, 'email' | 'role' | 'isVerified' | 'locale' | 'phone'> & {
    authProvider: AuthProvider;
    // only for a deleted account
    deletedAt?: Date;
    openChatThreadId: string | null;
    // the removals of the avatar by a moderator and the limit the rules set for them
    avatarRemovals: number;
    avatarRemovalsLimit: number;
    period: { from: Date; to: Date };
  } & Partial<Pick<AdminProfileListsDto, ProfileList>>;

export type UserByIdResponseDto = PublicUserProfileDto | AdminUserProfileDto;

export interface UpdateMeBodyDto {
  name?: string;
  locale?: string;
  phone?: string;
  // a file in a form; in json only the empty value, which removes the avatar
  avatar?: MultipartFile | string;
}

export interface UpdateMeDto {
  userId: UserId;
  userRole: Role;

  name?: string;
  locale?: string;
  phone?: string;

  avatarUploaded?: UploadImageResult | null;
  // an empty avatar came: the avatar goes, its file after the commit
  removeAvatar?: boolean;
  log?: AvatarLogger;
}

// a moderator takes the avatar of another account away
export interface RemoveUserAvatarDto {
  actorId: UserId;
  actorRole: Role;
  userId: UserId;
  log: AvatarLogger;
}

export interface RemoveUserAvatarResponseDto {
  // false when the account had no avatar
  removed: boolean;
  // the removals by a moderator the account has, this one counted
  avatarRemovals: number;
  avatarRemovalsLimit: number;
}

export interface DeleteUserByIdDto {
  actorId: UserId;
  userId: UserId;
  // the steps after the database (the payment page, the avatar file, the mail) only log their failures
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
