import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';
import validateId from '@middlewares/validateId.js';

export default async function categoriesRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
    {
      preHandler: [authGuard, requireRole(['GUEST', 'ADMIN', 'ROOT', 'USER'])],
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
    '/:categoryId',
    {
      preHandler: [authGuard, requireRole(['ADMIN']), validateId('categoryId')],
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
    '/:categoryId',
    {
      preHandler: [authGuard, requireRole(['ADMIN']), validateId('categoryId')],
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
