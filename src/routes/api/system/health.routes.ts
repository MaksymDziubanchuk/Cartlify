import type { FastifyInstance } from 'fastify';

import env from '@config/env.js';

import { systemSchemas } from './system.schemas.js';

export default async function getHealthRouter(app: FastifyInstance) {
  app.get(
    '/',
    {
      schema: systemSchemas.healthSchema,
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