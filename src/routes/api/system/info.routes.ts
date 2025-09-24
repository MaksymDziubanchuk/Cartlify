import { FastifyInstance } from 'fastify';
import settings from '../../../../package.json' with { type: 'json' };
import env from '@config/env.js';

export default async function getProjectInfoRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              version: { type: 'string' },
              env: { type: 'string', enum: ['development', 'production', 'test'] },
            },
            required: ['name', 'version', 'env'],
          },
        },
      },
    },
    async () => {
      return {
        name: settings.name,
        version: settings.version,
        env: env.NODE_ENV,
      };
    },
  );
}
