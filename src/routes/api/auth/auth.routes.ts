import { FastifyInstance } from 'fastify';

export default async function authRouter(app: FastifyInstance, opt: unknown) {
  app.post(
    '/login',
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
        message: 'login not implemented',
      };
    },
  );
  app.post(
    '/register',
    {
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
        message: 'register not implemented',
      };
    },
  );
  app.post(
    '/logout',
    {
      schema: {
        response: {
          204: {
            type: 'null',
          },
        },
      },
    },
    async (request, reply) => {
      return reply.code(204).send();
    },
  );
  app.post(
    '/refresh',
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
        message: 'refresh not implemented',
      };
    },
  );
}
