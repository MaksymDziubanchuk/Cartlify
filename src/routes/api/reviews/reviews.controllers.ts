import type { ControllerRouter } from 'types/controller.js';
import type { User } from 'types/user.js';
import type {
  VoteReviewParamsDto,
  VoteReviewBodyDto,
  VoteReviewDto,
  VoteReviewResponseDto,
} from 'types/dto/reviews.dto.js';
import pickDefined from '@helpers/parameterNormalize.js';
import { reviewsServices } from './reviews.services.js';

export const postVoteReview: ControllerRouter<
  VoteReviewParamsDto,
  VoteReviewBodyDto,
  {},
  VoteReviewResponseDto
> = async (req, reply) => {
  const { id: actorId, role: actorRole } = req.user as User;
  const { reviewId } = req.params;
  const { action } = req.body;

  const args = pickDefined<VoteReviewDto>({ actorId, actorRole, reviewId, action }, {});
  const result = await reviewsServices.createVoteReview(args);
  return reply.code(200).send(result);
};

export const reviewsController = {
  postVoteReview,
};
