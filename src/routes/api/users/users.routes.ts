import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';

export default async function usersRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/me',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'GUEST', 'ROOT', 'USER'])],
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
        message: 'me not implemented',
      };
    },
  );
  app.get(
    '/:id',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'GUEST', 'ROOT', 'USER'])],
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
        message: 'user by id not implemented',
      };
    },
  );
}
