import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import {
  ConflictError,
  NotFoundError,
  isAppError,
  BadRequestError,
  InternalError,
} from '@utils/errors.js';

import { normalizeCreateReviewInput, mapReviewRowToResponse } from './helpers/index.js';

import type { CreateReviewDto, CreateReviewResponseDto } from 'types/dto/products.dto.js';

export async function createReview(dto: CreateReviewDto): Promise<CreateReviewResponseDto> {
  const { productId, userId, rating, comment, actorRole } = normalizeCreateReviewInput(dto);

  try {
    const row = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId, role: actorRole });

      // ensure product exists for 404
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');

      // load existing review for update-or-create logic
      const existing = await tx.review.findUnique({
        where: { userId_productId: { userId, productId } },
        select: {
          id: true,
          rating: true,
          comment: true,
          productId: true,
          userId: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const hasNewComment = typeof comment === 'string' && comment.length > 0;
      const hasNewRating = rating != null;

      // reject empty payload
      if (!hasNewComment && !hasNewRating) {
        throw new BadRequestError('REVIEW_PAYLOAD_EMPTY');
      }

      // 1) no comment in new payload -> reject if review already exists
      if (!hasNewComment && existing) {
        throw new ConflictError('REVIEW_ALREADY_EXISTS');
      }

      // 2) comment provided and existing has no comment -> allow comment update only
      if (
        hasNewComment &&
        existing &&
        (existing.comment == null || existing.comment.trim() === '')
      ) {
        if (hasNewRating) throw new ConflictError('REVIEW_RATING_UPDATE_FORBIDDEN');

        return tx.review.update({
          where: { id: existing.id },
          data: { comment },
          select: {
            id: true,
            productId: true,
            rating: true,
            comment: true,
            userId: true,
            createdAt: true,
            updatedAt: true,
          },
        });
      }

      // 3) any other existing review case -> reject (already has rating; comment may exist)
      if (existing) {
        throw new ConflictError('REVIEW_ALREADY_EXISTS');
      }

      // create new review requires rating
      if (!hasNewRating) throw new BadRequestError('RATING_REQUIRED');

      return tx.review.create({
        data: {
          productId,
          userId,
          rating,
          ...(hasNewComment ? { comment } : {}),
        },
        select: {
          id: true,
          productId: true,
          rating: true,
          comment: true,
          userId: true,
          createdAt: true,
          updatedAt: true,
        },
      });
    });

    return mapReviewRowToResponse(row);
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_CREATE_REVIEW_UNEXPECTED' }, err);
  }
}
