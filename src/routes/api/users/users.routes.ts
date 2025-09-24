import { FastifyInstance } from 'fastify';

export default async function usersRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/me',
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
        message: 'me not implemented',
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
        message: 'user by id not implemented',
      };
    },
  );
}
