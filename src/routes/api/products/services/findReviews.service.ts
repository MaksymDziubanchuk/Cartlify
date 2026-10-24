import { prisma } from '@db/client.js';
import { ReviewVoteAction as ReviewVoteActionDb } from '@prisma/client';
import { encodeCursor, decodeCursor } from '@helpers/codeCursor.js';

import { setAdminContext, setUserContext } from '@db/dbContext.service.js';
import { BadRequestError, InternalError, NotFoundError, isAppError } from '@utils/errors.js';

import { toNumberSafe } from '@helpers/safeNormalizer.js';
import {
  buyersOf,
  mapReviewRowToResponse,
  normalizeFindProductByIdInput,
  readReviewCursor,
  reviewAuthorSelect,
  reviewOrderOf,
  reviewSortValueOf,
  reviewsAfter,
  type ReviewSort,
} from './helpers/index.js';

import type { FindProductReviewsDto, ReviewsResponseDto } from 'types/dto/products.dto.js';

export async function findReviews({
  productId: productIdIn,
  limit: limitIn,
  cursor: cursorIn,
  sort: sortIn,
  actorId: actorIdIn,
  actorRole,
}: FindProductReviewsDto): Promise<ReviewsResponseDto> {
  // normalize and validate ids
  const { productId } = normalizeFindProductByIdInput({ productId: productIdIn });

  const limitRaw = toNumberSafe(limitIn);
  const limit =
    limitRaw != null && Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 10;

  const sort: ReviewSort = sortIn ?? 'newest';

  // the cursor is bound to this product and this sort
  const cursor = typeof cursorIn === 'string' && cursorIn.trim() ? cursorIn.trim() : undefined;
  const c = cursor
    ? readReviewCursor(decodeCursor(cursor) as Record<string, unknown>, productId, sort)
    : undefined;

  // normalize numeric user id only for user vote lookup
  const userId =
    actorRole === 'USER'
      ? (() => {
          const n = Number(actorIdIn);
          if (!Number.isInteger(n) || n <= 0 || Number.isNaN(n)) {
            throw new BadRequestError('USER_ID_INVALID');
          }
          return n;
        })()
      : actorIdIn;

  try {
    return await prisma.$transaction(async (tx) => {
      // set db session context only when we need user vote under rls
      if (actorRole === 'USER') {
        await setUserContext(tx, { userId: userId, role: actorRole });
      }

      // ensure product exists for stable 404; a product taken out of the catalog is no product for
      // a buyer, as its card: an admin still reads its reviews
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true, deletedAt: true },
      });
      const isAdmin = actorRole === 'ADMIN' || actorRole === 'ROOT';
      if (!product || (product.deletedAt && !isAdmin)) throw new NotFoundError('PRODUCT_NOT_FOUND');

      // read page and total, fetch limit + 1 to detect next page. One after the other: the
      // transaction has one connection, and it runs one statement at a time.
      // The cursor is a value: the reviews after the last one of the page in the order of the
      // sort, so a page goes on after that review is deleted
      const rowsPlusOne = await tx.review.findMany({
        where: { productId, ...(c ? { AND: [reviewsAfter(c)] } : {}) },
        orderBy: reviewOrderOf(sort),
        take: limit + 1,
        select: {
          id: true,
          productId: true,
          rating: true,
          comment: true,
          userId: true,
          upVotes: true,
          downVotes: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      const total = await tx.review.count({ where: { productId } });

      const hasNext = rowsPlusOne.length > limit;
      const rows = hasNext ? rowsPlusOne.slice(0, limit) : rowsPlusOne;

      // compute next cursor from last item only when next page exists
      const last = rows[rows.length - 1];
      const nextCursor =
        hasNext && last
          ? encodeCursor({
              id: last.id,
              v: productId,
              s: sort,
              k: reviewSortValueOf(sort, last),
            } as never)
          : undefined;

      // resolve current user votes for returned page only
      let userVoteByReviewId: Map<number, 'up' | 'down'> | null = null;

      if (actorRole === 'USER' && rows.length) {
        const reviewIds = rows.map((r) => r.id);

        const votes = await tx.reviewVote.findMany({
          where: {
            userId: userId as any,
            reviewId: { in: reviewIds },
          },
          select: { reviewId: true, action: true },
        });

        userVoteByReviewId = new Map<number, 'up' | 'down'>();

        for (const v of votes) {
          userVoteByReviewId.set(v.reviewId, v.action === ReviewVoteActionDb.UP ? 'up' : 'down');
        }
      }

      const rowsWithUserVote =
        actorRole === 'USER'
          ? rows.map((r) => ({ ...r, userVote: userVoteByReviewId?.get(r.id) ?? null }))
          : rows;

      // reviews are public, the accounts of their authors are not under rls: the server reads
      // the name, the avatar and the deletion mark of the authors of this page as the system, and
      // the email, whose first letter only leaves the server, on the avatar of an author without a
      // name
      await setAdminContext(tx);

      const authors = await tx.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
        select: reviewAuthorSelect,
      });
      const authorById = new Map(authors.map((author) => [author.id, author]));

      // the authors who bought the product, read as the system too
      const buyers = await buyersOf(
        tx,
        productId,
        rows.map((r) => r.userId),
      );

      // map db rows into api dto; a review always has its author, the account row is never removed
      return {
        items: rowsWithUserVote.map((r) => {
          const author = authorById.get(r.userId);
          if (!author)
            throw new InternalError({ reason: 'REVIEW_AUTHOR_NOT_FOUND', reviewId: r.id });

          return mapReviewRowToResponse(r, author, buyers.has(r.userId));
        }),
        limit,
        total,
        ...(nextCursor ? { nextCursor } : {}),
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new InternalError({ reason: 'PRODUCTS_FIND_REVIEWS_UNEXPECTED' }, err);
  }
}
