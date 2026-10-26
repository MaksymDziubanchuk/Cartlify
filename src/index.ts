import { app } from './app.js';
import env from '@config/env.js';
import { connectRedis, closeRedis } from '@redis/client.js';
import { startOrderTimeoutWorker, stopOrderTimeoutWorker } from './workers/orderTimeout.worker.js';
import { ensureAvatarBase } from '@utils/avatar.util.js';
import { startupWarnings } from '@config/startupWarnings.js';
import { createShutdown } from '@helpers/shutdown.js';

// pick protocol for log url
const protocol = env.NODE_ENV === 'production' ? 'https' : 'http';

// how long startup waits for redis before continuing without it
const REDIS_STARTUP_WAIT_MS = 5000;

// how long the shutdown may take before the process exits anyway
const SHUTDOWN_DEADLINE_MS = 10_000;

// initialize external dependencies and start background workers before app listen
async function bootstrap() {
  // settings that switch a feature off; production does not start without some of them
  for (const warning of startupWarnings(env)) app.log.warn(warning);

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

  // the plain picture the drawn avatars go on; the start does not wait for cloudinary, a failure
  // goes to the log and the next start tries again
  void ensureAvatarBase(app.log);

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
const shutdown = createShutdown({
  steps: [
    // stop background jobs first so they do not start new work during shutdown
    () => stopOrderTimeoutWorker(),
    // stop accepting requests and wait for active ones to finish
    async () => {
      await app.close();
    },
    // close redis after the app and workers are already stopped
    () => closeRedis(),
    // flush logs before exit
    () => {
      if (typeof (app.log as any).flush === 'function') (app.log as any).flush();
    },
  ],
  deadlineMs: SHUTDOWN_DEADLINE_MS,
  log: app.log,
  exit: (code) => process.exit(code),
});

['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => void shutdown(sig));
});
