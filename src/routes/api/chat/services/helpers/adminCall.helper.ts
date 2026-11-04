import { getRedis, isRedisReady } from '@redis/client.js';
import { redisKeys } from '@redis/keys.js';
import { ServiceUnavailableError, isAppError } from '@utils/errors.js';

// The button "call an admin" of a chat with the bot. When the bot cannot answer a customer who may
// talk to an admin (the model gave no answer, the limit of the shop or the limit of the customer is
// used up), the chat gets a mark in redis for ADMIN_CALL_TTL_SECONDS, and the route that gives the
// chat to the admins takes only a chat with the mark. Each failure of the bot sets the mark again,
// so the button comes back every time the bot is down; a turn the model answers takes it away. The
// reads that only show the button go on without redis (no button then); the route needs redis

export const ADMIN_CALL_TTL_SECONDS = 30 * 60;

const keyOf = (threadId: string) => `${redisKeys.chatAdminCallPrefix}${threadId}`;

// sets the mark and tells whether it is set; the answer of the bot never fails for it
export async function offerAdminCall(threadId: string): Promise<boolean> {
  if (!isRedisReady()) return false;

  try {
    const redis = await getRedis();
    await redis.set(keyOf(threadId), '1', { EX: ADMIN_CALL_TTL_SECONDS });
    return true;
  } catch {
    // no mark, no button: the customer can still ask for a person in words
    return false;
  }
}

// takes the mark away, and tells whether there was one
export async function withdrawAdminCall(threadId: string): Promise<boolean> {
  if (!isRedisReady()) return false;

  try {
    const redis = await getRedis();
    return (await redis.del(keyOf(threadId))) > 0;
  } catch {
    return false;
  }
}

// whether the chat has the mark, for the answers that show the button
export async function isAdminCallOffered(threadId: string): Promise<boolean> {
  if (!isRedisReady()) return false;

  try {
    const redis = await getRedis();
    return (await redis.exists(keyOf(threadId))) > 0;
  } catch {
    return false;
  }
}

// whether the chat has the mark, for the route that gives the chat to the admins: REDIS_UNAVAILABLE
// without redis
export async function readAdminCallOffer(threadId: string): Promise<boolean> {
  try {
    const redis = await getRedis();
    return (await redis.exists(keyOf(threadId))) > 0;
  } catch (err) {
    if (isAppError(err)) throw err;

    throw new ServiceUnavailableError('REDIS_UNAVAILABLE', undefined, err);
  }
}
