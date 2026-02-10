import { BadRequestError, ForbiddenError } from '@utils/errors.js';

import { toNumberSafe, toStringSafe } from '@helpers/safeNormalizer.js';

import type { CreateReviewDto, CreateReviewResponseDto } from 'types/dto/products.dto.js';
import type { Role } from 'types/user.js';

export function normalizeCreateReviewInput(dto: CreateReviewDto) {
  // normalize ids
  const productIdRaw = toNumberSafe(dto.productId);
  if (productIdRaw == null || !Number.isInteger(productIdRaw) || productIdRaw <= 0) {
    throw new BadRequestError('PRODUCT_ID_INVALID');
  }

  const userIdRaw = toNumberSafe(dto.userId);
  if (userIdRaw == null || !Number.isInteger(userIdRaw) || userIdRaw <= 0) {
    throw new BadRequestError('USER_ID_INVALID');
  }

  // normalize rating
  const ratingRaw = toNumberSafe(dto.rating);
  if (ratingRaw == null || !Number.isInteger(ratingRaw) || ratingRaw < 1 || ratingRaw > 5) {
    throw new BadRequestError('RATING_INVALID');
  }

  // normalize optional comment
  const commentRaw = dto.comment != null ? toStringSafe(dto.comment) : undefined;
  const commentNorm = typeof commentRaw === 'string' ? commentRaw.trim() : undefined;

  // reject empty payload
  if (ratingRaw == null && !commentNorm) {
    throw new BadRequestError('REVIEW_PAYLOAD_EMPTY');
  }

  // normalize role for rls context
  const actorRole = dto.actorRole ?? 'USER';

  return {
    productId: productIdRaw,
    userId: userIdRaw,
    rating: ratingRaw,
    actorRole,
    ...(commentNorm ? { comment: commentNorm } : {}),
  };
}

export function mapReviewRowToResponse(row: {
  id: number;
  productId: number;
  rating: number;
  comment: string | null;
  userId: number;
  createdAt: Date;
  updatedAt: Date;
}): CreateReviewResponseDto {
  // map db row to api dto
  return {
    id: row.id,
    productId: row.productId as any,
    rating: row.rating,
    userId: row.userId as any,
    ...(row.comment ? { comment: row.comment } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function normalizeDeleteReviewInput(dto: {
  productId: unknown;
  reviewId: unknown;
  actorId: unknown;
  actorRole: Role;
}) {
  // normalize ids for db
  const productId = toNumberSafe(dto.productId);
  if (productId == null || !Number.isInteger(productId) || productId <= 0) {
    throw new BadRequestError('PRODUCT_ID_INVALID');
  }

  const reviewId = toNumberSafe(dto.reviewId);
  if (reviewId == null || !Number.isInteger(reviewId) || reviewId <= 0) {
    throw new BadRequestError('REVIEW_ID_INVALID');
  }

  const actorId = toNumberSafe(dto.actorId);
  if (actorId == null || !Number.isInteger(actorId) || actorId <= 0) {
    throw new ForbiddenError('ACTOR_ID_INVALID');
  }

  // validate actor role for admin-only delete
  if (dto.actorRole !== 'ADMIN' && dto.actorRole !== 'ROOT') {
    throw new ForbiddenError('FORBIDDEN');
  }

  return { productId, reviewId, actorId, actorRole: dto.actorRole };
}
