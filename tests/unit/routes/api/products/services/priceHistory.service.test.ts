import { describe, expect, it, jest } from '@jest/globals';

// The history of the price reads its page in one transaction. A transaction has one connection, and
// the driver of postgres takes one statement on it at a time: Prisma loads the relations of a query
// side by side (a `join` of its plan runs the queries of the relations together), so a query that
// asks three relations sends statements to the connection while another runs (pg@9 refuses that,
// the warning "Calling client.query() when the client is already executing a query"). A query of a
// transaction asks at most two relations, the rest are read by queries of their own. The database
// is replaced here; the list itself is checked in tests/integration/api/products (priceHistory
// lines of sale.test.ts and variantPrice.test.ts) and tests/integration/api/admin/journals.test.ts

const asked: { select?: Record<string, unknown> }[] = [];

const tx = {
  product: { findUnique: jest.fn(async () => ({ id: 3, name: 'Lamp' })) },
  productVariant: { findFirst: jest.fn(async () => ({ id: 31 })) },
  productPriceChangeLog: {
    findMany: jest.fn(async (args: { select: Record<string, unknown> }) => {
      asked.push(args);
      return [
        {
          id: 9,
          productId: 3,
          variantId: 31,
          variant: { id: 31, position: 1, sku: 'SKU-31' },
          actor: { id: 5, name: 'Ann', role: 'ADMIN', deletedAt: null },
          oldPrice: 10,
          newPrice: 12,
          mode: 'fixed',
          value: 2,
          endsAt: null,
          event: 'price.update',
          createdAt: new Date('2026-04-01T10:00:00.000Z'),
        },
      ];
    }),
  },
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
// the database gives no name of a variant: the name of the product stands for it
jest.unstable_mockModule('@db/variantNames.helper.js', () => ({
  variantNamesOf: jest.fn(async () => new Map()),
}));

const { findPriceHistory } = await import('@routes/api/products/services/priceHistory.service.js');

const dto = { productId: 3, actorId: 5, actorRole: 'ADMIN', limit: 10 } as never;

// the relations a select asks: the keys whose value is a select of their own
const relationsOf = (select: Record<string, unknown>) =>
  Object.entries(select).filter(
    ([, value]) => typeof value === 'object' && value !== null && 'select' in value,
  );

describe('findPriceHistory', () => {
  it('asks the log of prices for at most two relations in one query', async () => {
    asked.length = 0;

    await findPriceHistory(dto);

    expect(asked).toHaveLength(1);
    expect(relationsOf(asked[0]!.select!).length).toBeLessThanOrEqual(2);
  });

  it('names the variant with the name of the product when the database names none', async () => {
    const out = await findPriceHistory(dto);

    expect(out.items[0]).toMatchObject({
      id: 9,
      variant: { id: 31, position: 1, name: 'Lamp', sku: 'SKU-31' },
      actor: { id: 5, name: 'Ann', role: 'ADMIN', deleted: false },
    });
  });
});
