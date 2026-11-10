import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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

// what the transaction did, in the order it did it: the changes of the context and the reads
const steps: string[] = [];
const step = async <T>(name: string, value: T): Promise<T> => {
  steps.push(name);
  return statement(value);
};

const tx = {
  product: {
    findUnique: jest.fn(async () => ({ id: 3, deletedAt: null, variants: [{ id: 30 }] })),
  },
  review: {
    findMany: jest.fn<(args: unknown) => Promise<unknown[]>>(() =>
      step('page', [{ id: 5, userId: 8, productId: 3, upVotes: 0 }]),
    ),
    count: jest.fn<(args: unknown) => Promise<number>>(() => step('total', 1)),
  },
  reviewVote: { findMany: jest.fn(() => step('votes', [])) },
  // the authors of the page, and the ones of them who bought the product (the condition of the purchase)
  user: {
    findMany: jest.fn((args: { where: { orders?: unknown } }) =>
      args.where.orders
        ? step('buyers', [{ id: 8 }])
        : step('authors', [
            { id: 8, name: 'Anna', email: 'anna@example.com', avatarUrl: null, deletedAt: null },
          ]),
    ),
  },
  $queryRaw: jest.fn(async () => []),
};

jest.unstable_mockModule('@db/client.js', () => ({
  prisma: { $transaction: (fn: (db: typeof tx) => Promise<unknown>) => fn(tx) },
  getPgCode: () => undefined,
  getPgMessage: () => undefined,
}));
jest.unstable_mockModule('@db/dbContext.service.js', () => ({
  setAdminContext: jest.fn(async () => {
    steps.push('admin context');
  }),
  setUserContext: jest.fn(async () => {
    steps.push('user context');
  }),
  setActorContext: jest.fn(async () => undefined),
  setShopDayContext: jest.fn(async () => undefined),
}));

const { findReviews } = await import('@routes/api/products/services/findReviews.service.js');

beforeEach(() => {
  steps.length = 0;
  tx.review.findMany.mockClear();
  tx.review.count.mockClear();
});

describe('findReviews', () => {
  it('reads the page and the count one after the other', async () => {
    tx.review.findMany.mockImplementationOnce(() => statement([]));
    tx.review.count.mockImplementationOnce(() => statement(0));

    const out = await findReviews({
      productId: 3,
      limit: 10,
      actorId: undefined,
      actorRole: 'GUEST',
    } as never);

    expect(out).toEqual({ items: [], limit: 10, total: 0 });
    expect(running.most).toBe(1);
  });

  // The orders that tell a purchase are hidden from guests and buyers: a filter of the purchase reads
  // the page and the count as the system. The votes of the viewer are read as the viewer, so the
  // context is changed back for them, and the authors and buyers are read as the system again
  it('reads a page filtered by the purchase as the system, the votes as the viewer', async () => {
    const out = await findReviews({
      productId: 3,
      limit: 10,
      verifiedPurchase: true,
      actorId: 11,
      actorRole: 'USER',
    } as never);

    expect(out).toMatchObject({ limit: 10, total: 1 });
    expect(steps).toEqual([
      'user context',
      'admin context',
      'page',
      'total',
      'user context',
      'votes',
      'admin context',
      'authors',
      'buyers',
    ]);
    expect(running.most).toBe(1);
  });

  it('reads a page filtered by the purchase of a guest as the system, with no vote to read', async () => {
    await findReviews({
      productId: 3,
      limit: 10,
      verifiedPurchase: false,
      actorId: undefined,
      actorRole: 'GUEST',
    } as never);

    expect(steps).toEqual(['admin context', 'page', 'total', 'admin context', 'authors', 'buyers']);
  });

  it('keeps the context of the viewer for a page with no filter', async () => {
    await findReviews({
      productId: 3,
      limit: 10,
      actorId: 11,
      actorRole: 'USER',
    } as never);

    expect(steps).toEqual([
      'user context',
      'page',
      'total',
      'votes',
      'admin context',
      'authors',
      'buyers',
    ]);
  });

  it('puts the filter in the where of the page and of the count', async () => {
    await findReviews({
      productId: 3,
      limit: 10,
      verifiedPurchase: true,
      actorId: undefined,
      actorRole: 'GUEST',
    } as never);

    const bought = {
      orders: {
        some: {
          status: { in: ['paid', 'shipped', 'delivered'] },
          items: { some: { productId: 3 } },
        },
      },
    };
    expect(tx.review.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { productId: 3, user: bought } }),
    );
    expect(tx.review.count).toHaveBeenCalledWith({ where: { productId: 3, user: bought } });
  });
});
