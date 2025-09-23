import { FastifyInstance } from 'fastify';

export default async function getReadyStatus(app: FastifyInstance, opt: any) {
  app.get(
    '/ready',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok', 'error'] },
              checks: {
                type: 'object',
                properties: {
                  db: { type: 'string' },
                  cache: { type: 'string' },
                },
                required: ['db', 'cache'],
              },
              timestamp: { type: 'string' },
            },
            required: ['status', 'checks', 'timestamp'],
          },
        },
      },
    },
    async () => {
      return {
        status: 'ok',
        checks: { db: 'skipped', cache: 'skipped' },
        timestamp: new Date().toISOString(),
      };
    },
  );
}
