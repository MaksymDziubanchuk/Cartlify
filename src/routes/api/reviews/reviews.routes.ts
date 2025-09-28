import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';

export default async function reviewsRouter(app: FastifyInstance, opt: unknown) {
  app.post(
    '/:reviewId/vote',
    {
      preHandler: [authGuard, requireRole(['USER']), validateId('reviewId')],
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              message: { type: 'string' },
            },
            required: ['message'],
          },
        },
      },
    },
    async () => {
      return {
        message: 'vote review not implemented',
      };
    },
  );
}
