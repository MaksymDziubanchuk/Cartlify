import { prisma } from '@db/client.js';
import { ReviewVoteAction as ReviewVoteActionDb } from '@prisma/client';
import { encodeCursor, decodeCursor } from '@helpers/codeCursor.js';

import { setUserContext } from '@db/dbContext.service.js';
import { AppError, BadRequestError, NotFoundError, isAppError } from '@utils/errors.js';

import { toNumberSafe } from '@helpers/safeNormalizer.js';
import { mapReviewRowToResponse, normalizeFindProductByIdInput } from './helpers/index.js';

import type { FindProductReviewsDto, ReviewsResponseDto } from 'types/dto/products.dto.js';

export async function findReviews({
  productId: productIdIn,
  limit: limitIn,
  cursorId: cursorIdIn,
  actorId: actorIdIn,
  actorRole,
}: FindProductReviewsDto): Promise<ReviewsResponseDto> {
  // normalize and validate ids
  const { productId } = normalizeFindProductByIdInput({ productId: productIdIn });

  const limitRaw = toNumberSafe(limitIn);
  const limit =
    limitRaw != null && Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 10;

  const cursor =
    typeof cursorIdIn === 'string' && cursorIdIn.trim() ? cursorIdIn.trim() : undefined;
  const c = cursor ? decodeCursor(cursor) : undefined;

  // bind cursor to this product to prevent cross-product reuse
  if (c) {
    const v = typeof c.v === 'number' ? c.v : Number(c.v);
    if (!Number.isInteger(v) || v !== productId) throw new AppError('CURSOR_INVALID', 400);
  }

  const cursorId = c ? c.id : null;

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

      // ensure product exists for stable 404
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: { id: true },
      });
      if (!product) throw new NotFoundError('PRODUCT_NOT_FOUND');

      // read page and total
      const [rows, total] = await Promise.all([
        tx.review.findMany({
          where: { productId },
          orderBy: { id: 'desc' },
          ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
          take: limit,
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
        }),
        tx.review.count({ where: { productId } }),
      ]);

      // compute next cursor from last item
      const nextCursor = rows.length
        ? encodeCursor({ id: rows[rows.length - 1].id, v: productId })
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

      // map db rows into api dto
      return {
        items: rowsWithUserVote.map(mapReviewRowToResponse),
        limit,
        total,
        ...(nextCursor ? { nextCursorId: nextCursor as any } : {}),
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new AppError(`products.findReviews: unexpected`, 500);
  }
}
