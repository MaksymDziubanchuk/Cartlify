import { BadRequestError, ForbiddenError } from '@utils/errors.js';

import { toNumberSafe, toStringSafe } from '@helpers/safeNormalizer.js';
import { buildImageUrls } from '@utils/cloudinary.util.js';
import { normalizeFindProductByIdInput } from './index.js';

import type {
  CreateReviewDto,
  ReviewAuthorDto,
  ReviewResponseDto,
} from 'types/dto/products.dto.js';
import type { Role } from 'types/user.js';

export function normalizeCreateReviewInput(dto: CreateReviewDto) {
  // normalize ids
  const { productId: productIdRaw } = normalizeFindProductByIdInput({ productId: dto.productId });

  const userIdRaw = toNumberSafe(dto.userId);
  if (userIdRaw == null || !Number.isInteger(userIdRaw) || userIdRaw <= 0) {
    throw new BadRequestError('USER_ID_INVALID');
  }

  // normalize optional rating, a review may be only a comment
  let ratingNorm: number | undefined;
  if (dto.rating != null) {
    const ratingRaw = toNumberSafe(dto.rating);
    if (ratingRaw == null || !Number.isInteger(ratingRaw) || ratingRaw < 1 || ratingRaw > 5) {
      throw new BadRequestError('RATING_INVALID');
    }
    ratingNorm = ratingRaw;
  }

  // normalize optional comment, a comment of spaces counts as no comment
  const commentRaw = dto.comment != null ? toStringSafe(dto.comment) : undefined;
  const commentNorm = typeof commentRaw === 'string' ? commentRaw.trim() || undefined : undefined;

  // the request schema needs a rating or a comment,
  // so this only catches a comment of spaces sent without a rating
  if (ratingNorm === undefined && !commentNorm) {
    throw new BadRequestError('REVIEW_PAYLOAD_EMPTY');
  }

  // normalize role for rls context
  const actorRole = dto.actorRole ?? 'USER';

  return {
    productId: productIdRaw,
    userId: userIdRaw,
    actorRole,
    ...(ratingNorm !== undefined ? { rating: ratingNorm } : {}),
    ...(commentNorm ? { comment: commentNorm } : {}),
  };
}

export function normalizeDeleteReviewInput(dto: {
  productId: unknown;
  reviewId: unknown;
  actorId: unknown;
  actorRole: Role;
}) {
  // normalize ids for db
  const { productId } = normalizeFindProductByIdInput({ productId: dto.productId });

  const reviewId = toNumberSafe(dto.reviewId);
  if (reviewId == null || !Number.isInteger(reviewId) || reviewId <= 0) {
    throw new BadRequestError('REVIEW_ID_INVALID');
  }

  const actorId = toNumberSafe(dto.actorId);
  if (actorId == null || !Number.isInteger(actorId) || actorId <= 0) {
    throw new ForbiddenError('ACTOR_ID_INVALID');
  }

  // an author deletes own reviews, an admin any review; the service checks the author
  if (dto.actorRole !== 'USER' && dto.actorRole !== 'ADMIN' && dto.actorRole !== 'ROOT') {
    throw new ForbiddenError('INSUFFICIENT_ROLE');
  }

  return { productId, reviewId, actorId, actorRole: dto.actorRole };
}

// what a review reads about its author
export const reviewAuthorSelect = {
  id: true,
  name: true,
  avatarUrl: true,
  deletedAt: true,
} as const;

export type ReviewAuthorRow = {
  id: number;
  name: string | null;
  avatarUrl: string | null;
  deletedAt: Date | null;
};

export function mapReviewAuthor(author: ReviewAuthorRow): ReviewAuthorDto {
  return {
    id: author.id as any,
    ...(author.name ? { name: author.name } : {}),
    ...(author.avatarUrl ? { avatarUrls: buildImageUrls(author.avatarUrl, 'avatar') } : {}),
    deleted: author.deletedAt !== null,
  };
}

export function mapReviewRowToResponse(
  row: {
    id: number;
    productId: number;
    rating: number | null;
    comment: string | null;
    userId: number;
    createdAt: Date;
    updatedAt: Date;

    upVotes?: number;
    downVotes?: number;
    userVote?: 'up' | 'down' | null;
  },
  author: ReviewAuthorRow,
): ReviewResponseDto {
  // map db row to api dto
  return {
    id: row.id as any,
    productId: row.productId as any,
    ...(row.rating != null ? { rating: row.rating } : {}),
    userId: row.userId as any,
    user: mapReviewAuthor(author),
    ...(row.comment ? { comment: row.comment } : {}),
    upVotes: row.upVotes ?? 0,
    downVotes: row.downVotes ?? 0,
    ...(row.userVote !== undefined ? { userVote: row.userVote } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
