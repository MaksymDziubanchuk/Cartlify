import type { VoteReviewDto } from 'types/dto/reviews.dto.js';
import type { MessageResponseDto } from 'types/common.js';

async function voteReview({
  actorId,
  reviewId,
  action,
}: VoteReviewDto): Promise<MessageResponseDto> {
  return { message: 'vote review not implemented' };
}

export const reviewsServices = {
  voteReview,
};
