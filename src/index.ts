import { app } from './app.js';
import env from '@config/env.js';
import { connectRedis, closeRedis } from '@redis/client.js';
import { startOrderTimeoutWorker, stopOrderTimeoutWorker } from './workers/orderTimeout.worker.js';

// pick protocol for log url
const protocol = env.NODE_ENV === 'production' ? 'https' : 'http';

// how long startup waits for redis before continuing without it
const REDIS_STARTUP_WAIT_MS = 5000;

// initialize external dependencies and start background workers before app listen
async function bootstrap() {
  // wait for redis only for a limited time, the client keeps reconnecting in the background
  const redisReady = await Promise.race([
    connectRedis(app.log).then(
      () => true,
      () => false,
    ),
    new Promise<boolean>((resolve) => {
      setTimeout(() => resolve(false), REDIS_STARTUP_WAIT_MS);
    }),
  ]);

  if (redisReady) {
    app.log.info('redis connected');
  } else {
    app.log.warn('redis is unavailable, redis-dependent features are disabled until it connects');
  }

  // worker skips redis jobs while redis is down, the db sweep runs either way
  startOrderTimeoutWorker(app.log);
  app.log.info('order timeout worker started');

  // start http server
  await app.listen({ port: env.PORT, host: env.HOST });

  // log server address after successful startup
  app.log.info(`Server is running on: ${protocol}://${env.HOST}:${env.PORT}`);
}

// exit on startup failure
bootstrap().catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});

// handle shutdown signals
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, async () => {
    // close server gracefully
    try {
      app.log.info(`received ${sig}, shutting down...`);

      // stop background jobs first so they do not start new work during shutdown
      stopOrderTimeoutWorker();

      // stop accepting requests and wait for active ones to finish
      await app.close();

      // close redis after the app and workers are already stopped
      await closeRedis();

      // flush logs before exit
      if (typeof (app.log as any).flush === 'function') {
        (app.log as any).flush();
      }

      process.exit(0);
      // exit with failure on error
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  });
});
