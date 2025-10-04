import type { UserId, ReviewId, ProductId } from 'types/ids.js';

export interface VoteReviewParamsDto {
  reviewId: ReviewId;
}
export type ReviewVoteAction = 'up' | 'down' | 'remove';
export interface VoteReviewBodyDto {
  action: ReviewVoteAction;
}

export interface VoteReviewDto {
  actorId: UserId;
  reviewId: ReviewId;
  action: ReviewVoteAction;
}

export interface VoteReviewResponseDto {
  id: ReviewId;
  productId: ProductId;
  upVotes: number;
  downVotes: number;
  userVote: 'up' | 'down' | null;
  updatedAt: Date;
}
