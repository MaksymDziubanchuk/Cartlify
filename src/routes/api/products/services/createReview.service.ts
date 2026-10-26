import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  isAppError,
  InternalError,
} from '@utils/errors.js';

import {
  buyersOf,
  checkReviewComment,
  normalizeCreateReviewInput,
  mapReviewRowToResponse,
  readCategoryPath,
  reviewAuthorSelect,
} from './helpers/index.js';

import type { CreateReviewDto, CreateReviewResultDto } from 'types/dto/products.dto.js';

export async function createReview(dto: CreateReviewDto): Promise<CreateReviewResultDto> {
  const { productId, userId, rating, comment, actorRole } = normalizeCreateReviewInput(dto);

  try {
    // a comment is checked before anything is written, outside the transaction: the checks take a
    // second or two. Every request with a comment is checked, also one the transaction refuses
    // later (the review has a comment already), so no comment is ever written unchecked
    if (comment) {
      const subject = await prisma.$transaction(async (tx) => {
        await setUserContext(tx, { userId, role: actorRole });

        const product = await tx.product.findFirst({
          where: { id: productId, deletedAt: null },
          select: { name: true, categoryId: true, category: { select: { name: true } } },
        });
        if (!product) return null;

        const path = await readCategoryPath(product.categoryId, tx);
        return {
          productName: product.name,
          categoryPath: [...path.map((category) => category.name), product.category.name],
        };
      });
      if (!subject) throw new NotFoundError('PRODUCT_NOT_FOUND');

      // the reasons go to the person, the text is fixed and sent again; the rating of the same
      // request is not written either
      const reasons = await checkReviewComment({ comment, ...subject }, dto.log);
      if (reasons.length > 0) {
        dto.log.info({ productId, userId, reasons }, 'review comment rejected');
        throw new BadRequestError('REVIEW_COMMENT_REJECTED', { reasons });
      }
    }

    const { row, created, author, bought } = await prisma.$transaction(async (tx) => {
      // set db session context for rls policies
      await setUserContext(tx, { userId, role: actorRole });

      // ensure product is in the catalog for 404: the database refuses a review of a removed one
      const product = await tx.product.findFirst({
        where: { id: productId, deletedAt: null },
        select: { id: true },
      });
      if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');

      // the author bought the product: rls lets them read their own orders
      const bought = async () => (await buyersOf(tx, productId, [userId])).has(userId);

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

      // the votes the review has: a review that gets its missing part may have some already
      const select = {
        id: true,
        productId: true,
        rating: true,
        comment: true,
        userId: true,
        upVotes: true,
        downVotes: true,
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

        return { row, created: true, author, bought: await bought() };
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

      return { row, created: false, author, bought: await bought() };
    });

    return { review: mapReviewRowToResponse(row, author, bought), created };
  } catch (err) {
    // preserve known app errors and map everything else to a generic 500
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_CREATE_REVIEW_UNEXPECTED' }, err);
  }
}
