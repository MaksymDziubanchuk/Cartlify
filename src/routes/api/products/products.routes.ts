import { FastifyInstance } from 'fastify';
import isAdmin from '@middlewares/isAdmin.js';

export default async function productsRouter(app: FastifyInstance, opt: unknown) {
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
        message: 'products not implemented',
      };
    },
  );
  app.get(
    '/:id',
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
        message: 'product by id not implemented',
      };
    },
  );
  app.post(
    '/',
    {
      preHandler: [isAdmin],
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
  app.patch(
    '/:id',
    {
      preHandler: [isAdmin],
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
    '/:id',
    {
      preHandler: [isAdmin],
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
}
