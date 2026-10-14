import type { UserId, ReviewId, ProductId, IdParam } from 'types/ids.js';
import type { Role } from 'types/user.js';

export interface VoteReviewParamsDto {
  reviewId: IdParam;
}
export type ReviewVoteAction = 'up' | 'down' | 'remove';
export interface VoteReviewBodyDto {
  action: ReviewVoteAction;
}

export interface VoteReviewDto {
  actorId: UserId;
  actorRole: Role;
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
