import { FastifyInstance } from 'fastify';
import env from '@config/env.js';

export default async function getHealthRouter(app: FastifyInstance, opt: unknown) {
  app.get(
    '/',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
              },
              uptime: {
                type: 'number',
              },
              timestamp: {
                type: 'string',
              },
              env: {
                type: 'string',
                enum: ['development', 'production', 'test'],
              },
              pid: {
                type: 'number',
              },
            },
            required: ['status', 'uptime', 'timestamp', 'env', 'pid'],
          },
        },
      },
    },
    async () => {
      const uptime = process.uptime();
      return {
        status: uptime > 0 ? 'ok' : 'error',
        uptime,
        timestamp: new Date().toISOString(),
        env: env.NODE_ENV,
        pid: process.pid,
      };
    },
  );
}
