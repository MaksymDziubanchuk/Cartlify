import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';
import { reviewsSchemas } from './reviews.schemas.js';
import { reviewsController } from './reviews.controllers.js';

export default async function reviewsRouter(app: FastifyInstance, opt: unknown) {
  app.post(
    '/:reviewId/vote',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('reviewId')],
      schema: reviewsSchemas.postVoteReviewSchema,
    },
    reviewsController.postVoteReview,
  );
}
