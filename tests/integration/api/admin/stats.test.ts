import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { closeSessions, createUser, type TestUser } from '../../../helpers/factories.js';

// GET /api/admin/stats: the numbers of the dashboard of an admin, read from
// cartlify.admin_stats_view (its numbers are checked in db/adminStats.test.ts). The period is
// [from, to): all time until now unless given. Other files make users and orders at the same time,
// so the totals are checked by their shape; a period of a year before the test database was built
// has nothing in it

let app: FastifyInstance;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const stats = (query: Record<string, string> = {}, actor: TestUser | null = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/stats?${new URLSearchParams(query)}`,
    ...(actor ? { headers: { cookie: accessCookie(actor) } } : {}),
  });

const EMPTY_PERIOD = { from: '2020-01-01T00:00:00.000Z', to: '2020-02-01T00:00:00.000Z' };

beforeAll(async () => {
  app = await startApp();
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('GET /api/admin/stats', () => {
  it('gives the numbers of the users, the orders, the products and the reviews', async () => {
    await newUser();
    const res = await stats();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const count = expect.any(Number);
    expect(body).toEqual({
      period: { from: expect.any(String), to: expect.any(String) },
      users: {
        total: count,
        newInPeriod: count,
        new7d: count,
        new30d: count,
        verifiedTotal: count,
        verifiedRate: count,
      },
      orders: {
        total: count,
        confirmedTotal: count,
        pendingCartsTotal: count,
        byStatus: {
          pending: count,
          unconfirmed: count,
          waiting: count,
          paid: count,
          shipped: count,
          delivered: count,
          cancelled: count,
        },
        revenue: { total: count, inPeriod: count, last7d: count, last30d: count },
        averageOrderValue: count,
        itemsSold: count,
      },
      products: {
        total: count,
        activeTotal: count,
        deletedTotal: count,
        outOfStockTotal: count,
        topProductsByRevenue: expect.any(Array),
        topCategoriesByRevenue: expect.any(Array),
      },
      reviews: {
        total: count,
        ratedTotal: count,
        newInPeriod: count,
        avgRating: count,
        negativeCount: count,
      },
      createdAt: expect.any(String),
    });
    // the buyer of this test is a user; its admins are not
    expect(body.users.total).toBeGreaterThanOrEqual(1);
    expect(body.products.activeTotal + body.products.deletedTotal).toBe(body.products.total);
  });

  it('takes all time until now as the period unless given', async () => {
    const before = Date.now();
    const res = await stats();
    const after = Date.now();

    const { period } = res.json();
    expect(period.from).toBe('1970-01-01T00:00:00.000Z');
    expect(Date.parse(period.to)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(period.to)).toBeLessThanOrEqual(after);
  });

  it('counts the new users of the period they signed up in', async () => {
    const startedAt = Date.now();
    await newUser();

    const res = await stats({
      from: new Date(startedAt - 60_000).toISOString(),
      to: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(res.json().users.newInPeriod).toBeGreaterThanOrEqual(1);
  });

  it('counts nothing in a period with nothing in it', async () => {
    const res = await stats(EMPTY_PERIOD);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      period: EMPTY_PERIOD,
      users: { newInPeriod: 0 },
      orders: { revenue: { inPeriod: 0 } },
      products: { topProductsByRevenue: [], topCategoriesByRevenue: [] },
      reviews: { newInPeriod: 0 },
    });
  });

  it('takes a period that starts and ends at the same time', async () => {
    const res = await stats({ from: EMPTY_PERIOD.from, to: EMPTY_PERIOD.from });

    expect(res.statusCode).toBe(200);
    expect(res.json().period).toEqual({ from: EMPTY_PERIOD.from, to: EMPTY_PERIOD.from });
  });

  it('refuses a period that ends before it starts', async () => {
    const res = await stats({ from: EMPTY_PERIOD.to, to: EMPTY_PERIOD.from });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'INVALID_STATS_PERIOD',
      details: { from: EMPTY_PERIOD.to, to: EMPTY_PERIOD.from, reason: 'FROM_AFTER_TO' },
    });
  });

  // only the start: until now; only the end: from the start of all time
  it('takes one end of the period alone', async () => {
    const onlyFrom = await stats({ from: EMPTY_PERIOD.from });
    const onlyTo = await stats({ to: EMPTY_PERIOD.to });

    expect(onlyFrom.json().period.from).toBe(EMPTY_PERIOD.from);
    expect(onlyTo.json().period).toEqual({ from: '1970-01-01T00:00:00.000Z', to: EMPTY_PERIOD.to });
  });

  it('refuses a start of the period that is not a date', async () => {
    const res = await stats({ from: 'yesterday' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // the format of a date lets a leap second through, a date of javascript has none
  it('refuses a leap second as a time it cannot read', async () => {
    const res = await stats({ to: '2016-12-31T23:59:60Z' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'INVALID_STATS_PERIOD',
      details: { field: 'to', reason: 'INVALID_DATE' },
    });
  });

  it('gives the numbers to root', async () => {
    const res = await stats({}, root);

    expect(res.statusCode).toBe(200);
  });

  // a guest has the role GUEST, as on the other admin routes
  it('refuses a buyer and a guest', async () => {
    const buyer = await stats({}, await newUser());
    const guest = await stats({}, null);

    for (const res of [buyer, guest]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    }
  });
});
