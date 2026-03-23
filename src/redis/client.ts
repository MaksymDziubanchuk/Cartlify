import { createClient } from 'redis';
import env from '@config/env.js';

type RedisClient = ReturnType<typeof createClient>;

// keep one shared redis client per node process
let redis: RedisClient | null = null;

// keep the current in-flight connect promise to avoid parallel connects
let connecting: Promise<unknown> | null = null;

function buildRedisClient(): RedisClient {
  const client = createClient({
    url: env.REDIS_URL,
  });

  client.on('error', (err: unknown) => {
    // normalize redis client errors for local debugging
    if (err instanceof Error) {
      console.error({
        scope: 'redis',
        message: err.message,
        stack: err.stack,
      });
      return;
    }

    console.error({
      scope: 'redis',
      err,
    });
  });

  return client;
}

export async function getRedis() {
  // reuse the already opened redis connection
  if (redis?.isOpen) return redis;

  // lazily create the client only when redis is first needed
  if (!redis) {
    redis = buildRedisClient();
  }

  // await the same connect attempt while it is still in progress
  if (connecting) {
    await connecting;
    return redis!;
  }

  // open redis connection once and clear the connect lock afterwards
  connecting = redis.connect().finally(() => {
    connecting = null;
  });

  await connecting;
  return redis;
}

export async function closeRedis(): Promise<void> {
  // do nothing when redis is already closed or was never initialized
  if (!redis?.isOpen) return;

  await redis.close();
}
