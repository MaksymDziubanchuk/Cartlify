import { ReviewVoteAction as ReviewVoteActionDb } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import { AppError, NotFoundError, isAppError } from '@utils/errors.js';
import type { VoteReviewDto, VoteReviewResponseDto } from 'types/dto/reviews.dto.js';

async function createVoteReview({
  actorId,
  actorRole,
  reviewId,
  action,
}: VoteReviewDto): Promise<VoteReviewResponseDto> {
  try {
    return await prisma.$transaction(async (tx) => {
      // check user id ('USER' only)
      const userId = Number(actorId);
      if (!Number.isInteger(userId) || userId <= 0) throw new AppError('USER_ID_INVALID', 400);

      // apply rls session context for vote operations
      await setUserContext(tx, { userId, role: actorRole });

      // load review for 404 and response fields
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true, productId: true, updatedAt: true },
      });
      if (!review) throw new NotFoundError('REVIEW_NOT_FOUND');

      // load current user vote if any
      const beforeVote = await tx.reviewVote.findUnique({
        where: { userId_reviewId: { userId, reviewId } },
        select: { id: true, action: true },
      });

      // apply requested vote action
      if (action === 'remove') {
        if (beforeVote) {
          await tx.reviewVote.delete({
            where: { userId_reviewId: { userId, reviewId } },
          });
        }
      } else {
        const desired = action === 'up' ? ReviewVoteActionDb.UP : ReviewVoteActionDb.DOWN;

        if (!beforeVote) {
          await tx.reviewVote.create({
            data: { userId, reviewId, action: desired },
            select: { id: true },
          });
        } else if (beforeVote.action !== desired) {
          await tx.reviewVote.update({
            where: { userId_reviewId: { userId, reviewId } },
            data: { action: desired },
            select: { id: true },
          });
        }
      }

      // compute counts from votes table for stable response
      const grouped = await tx.reviewVote.groupBy({
        by: ['action'],
        where: { reviewId },
        _count: { _all: true },
      });

      let upVotes = 0;
      let downVotes = 0;

      for (const g of grouped) {
        if (g.action === ReviewVoteActionDb.UP) upVotes = g._count._all;
        if (g.action === ReviewVoteActionDb.DOWN) downVotes = g._count._all;
      }

      // resolve current user vote for response
      const afterVote = await tx.reviewVote.findUnique({
        where: { userId_reviewId: { userId, reviewId } },
        select: { action: true },
      });

      const userVote =
        afterVote?.action === ReviewVoteActionDb.UP
          ? 'up'
          : afterVote?.action === ReviewVoteActionDb.DOWN
            ? 'down'
            : null;

      return {
        id: review.id as any,
        productId: review.productId as any,
        upVotes,
        downVotes,
        userVote,
        updatedAt: review.updatedAt,
      };
    });
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new AppError(`reviews.voteReview: unexpected`, 500);
  }
}

export const reviewsServices = {
  createVoteReview,
};
