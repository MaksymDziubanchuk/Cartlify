import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';

export default async function productsRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
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
        message: 'products not implemented',
      };
    },
  );
  app.get(
    '/:productId',
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
        message: 'product by id not implemented',
      };
    },
  );
  app.get(
    '/:productId/reviews',
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
        message: 'product reviews not implemented',
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
        message: 'create product not implemented',
      };
    },
  );
  app.post(
    '/:productId/reviews',
    {
      preHandler: [authGuard, requireRole(['USER'])],
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
        message: 'create review not implemented',
      };
    },
  );
  app.patch(
    '/:productId',
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
        message: 'update product not implemented',
      };
    },
  );
  app.delete(
    '/:productId',
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
        message: 'delete product not implemented',
      };
    },
  );
  app.delete(
    '/:productId/reviews/:reviewId',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
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
        message: 'delete product review not implemented',
      };
    },
  );
}
