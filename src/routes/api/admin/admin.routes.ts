import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';

export default async function adminRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/stats',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
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
        message: 'admin stats not implemented',
      };
    },
  );
  app.post(
    '/products/:productId/popularity',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
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
        message: 'set product popularity not implemented',
      };
    },
  );
  app.get(
    '/chats',
    {
      preHandler: [authGuard, requireRole(['ADMIN', 'ROOT'])],
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
        message: 'admin chats not implemented',
      };
    },
  );
}
