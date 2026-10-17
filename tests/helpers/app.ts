import type { FastifyInstance } from 'fastify';

import { app } from '../../src/app.js';
import { connectRedis, closeRedis } from '@redis/client.js';
import { prisma } from '@db/client.js';

// start the app the way src/index.ts does, without the http listener and the order timeout worker;
// every test file gets its own module registry, so its own app instance
export async function startApp(): Promise<FastifyInstance> {
  // request logs are noise in test output, TEST_LOG_LEVEL=info brings them back
  app.log.level = process.env.TEST_LOG_LEVEL ?? 'warn';

  await connectRedis(app.log);
  await app.ready();

  return app;
}

// close everything startApp opened, so jest exits without open handles
export async function stopApp(): Promise<void> {
  await app.close();
  await closeRedis();
  await prisma.$disconnect();
}

// a test that causes a server failure on purpose keeps the expected error line out of the output;
// every request takes its logger from app.log when it starts, so the level holds for the requests inside
export async function withoutErrorLog<T>(fn: () => Promise<T>): Promise<T> {
  const level = app.log.level;
  app.log.level = 'fatal';

  try {
    return await fn();
  } finally {
    app.log.level = level;
  }
}
