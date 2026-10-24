import { describe, expect, it, jest } from '@jest/globals';

// the queue of an admin reads its page and its count in one transaction: a transaction has one
// connection, and the driver of postgres takes one statement on it at a time; a second sent while
// the first runs only waits in its queue (pg@9 refuses it). The database is replaced here, the
// queue itself is checked in tests/integration/api/chat/admin.test.ts
const running = { now: 0, most: 0 };
const statement = async <T>(value: T): Promise<T> => {
  running.now += 1;
  running.most = Math.max(running.most, running.now);
  await new Promise((resolve) => setTimeout(resolve, 5));
  running.now -= 1;
  return value;
};

const tx = {
  chatThread: {
    findMany: jest.fn(() => statement([{ id: 'thread-1' }])),
    count: jest.fn(() => statement(1)),
  },
};

jest.unstable_mockModule('@db/client.js', () => ({
  prisma: { $transaction: (fn: (db: typeof tx) => Promise<unknown>) => fn(tx) },
}));
jest.unstable_mockModule('@db/dbContext.service.js', () => ({
  setActorContext: jest.fn(async () => undefined),
}));

const { getAdminChatThreadsService } =
  await import('@routes/api/chat/services/getAdminChatThreads.service.js');

describe('getAdminChatThreadsService', () => {
  it('reads the page and the count one after the other', async () => {
    const out = await getAdminChatThreadsService({
      actorId: 1,
      actorRole: 'ADMIN',
      page: 1,
      limit: 20,
      queue: 'waiting',
    } as never);

    expect(out).toEqual({ items: [{ id: 'thread-1' }], page: 1, limit: 20, total: 1 });
    expect(running.most).toBe(1);
  });
});
