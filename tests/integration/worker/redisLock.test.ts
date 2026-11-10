import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { closeRedis, connectRedis, getRedis } from '@redis/client.js';
import { takeRedisLock } from '@redis/lock.js';

import { prisma } from '@db/client.js';

// The lock the pass of the newsletters holds (src/redis/lock.ts): a key set only when it is not there,
// with a time to live, and released only by the one who set it. Every test has a key of its own

const keys: string[] = [];
const keyOf = () => {
  const key = `test:lock:${randomUUID()}`;
  keys.push(key);
  return key;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  await connectRedis({ error: () => undefined });
});

afterAll(async () => {
  try {
    const redis = await getRedis();
    for (const key of keys) await redis.del(key);
  } finally {
    await closeRedis();
    await prisma.$disconnect();
  }
});

describe('takeRedisLock', () => {
  it('gives the lock to the first who asks and refuses the second', async () => {
    const key = keyOf();

    const first = await takeRedisLock(key, 10_000);
    const second = await takeRedisLock(key, 10_000);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('gives it again once the holder has let it go', async () => {
    const key = keyOf();

    const first = await takeRedisLock(key, 10_000);
    expect(await first!.release()).toBe(true);

    const second = await takeRedisLock(key, 10_000);
    expect(second).not.toBeNull();
    // and a lock that was let go is not let go twice
    expect(await first!.release()).toBe(false);
  });

  it('holds the lock for the time it is given, then it is free', async () => {
    const key = keyOf();
    await takeRedisLock(key, 100);

    expect(await takeRedisLock(key, 10_000)).toBeNull();
    await sleep(250);

    expect(await takeRedisLock(key, 10_000)).not.toBeNull();
  });

  it('never frees a lock another holder took after the first one ran out', async () => {
    const key = keyOf();
    const slow = await takeRedisLock(key, 100);
    await sleep(250);

    const next = await takeRedisLock(key, 10_000);
    expect(next).not.toBeNull();

    // the slow holder wakes up and lets go: the key is not its any more
    expect(await slow!.release()).toBe(false);
    expect(await takeRedisLock(key, 10_000)).toBeNull();
    expect(await next!.release()).toBe(true);
  });

  it('keeps the locks of different keys apart', async () => {
    const one = await takeRedisLock(keyOf(), 10_000);
    const two = await takeRedisLock(keyOf(), 10_000);

    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
  });
});
