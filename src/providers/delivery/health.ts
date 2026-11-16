import { getRedis, isRedisReady } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';

// The health of the delivery provider for the alert delivery_provider_down (decision 13 of the
// delivery): the time of its first failure to answer after its last answer, one key in redis (the
// server and its workers share it). Every call to the provider tells it (index.ts): a failure to
// answer writes the time unless one is there, any answer (a refusal of a carrier is one) takes it
// away. A failure nothing came after for an hour says nothing any more (the mark of the last
// failure lives an hour): nobody asked the provider since, so nobody knows it is still down. Redis
// that cannot be asked changes nothing: the calls go on, the alert says nothing.

const DOWN_TTL_SECONDS = 30 * 24 * 3600;
const QUIET_SECONDS = 3600;

// the provider did not answer: the time of the first failure stays
export async function markDeliveryProviderDown(at: Date): Promise<void> {
  if (!isRedisReady()) return;
  try {
    const redis = await getRedis();
    await redis.set(redisKeys.deliveryProviderDownSince, at.toISOString(), {
      NX: true,
      EX: DOWN_TTL_SECONDS,
    });
    await redis.set(redisKeys.deliveryProviderDownLast, at.toISOString(), { EX: QUIET_SECONDS });
  } catch {
    // the alert waits for redis, the call it came from goes on
  }
}

// the provider answered
export async function markDeliveryProviderUp(): Promise<void> {
  if (!isRedisReady()) return;
  try {
    const redis = await getRedis();
    await redis.del([redisKeys.deliveryProviderDownSince, redisKeys.deliveryProviderDownLast]);
  } catch {
    // the alert waits for redis, the call it came from goes on
  }
}

// since when the provider does not answer; null while it answers, or when redis cannot say. Never
// throws.
export async function readDeliveryProviderDown(): Promise<Date | null> {
  if (!isRedisReady()) return null;
  try {
    const redis = await getRedis();
    const raw = await redis.get(redisKeys.deliveryProviderDownSince);
    if (!raw) return null;
    // no call for an hour after the last failure: the first one of the next failure starts anew
    if (!(await redis.get(redisKeys.deliveryProviderDownLast))) {
      await redis.del(redisKeys.deliveryProviderDownSince);
      return null;
    }
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at;
  } catch {
    return null;
  }
}
