import { FastifyInstance } from 'fastify';

export default async function getHealthRoute(app: FastifyInstance, opt: any) {
  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
              },
            },
          },
        },
      },
    },
    async () => {
      return {
        status: 'ok',
      };
    },
  );
}
