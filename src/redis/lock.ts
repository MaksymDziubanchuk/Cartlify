import { randomBytes } from 'node:crypto';

import { getRedis } from '@redis/client.js';

// A lock that one process holds across all the processes that share the redis: a key set only when
// it is not there (NX) with a time to live, so a process that dies never holds it for ever. Its value
// is a token only the holder knows, so releasing it never frees a lock another process took after
// this one's time ran out.
export type RedisLock = {
  // frees the lock if it is still ours; true when it was freed, false when it had run out already
  // (or redis could not be asked: the key then goes by its time to live)
  release: () => Promise<boolean>;
};

const RELEASE_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

// Takes the lock for at most ttlMs; null when somebody holds it. Throws 503 REDIS_UNAVAILABLE while
// redis is down (getRedis): a job that needs the lock to be safe does not run without it.
export async function takeRedisLock(key: string, ttlMs: number): Promise<RedisLock | null> {
  const redis = await getRedis();
  const token = randomBytes(16).toString('hex');

  const taken = await redis.set(key, token, { NX: true, PX: ttlMs });
  if (taken !== 'OK') return null;

  return {
    release: async () => {
      try {
        return Number(await redis.sendCommand(['EVAL', RELEASE_LUA, '1', key, token])) === 1;
      } catch {
        return false;
      }
    },
  };
}
