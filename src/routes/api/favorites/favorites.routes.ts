import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';

export default async function favoritesRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER', 'ADMIN', 'ROOT'])],
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
        message: 'favorites not implemented',
      };
    },
  );
  app.post(
    '/:productId/toggle',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER']), validateId('productId')],
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
        message: 'toggle favorites not implemented',
      };
    },
  );
  app.delete(
    '/:productId',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'USER']), validateId('productId')],
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
        message: 'delete favorite not implemented',
      };
    },
  );
}
