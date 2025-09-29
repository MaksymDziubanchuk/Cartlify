import { FastifyInstance } from 'fastify';
import authGuard from '@middlewares/auth.js';
import requireRole from '@middlewares/requireRole.js';

export default async function authRouter(app: FastifyInstance, opt: unknown) {
  app.post(
    '/login',
    {
      preHandler: [authGuard, requireRole(['GUEST'])],
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
      preHandler: [authGuard, requireRole(['GUEST'])],
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
    '/verify/resend',
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
        message: 'verify resend not implemented',
      };
    },
  );
  app.post(
    '/password/forgot',
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
        message: 'password forgot not implemented',
      };
    },
  );
  app.post(
    '/password/reset',
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
        message: 'password reset not implemented',
      };
    },
  );
  app.post(
    '/logout',
    {
      preHandler: [authGuard, requireRole(['USER', 'ADMIN', 'ROOT'])],
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
        message: 'refresh not implemented',
      };
    },
  );
}
