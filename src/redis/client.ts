import { createClient } from 'redis';
import env from '@config/env.js';
import { ServiceUnavailableError } from '@utils/errors.js';

type RedisClient = ReturnType<typeof createClient>;

type RedisLogger = {
  error: (obj: unknown, msg?: string) => void;
};

// keep one shared redis client per node process
let redis: RedisClient | null = null;

// keep the current in-flight connect promise to avoid parallel connects
let connecting: Promise<unknown> | null = null;

function buildRedisClient(log: RedisLogger): RedisClient {
  const client = createClient({
    url: env.REDIS_URL,

    // reject commands while disconnected instead of queueing them until reconnect
    disableOfflineQueue: true,
  });

  // report redis client errors through the app logger
  client.on('error', (err: unknown) => {
    log.error({ err }, 'redis client error');
  });

  return client;
}

// start connecting once, the client keeps reconnecting in the background on its own
export function connectRedis(log: RedisLogger): Promise<unknown> {
  // await the same connect attempt while it is still in progress
  if (connecting) return connecting;

  // an opened client is either ready or already reconnecting
  if (redis?.isOpen) return Promise.resolve();

  try {
    // lazily create the client only when redis is first needed
    if (!redis) {
      redis = buildRedisClient(log);
    }

    // open redis connection once and clear the connect lock afterwards
    const attempt = redis.connect().finally(() => {
      connecting = null;
    });

    connecting = attempt;

    return attempt;
  } catch (err) {
    return Promise.reject(err);
  }
}

export function isRedisReady(): boolean {
  return redis?.isReady === true;
}

// fail fast so redis-dependent work never starts while redis is down
export function assertRedisReady(): void {
  if (!isRedisReady()) throw new ServiceUnavailableError('REDIS_UNAVAILABLE');
}

export async function getRedis() {
  assertRedisReady();

  return redis!;
}

export async function closeRedis(): Promise<void> {
  // do nothing when redis is already closed or was never initialized
  if (!redis?.isOpen) return;

  // a client that is still reconnecting has nothing to flush
  if (!redis.isReady) {
    redis.destroy();
    return;
  }

  await redis.close();
}
