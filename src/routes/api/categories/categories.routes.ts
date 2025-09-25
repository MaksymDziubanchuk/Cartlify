import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';

export default async function categoriesRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
    {
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
        message: 'categories not implemented',
      };
    },
  );
  app.post(
    '/',
    {
      preHandler: [authGuard, requireRole(['ADMIN'])],
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
        message: 'create category not implemented',
      };
    },
  );
  app.patch(
    '/:id',
    {
      preHandler: [authGuard, requireRole(['ADMIN'])],
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
        message: 'update category not implemented',
      };
    },
  );
  app.delete(
    '/:id',
    {
      preHandler: [authGuard, requireRole(['ADMIN'])],
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
        message: 'delete category not implemented',
      };
    },
  );
}
