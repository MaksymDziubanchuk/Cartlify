import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { ConflictError, NotFoundError, isAppError, InternalError } from '@utils/errors.js';

import {
  normalizeCreateReviewInput,
  mapReviewRowToResponse,
  reviewAuthorSelect,
} from './helpers/index.js';

import type { CreateReviewDto, CreateReviewResultDto } from 'types/dto/products.dto.js';

export async function createReview(dto: CreateReviewDto): Promise<CreateReviewResultDto> {
  const { productId, userId, rating, comment, actorRole } = normalizeCreateReviewInput(dto);

  try {
    const { row, created, author } = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId, role: actorRole });

      // ensure product is in the catalog for 404: the database refuses a review of a removed one
      const product = await tx.product.findFirst({
        where: { id: productId, deletedAt: null },
        select: { id: true },
      });
      if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');

      // the author is the actor, rls lets them read their own account
      const author = await tx.user.findUnique({
        where: { id: userId },
        select: reviewAuthorSelect,
      });
      if (!author) throw new InternalError({ reason: 'REVIEW_AUTHOR_NOT_FOUND' });

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

      // the helper already made sure there is a rating, a comment or both
      const hasNewComment = typeof comment === 'string' && comment.length > 0;
      const hasNewRating = rating != null;

      const select = {
        id: true,
        productId: true,
        rating: true,
        comment: true,
        userId: true,
        createdAt: true,
        updatedAt: true,
      } as const;

      // a new review may be only a rating, only a comment or both, as the db allows
      if (!existing) {
        const row = await tx.review.create({
          data: {
            productId,
            userId,
            ...(hasNewRating ? { rating } : {}),
            ...(hasNewComment ? { comment } : {}),
          },
          select,
        });

        return { row, created: true, author };
      }

      // an existing review only gets its missing part, a part that is set never changes
      const existingHasComment = existing.comment != null && existing.comment.trim() !== '';

      if (hasNewRating && existing.rating != null && existing.rating !== rating) {
        throw new ConflictError('REVIEW_RATING_UPDATE_FORBIDDEN');
      }
      if (hasNewComment && existingHasComment && existing.comment !== comment) {
        throw new ConflictError('REVIEW_COMMENT_UPDATE_FORBIDDEN');
      }

      const addRating = hasNewRating && existing.rating == null;
      const addComment = hasNewComment && !existingHasComment;

      // nothing new to add, the request repeats what the review already has
      if (!addRating && !addComment) {
        throw new ConflictError('REVIEW_ALREADY_EXISTS');
      }

      const row = await tx.review.update({
        where: { id: existing.id },
        data: {
          ...(addRating ? { rating } : {}),
          ...(addComment ? { comment } : {}),
        },
        select,
      });

      return { row, created: false, author };
    });

    return { review: mapReviewRowToResponse(row, author), created };
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_CREATE_REVIEW_UNEXPECTED' }, err);
  }
}
