import { ReviewVoteAction as ReviewVoteActionDb } from '@prisma/client';
import { prisma } from '@db/client.js';
import { setUserContext } from '@db/dbContext.service.js';

import {
  BadRequestError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  isAppError,
} from '@utils/errors.js';
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
      if (!Number.isInteger(userId) || userId <= 0) throw new BadRequestError('USER_ID_INVALID');

      // apply rls session context for vote operations
      await setUserContext(tx, { userId, role: actorRole });

      // load review for 404 and response fields
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true, productId: true, userId: true, updatedAt: true },
      });
      if (!review) throw new NotFoundError('REVIEW_NOT_FOUND');

      // votes are for the reviews of others; taking a vote back stays possible
      if (review.userId === userId && action !== 'remove') {
        throw new ForbiddenError('REVIEW_OWN_VOTE_FORBIDDEN');
      }

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

      // the counts the database keeps in the review after this vote: a voter sees only an own
      // vote, the other votes are not readable to count them here
      const { upVotes, downVotes } = await tx.review.findUniqueOrThrow({
        where: { id: reviewId },
        select: { upVotes: true, downVotes: true },
      });

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

    throw new InternalError({ reason: 'REVIEWS_VOTE_REVIEW_UNEXPECTED' }, err);
  }
}

export const reviewsServices = {
  createVoteReview,
};
