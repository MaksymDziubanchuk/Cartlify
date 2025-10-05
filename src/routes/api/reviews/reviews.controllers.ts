import type { ControllerRouter } from 'types/controller.js';
import type { MessageResponseDto } from 'types/common.js';
import type { UserEntity } from 'types/user.js';
import type {
  VoteReviewParamsDto,
  VoteReviewBodyDto,
  VoteReviewDto,
} from 'types/dto/reviews.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { reviewsServices } from './reviews.services.js';

export const postVoteReview: ControllerRouter<
  VoteReviewParamsDto,
  VoteReviewBodyDto,
  {},
  MessageResponseDto
> = async (req, reply) => {
  const { id } = req.user as UserEntity;
  const { reviewId } = req.params;
  const { action } = req.body;

  const args = pickDefined<VoteReviewDto>({ actorId: id, reviewId, action }, {});
  const result = await reviewsServices.voteReview(args);
  return reply.code(200).send(result);
};

export const reviewsController = {
  postVoteReview,
};
