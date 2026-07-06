import type { FastifyInstance } from 'fastify';

import { prisma } from '@db/client.js';
import { getRedis } from '@redis/client.js';

import { systemSchemas } from './system.schemas.js';

type ReadinessCheckStatus = 'ok' | 'error';

type ReadinessChecks = {
  db: ReadinessCheckStatus;
  cache: ReadinessCheckStatus;
};

const checkDatabase = async (): Promise<ReadinessCheckStatus> => {
  try {
    await prisma.$queryRaw`select 1`;

    return 'ok';
  } catch {
    return 'error';
  }
};

const checkCache = async (): Promise<ReadinessCheckStatus> => {
  try {
    const redis = await getRedis();
    const result = await redis.ping();

    return result === 'PONG' ? 'ok' : 'error';
  } catch {
    return 'error';
  }
};

export default async function getReadyStatusRouter(app: FastifyInstance) {
  app.get(
    '/',
    {
      schema: systemSchemas.readySchema,
    },
    async (_request, reply) => {
      const [dbStatus, cacheStatus] = await Promise.all([checkDatabase(), checkCache()]);

      const checks: ReadinessChecks = {
        db: dbStatus,
        cache: cacheStatus,
      };

      const isReady = checks.db === 'ok' && checks.cache === 'ok';

      const payload = {
        status: isReady ? 'ok' : 'error',
        checks,
        timestamp: new Date().toISOString(),
      };

      if (!isReady) {
        return reply.code(503).send(payload);
      }

      return payload;
    },
  );
}