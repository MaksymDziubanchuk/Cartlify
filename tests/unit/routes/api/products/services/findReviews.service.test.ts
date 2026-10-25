import { describe, expect, it, jest } from '@jest/globals';

// the reviews of a product read their page and their count in one transaction: a transaction has
// one connection, and the driver of postgres takes one statement on it at a time; a second sent
// while the first runs only waits in its queue (pg@9 refuses it). The database is replaced here,
// the list itself is checked in tests/integration/api/products/reviews.test.ts
const running = { now: 0, most: 0 };
const statement = async <T>(value: T): Promise<T> => {
  running.now += 1;
  running.most = Math.max(running.most, running.now);
  await new Promise((resolve) => setTimeout(resolve, 5));
  running.now -= 1;
  return value;
};

const tx = {
  product: { findUnique: jest.fn(async () => ({ id: 3, deletedAt: null })) },
  review: {
    findMany: jest.fn(() => statement([])),
    count: jest.fn(() => statement(0)),
  },
  reviewVote: { findMany: jest.fn(async () => []) },
  user: { findMany: jest.fn(async () => []) },
  $queryRaw: jest.fn(async () => []),
};

jest.unstable_mockModule('@db/client.js', () => ({
  prisma: { $transaction: (fn: (db: typeof tx) => Promise<unknown>) => fn(tx) },
  getPgCode: () => undefined,
  getPgMessage: () => undefined,
}));
jest.unstable_mockModule('@db/dbContext.service.js', () => ({
  setAdminContext: jest.fn(async () => undefined),
  setUserContext: jest.fn(async () => undefined),
  setActorContext: jest.fn(async () => undefined),
  setShopDayContext: jest.fn(async () => undefined),
}));

const { findReviews } = await import('@routes/api/products/services/findReviews.service.js');

describe('findReviews', () => {
  it('reads the page and the count one after the other', async () => {
    const out = await findReviews({
      productId: 3,
      limit: 10,
      actorId: undefined,
      actorRole: 'GUEST',
    } as never);

    expect(out).toEqual({ items: [], limit: 10, total: 0 });
    expect(running.most).toBe(1);
  });
});
