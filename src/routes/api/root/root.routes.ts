import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';

export default async function rootRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/admins',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
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
        message: 'get admins not implemented',
      };
    },
  );
  app.post(
    '/admins',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
      schema: {
        response: {
          201: {
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
        message: 'add admin not implemented',
      };
    },
  );
  app.delete(
    '/admins/:adminId',
    {
      preHandler: [authGuard, requireRole(['ROOT'])],
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
        message: 'delete admin not implemented',
      };
    },
  );
}
