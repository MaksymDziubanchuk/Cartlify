import { createClient } from 'redis';
import env from '@config/env.js';

type RedisClient = ReturnType<typeof createClient>;

let redis: RedisClient | null = null;
let connecting: Promise<unknown> | null = null;

function buildRedisClient(): RedisClient {
  const client = createClient({
    url: env.REDIS_URL,
  });

  client.on('error', (err: unknown) => {
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
  if (redis?.isOpen) return redis;

  if (!redis) {
    redis = buildRedisClient();
  }

  if (connecting) {
    await connecting;
    return redis!;
  }

  connecting = redis.connect().finally(() => {
    connecting = null;
  });

  await connecting;
  return redis;
}

export async function closeRedis(): Promise<void> {
  if (!redis?.isOpen) return;
  await redis.close();
}
