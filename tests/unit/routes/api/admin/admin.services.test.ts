import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import { InternalError } from '@utils/errors.js';

import { rejectedBy } from '../../../../helpers/errors.js';

// GET /api/admin/stats reads one row of cartlify.admin_stats_view: json objects the service checks
// and turns into the answer. A row of another shape is a broken view, a server error that names
// the field; numbers may come as numeric text and dates as text, the way postgres gives them.
// The database is replaced here, the view itself is in the db tests
const executeRaw = jest.fn<(...args: unknown[]) => Promise<number>>(async () => 0);
const queryRaw = jest.fn<(...args: unknown[]) => Promise<unknown[]>>(async () => []);
const db = { $executeRaw: executeRaw, $queryRaw: queryRaw };

jest.unstable_mockModule('@db/client.js', () => ({
  tx: async (fn: (client: typeof db) => Promise<unknown>) => fn(db),
  prisma: {},
  isRetryableTxError: () => false,
  getPgCode: () => null,
  getPgMessage: () => null,
}));

const { adminServices } = await import('@routes/api/admin/admin.services.js');

const PERIOD = {
  from: new Date('2026-01-01T00:00:00.000Z'),
  to: new Date('2026-02-01T00:00:00.000Z'),
};

const viewRow = () => ({
  period: { from: '2026-01-01T00:00:00+00:00', to: '2026-02-01T00:00:00+00:00' },
  users: { total: 3, newInPeriod: 1, new7d: 1, new30d: 2, verifiedTotal: 2, verifiedRate: 66.67 },
  orders: {
    total: 9,
    confirmedTotal: 5,
    pendingCartsTotal: 4,
    byStatus: {
      pending: 4,
      unconfirmed: 0,
      waiting: 1,
      paid: 2,
      shipped: 1,
      delivered: 1,
      cancelled: 0,
    },
    revenue: { total: 120.5, inPeriod: 60, last7d: 10, last30d: 60 },
    averageOrderValue: 30.13,
    itemsSold: 7,
  },
  products: {
    total: 4,
    activeTotal: 3,
    deletedTotal: 1,
    outOfStockTotal: 1,
    topProductsByRevenue: [{ id: 2, name: 'Mug', revenue: 60, quantitySold: 3 }],
    topCategoriesByRevenue: [{ id: 1, name: 'Kitchen', revenue: 60, quantitySold: 3 }],
  },
  reviews: { total: 2, ratedTotal: 2, newInPeriod: 1, avgRating: 4.5, negativeCount: 0 },
  createdAt: new Date('2026-02-01T00:00:00.000Z'),
});

const stats = () => adminServices.showAllStats({ ...PERIOD, actorId: 5, actorRole: 'ADMIN' });

beforeEach(() => {
  executeRaw.mockClear();
  queryRaw.mockReset();
  queryRaw.mockResolvedValue([viewRow()]);
});

describe('adminServices.showAllStats', () => {
  it('reads the row under the context of the admin, with the period of the request', async () => {
    await stats();

    const texts = executeRaw.mock.calls.map((call) => ({
      sql: (call[0] as string[]).join('?'),
      values: call.slice(1),
    }));
    expect(texts[0]!.sql).toContain('cartlify.set_current_context');
    expect(texts[0]!.values).toEqual(expect.arrayContaining(['ADMIN', 5]));
    expect(texts).toEqual(
      expect.arrayContaining([
        {
          sql: expect.stringContaining("'cartlify.stats_from'"),
          values: [PERIOD.from.toISOString()],
        },
        { sql: expect.stringContaining("'cartlify.stats_to'"), values: [PERIOD.to.toISOString()] },
      ]),
    );
  });

  it('gives the row as it is, the dates of the period as dates', async () => {
    const out = await stats();

    expect(out).toEqual({ ...viewRow(), period: PERIOD });
  });

  // postgres gives numeric as text in some paths, a json date as text
  it('reads numbers given as numeric text and dates given as text', async () => {
    const row = viewRow();
    queryRaw.mockResolvedValue([
      {
        ...row,
        orders: { ...row.orders, revenue: { ...row.orders.revenue, total: '120.50' } },
        users: { ...row.users, verifiedRate: ' 66.67 ' },
        createdAt: '2026-02-01T00:00:00.000Z',
      },
    ]);

    const out = await stats();

    expect(out.orders.revenue.total).toBe(120.5);
    expect(out.users.verifiedRate).toBe(66.67);
    expect(out.createdAt).toEqual(new Date('2026-02-01T00:00:00.000Z'));
  });

  it('fails with a server error when the view gives no row', async () => {
    queryRaw.mockResolvedValue([]);

    const err = await rejectedBy(stats);

    expect(err).toBeInstanceOf(InternalError);
    expect(err).toMatchObject({ details: { reason: 'ADMIN_STATS_VIEW_RETURNED_NO_ROWS' } });
  });

  it.each([
    ['a part that is not an object', (r: Row) => ({ ...r, users: null }), 'users'],
    ['a part that is a list', (r: Row) => ({ ...r, reviews: [] }), 'reviews'],
    [
      'a number that is text of no number',
      (r: Row) => ({ ...r, users: { ...r.users, total: 'many' } }),
      'users.total',
    ],
    [
      'a number that is empty text',
      (r: Row) => ({ ...r, reviews: { ...r.reviews, total: ' ' } }),
      'reviews.total',
    ],
    [
      'a number that is not finite',
      (r: Row) => ({
        ...r,
        orders: { ...r.orders, revenue: { ...r.orders.revenue, inPeriod: Number.NaN } },
      }),
      'orders.revenue.inPeriod',
    ],
    [
      'a count of a status that is missing',
      (r: Row) => ({
        ...r,
        orders: { ...r.orders, byStatus: { ...r.orders.byStatus, cancelled: undefined } },
      }),
      'orders.byStatus.cancelled',
    ],
    [
      'a date that is no date',
      (r: Row) => ({ ...r, period: { ...r.period, to: 'later' } }),
      'period.to',
    ],
    ['a date that is a number', (r: Row) => ({ ...r, createdAt: 0 }), 'createdAt'],
    [
      'a top list that is not a list',
      (r: Row) => ({ ...r, products: { ...r.products, topProductsByRevenue: {} } }),
      'products.topProductsByRevenue',
    ],
    [
      'a product of the top without a name',
      (r: Row) => ({
        ...r,
        products: { ...r.products, topProductsByRevenue: [{ id: 2, revenue: 1, quantitySold: 1 }] },
      }),
      'products.topProductsByRevenue.name',
    ],
    [
      'a category of the top without a name',
      (r: Row) => ({
        ...r,
        products: {
          ...r.products,
          topCategoriesByRevenue: [{ id: 1, name: 7, revenue: 1, quantitySold: 1 }],
        },
      }),
      'products.topCategoriesByRevenue.name',
    ],
    [
      'an item of the top that is not an object',
      (r: Row) => ({ ...r, products: { ...r.products, topCategoriesByRevenue: ['Kitchen'] } }),
      'products.topCategoriesByRevenue.item',
    ],
  ])('fails with a server error naming the field for %s', async (_case, broken, field) => {
    queryRaw.mockResolvedValue([broken(viewRow())]);

    const err = await rejectedBy(stats);

    expect(err).toBeInstanceOf(InternalError);
    expect(err).toMatchObject({ details: { field, reason: 'INVALID_ADMIN_STATS_VIEW_SHAPE' } });
  });
});

type Row = ReturnType<typeof viewRow>;
