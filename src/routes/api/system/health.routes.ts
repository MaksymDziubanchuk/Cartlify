import type { FastifyInstance } from 'fastify';

import env from '@config/env.js';
import { isRedisReady } from '@redis/client.js';
import { orderTimeoutWorkerPulse } from '../../../workers/orderTimeout.worker.js';

import { systemSchemas } from './system.schemas.js';

export default async function getHealthRouter(app: FastifyInstance) {
  app.get(
    '/',
    {
      schema: systemSchemas.healthSchema,
    },
    async () => {
      const uptime = process.uptime();

      // informational only, redis state never changes the health status
      const redisReady = isRedisReady();

      return {
        status: uptime > 0 ? 'ok' : 'error',
        uptime,
        timestamp: new Date().toISOString(),
        env: env.NODE_ENV,
        pid: process.pid,
        redis: redisReady ? 'ready' : 'down',
        features: {
          orderConfirmation: redisReady ? 'available' : 'unavailable',
          checkout: redisReady ? 'available' : 'unavailable',
          orderTimeoutQueue: redisReady ? 'running' : 'paused',
        },
        orderTimeoutWorker: await orderTimeoutWorkerPulse(),
      };
    },
  );
}