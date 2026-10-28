import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';
import { shopToday } from '@helpers/shopDay.js';

import { inCommittedTx, inRolledBackTx, type DbSession } from '../../helpers/db.js';
import { pay, waitingOrderOf, type DeliveryRule } from '../../helpers/dbOrders.js';
import { dayAfter, setShopDay } from '../../helpers/dbStock.js';
import {
  closeSessions,
  createProduct,
  createUser,
  receiveBatch,
  type TestUser,
} from '../../helpers/factories.js';

// cartlify.admin_stats_view: the numbers of the dashboard of an admin (GET /api/admin/stats) for a
// period the session names (cartlify.stats_from, cartlify.stats_to). Other files make users and
// orders at the same time, so a test compares what one snapshot (repeatable read) sees before and
// after its own step: the difference is the step alone. The money of a period is the money paid
// in it, as in the reports of the accountant; the users are the accounts of buyers, an admin and
// root are none of them

const REPEATABLE_READ = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead };
const FAR_PAST = '2000-01-01T00:00:00.000Z';
const FAR_FUTURE = '2100-01-01T00:00:00.000Z';

let buyer: TestUser;
let otherBuyer: TestUser;
let admin: TestUser;
let root: TestUser;

type Top = { id: number; name: string; revenue: number; quantitySold: number };
type Stats = {
  users: { total: number; newInPeriod: number; new7d: number; new30d: number };
  orders: {
    byStatus: Record<string, number>;
    revenue: { total: number; inPeriod: number; last7d: number; last30d: number };
    deliveryRevenue: { total: number; inPeriod: number; last7d: number; last30d: number };
    averageOrderValue: number;
    itemsSold: number;
  };
  products: {
    outOfStockTotal: number;
    topProductsByRevenue: Top[];
    topCategoriesByRevenue: Top[];
  };
  reviews: { newInPeriod: number; avgRating: number };
};

beforeAll(async () => {
  buyer = await createUser();
  otherBuyer = await createUser();
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await closeSessions([buyer.id, otherBuyer.id, admin.id, root.id]);
  } finally {
    await prisma.$disconnect();
  }
});

// the row of the view for the period, read by the admin
async function statsOf(db: DbSession, from: string, to: string): Promise<Stats> {
  await db.as({ role: 'ADMIN', userId: admin.id });
  await db.rows(
    `select set_config('cartlify.stats_from', $1, true), set_config('cartlify.stats_to', $2, true)`,
    from,
    to,
  );
  const [row] = await db.rows<Stats>(
    `select users, orders, products, reviews from cartlify.admin_stats_view limit 1`,
  );
  return row!;
}

// a millisecond after the cart of the order was made: the payment comes later
async function afterCartOf(db: DbSession, orderId: number): Promise<string> {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const [row] = await db.rows<{ after: Date }>(
    `select ("createdAt" + interval '1 millisecond') at time zone 'UTC' as after
     from cartlify.orders where id = $1`,
    orderId,
  );
  return row!.after.toISOString();
}

// an order of units at 40 (2 unless asked) that waits for its payment, its cart made and
// committed before
async function waitingOrder(quantity = 2, rule: DeliveryRule = {}) {
  const product = await createProduct({ stock: 5, price: 40 });
  const orderId = await inCommittedTx((db) =>
    waitingOrderOf(db, buyer.id, [[product.id, quantity]], rule),
  );
  return { product, orderId };
}

// the time a row was written at and a millisecond after it: a period with that time alone
async function momentOf(db: DbSession, table: 'orders' | 'reviews', column: string, id: number) {
  await db.as({ role: 'ADMIN', userId: admin.id });
  const [row] = await db.rows<{ from: Date; to: Date }>(
    `select "${column}" at time zone 'UTC' as "from",
            ("${column}" + interval '1 millisecond') at time zone 'UTC' as "to"
     from cartlify.${table} where id = $1`,
    id,
  );
  return { from: row!.from.toISOString(), to: row!.to.toISOString() };
}

const topOf = (list: Top[], id: number) => list.find((item) => item.id === id);

describe('cartlify.admin_stats_view', () => {
  it('counts a paid order in the revenue of the period it was paid in', async () => {
    const { orderId } = await waitingOrder();

    const { before, after } = await inRolledBackTx(async (db) => {
      const from = await afterCartOf(db, orderId);
      const before = await statsOf(db, from, FAR_FUTURE);
      expect(await pay(db, admin.id, orderId)).toBe('PAID');
      return { before, after: await statsOf(db, from, FAR_FUTURE) };
    }, REPEATABLE_READ);

    expect(after.orders.revenue.total - before.orders.revenue.total).toBeCloseTo(80, 2);
    expect(after.orders.revenue.inPeriod - before.orders.revenue.inPeriod).toBeCloseTo(80, 2);
  });

  // the revenue is what the buyers paid, the delivery they paid for included; the delivery alone is
  // a part of it, and it is none while the order is not paid
  it('counts the delivery a buyer paid for in the revenue and apart in the delivery revenue', async () => {
    const { orderId } = await waitingOrder(2, { flat: 6 });

    const { waiting, before, after } = await inRolledBackTx(async (db) => {
      const from = await afterCartOf(db, orderId);
      const before = await statsOf(db, from, FAR_FUTURE);
      const waiting = await statsOf(db, from, FAR_FUTURE);
      expect(await pay(db, admin.id, orderId)).toBe('PAID');
      return { waiting, before, after: await statsOf(db, from, FAR_FUTURE) };
    }, REPEATABLE_READ);

    expect(waiting.orders.deliveryRevenue).toEqual(before.orders.deliveryRevenue);
    for (const period of ['total', 'inPeriod'] as const) {
      expect(after.orders.revenue[period] - before.orders.revenue[period]).toBeCloseTo(86, 2);
      expect(
        after.orders.deliveryRevenue[period] - before.orders.deliveryRevenue[period],
      ).toBeCloseTo(6, 2);
    }
  });

  it('counts the delivery of the last 7 and 30 days from the payment', async () => {
    const { orderId } = await waitingOrder(2, { flat: 6 });

    const { before, after } = await inRolledBackTx(async (db) => {
      const before = await statsOf(db, FAR_PAST, FAR_FUTURE);
      await pay(db, admin.id, orderId);
      return { before, after: await statsOf(db, FAR_PAST, FAR_FUTURE) };
    }, REPEATABLE_READ);

    for (const period of ['last7d', 'last30d'] as const) {
      expect(
        after.orders.deliveryRevenue[period] - before.orders.deliveryRevenue[period],
      ).toBeCloseTo(6, 2);
    }
  });

  it('counts nothing for the delivery of a pickup or of a delivery that cost nothing', async () => {
    const { orderId } = await waitingOrder(2);

    const { before, after } = await inRolledBackTx(async (db) => {
      const before = await statsOf(db, FAR_PAST, FAR_FUTURE);
      await pay(db, admin.id, orderId);
      return { before, after: await statsOf(db, FAR_PAST, FAR_FUTURE) };
    }, REPEATABLE_READ);

    expect(after.orders.deliveryRevenue.total).toBeCloseTo(before.orders.deliveryRevenue.total, 2);
    expect(after.orders.revenue.total - before.orders.revenue.total).toBeCloseTo(80, 2);
  });

  it('takes the delivery out of the revenue with the rest once the order is cancelled', async () => {
    const { orderId } = await waitingOrder(2, { flat: 6 });

    const { paid, cancelled } = await inRolledBackTx(async (db) => {
      await pay(db, admin.id, orderId);
      const paid = await statsOf(db, FAR_PAST, FAR_FUTURE);
      await db.as({ role: 'ADMIN' });
      await db.rows(`select 1 as done from cartlify.cancel_paid_order($1::int)`, orderId);
      return { paid, cancelled: await statsOf(db, FAR_PAST, FAR_FUTURE) };
    }, REPEATABLE_READ);

    expect(paid.orders.deliveryRevenue.total - cancelled.orders.deliveryRevenue.total).toBeCloseTo(
      6,
      2,
    );
    expect(paid.orders.revenue.total - cancelled.orders.revenue.total).toBeCloseTo(86, 2);
  });

  it('names the product and the category of an order paid in the period in its tops', async () => {
    const { product, orderId } = await waitingOrder();

    const after = await inRolledBackTx(async (db) => {
      const from = await afterCartOf(db, orderId);
      await pay(db, admin.id, orderId);
      return statsOf(db, from, FAR_FUTURE);
    }, REPEATABLE_READ);

    expect(topOf(after.products.topProductsByRevenue, product.id)).toMatchObject({
      revenue: 80,
      quantitySold: 2,
    });
    expect(topOf(after.products.topCategoriesByRevenue, product.categoryId)).toMatchObject({
      revenue: 80,
      quantitySold: 2,
    });
  });

  it('counts the money of the last 7 and 30 days from the payment', async () => {
    const { orderId } = await waitingOrder();

    const { before, after } = await inRolledBackTx(async (db) => {
      const before = await statsOf(db, FAR_PAST, FAR_FUTURE);
      await pay(db, admin.id, orderId);
      return { before, after: await statsOf(db, FAR_PAST, FAR_FUTURE) };
    }, REPEATABLE_READ);

    expect(after.orders.revenue.last7d - before.orders.revenue.last7d).toBeCloseTo(80, 2);
    expect(after.orders.revenue.last30d - before.orders.revenue.last30d).toBeCloseTo(80, 2);
  });

  // the money of a cancelled order went back to the buyer
  it('takes a paid order out of the revenue once it is cancelled', async () => {
    const { orderId } = await waitingOrder();

    const { paid, cancelled } = await inRolledBackTx(async (db) => {
      await pay(db, admin.id, orderId);
      const paid = await statsOf(db, FAR_PAST, FAR_FUTURE);
      await db.as({ role: 'ADMIN' });
      await db.rows(`select 1 as done from cartlify.cancel_paid_order($1::int)`, orderId);
      return { paid, cancelled: await statsOf(db, FAR_PAST, FAR_FUTURE) };
    }, REPEATABLE_READ);

    expect(paid.orders.revenue.total - cancelled.orders.revenue.total).toBeCloseTo(80, 2);
    expect(paid.orders.revenue.inPeriod - cancelled.orders.revenue.inPeriod).toBeCloseTo(80, 2);
    expect(cancelled.orders.byStatus.cancelled! - paid.orders.byStatus.cancelled!).toBe(1);
    expect(paid.orders.byStatus.paid! - cancelled.orders.byStatus.paid!).toBe(1);
  });

  // the columns keep utc without a zone, the period is an instant: the time zone of the session
  // must not move one against the other
  it('gives the same numbers of a period in any time zone of the session', async () => {
    const counts = await inRolledBackTx(async (db) => {
      await db.as({ role: 'ADMIN', userId: admin.id });
      const [row] = await db.rows<{ from: Date; to: Date }>(
        `select "createdAt" at time zone 'UTC' as "from",
                ("createdAt" + interval '1 millisecond') at time zone 'UTC' as "to"
         from cartlify.users where id = $1`,
        buyer.id,
      );
      const from = row!.from.toISOString();
      const to = row!.to.toISOString();

      await db.rows(`set local time zone 'UTC'`);
      const utc = await statsOf(db, from, to);
      await db.rows(`set local time zone 'Pacific/Kiritimati'`);
      const plus14 = await statsOf(db, from, to);
      await db.rows(`set local time zone 'America/Los_Angeles'`);
      const minus7 = await statsOf(db, from, to);

      return [utc, plus14, minus7].map((stats) => stats.users.newInPeriod);
    }, REPEATABLE_READ);

    expect(counts[0]).toBeGreaterThanOrEqual(1);
    expect(counts).toEqual([counts[0], counts[0], counts[0]]);
  });

  // the units of a batch whose last good day is over are not for sale. The batch comes in the way
  // the app takes it in, by the day of the shop (SHOP_TIME_ZONE), not of utc: late in the evening
  // of utc it is already the next day in Madrid
  it('counts a product out of stock once all its units are over', async () => {
    const today = shopToday();
    const product = await createProduct({ stock: 0 });
    await receiveBatch(product.id, { quantity: 3, expiresAt: today });

    const { before, after } = await inRolledBackTx(async (db) => {
      await setShopDay(db, today);
      const before = await statsOf(db, FAR_PAST, FAR_FUTURE);
      await setShopDay(db, dayAfter(today, 2));
      return { before, after: await statsOf(db, FAR_PAST, FAR_FUTURE) };
    }, REPEATABLE_READ);

    expect(after.products.outOfStockTotal - before.products.outOfStockTotal).toBeGreaterThanOrEqual(
      1,
    );
  });

  it.each(['ADMIN', 'ROOT'])('leaves an account out of the users once it is %s', async (role) => {
    const promoted = await createUser();

    const { before, after } = await inRolledBackTx(async (db) => {
      const before = await statsOf(db, FAR_PAST, FAR_FUTURE);
      await db.as({ role: 'ROOT', userId: root.id });
      await db.rows(
        `update cartlify.users set role = $2::cartlify."Role" where id = $1 returning id`,
        promoted.id,
        role,
      );
      return { before, after: await statsOf(db, FAR_PAST, FAR_FUTURE) };
    }, REPEATABLE_READ);

    for (const field of ['total', 'newInPeriod', 'new7d', 'new30d'] as const) {
      expect(before.users[field] - after.users[field]).toBe(1);
    }
    await closeSessions([promoted.id]);
  });

  it('counts the units sold in the period the order was paid in', async () => {
    const { orderId } = await waitingOrder(3);

    const { inPeriod, before } = await inRolledBackTx(async (db) => {
      const from = await afterCartOf(db, orderId);
      const stats = async () => ({
        inPeriod: (await statsOf(db, from, FAR_FUTURE)).orders.itemsSold,
        before: (await statsOf(db, FAR_PAST, from)).orders.itemsSold,
      });
      const unpaid = await stats();
      await pay(db, admin.id, orderId);
      const paid = await stats();
      return {
        inPeriod: paid.inPeriod - unpaid.inPeriod,
        before: paid.before - unpaid.before,
      };
    }, REPEATABLE_READ);

    expect(inPeriod).toBe(3);
    expect(before).toBe(0);
  });

  // both orders are paid in one transaction, at one time: the period holds that time alone
  it('averages the orders paid in the period', async () => {
    const first = await waitingOrder(2);
    const second = await waitingOrder(1);

    const stats = await inRolledBackTx(async (db) => {
      await pay(db, admin.id, first.orderId);
      await pay(db, admin.id, second.orderId);
      const { from, to } = await momentOf(db, 'orders', 'paidAt', first.orderId);
      return statsOf(db, from, to);
    }, REPEATABLE_READ);

    expect(stats.orders.revenue.inPeriod).toBeCloseTo(120, 2);
    expect(stats.orders.averageOrderValue).toBeCloseTo(60, 2);
    expect(stats.orders.itemsSold).toBe(3);
  });

  // both reviews are written in one transaction, at one time: the period holds that time alone
  it('averages the ratings of the reviews written in the period', async () => {
    const product = await createProduct();

    const stats = await inRolledBackTx(async (db) => {
      let reviewId = 0;
      for (const [user, rating] of [
        [buyer, 5],
        [otherBuyer, 2],
      ] as const) {
        await db.as({ role: 'USER', userId: user.id });
        const [row] = await db.rows<{ id: number }>(
          `insert into cartlify.reviews ("userId", "productId", rating) values ($1, $2, $3)
           returning id`,
          user.id,
          product.id,
          rating,
        );
        reviewId = row!.id;
      }
      const { from, to } = await momentOf(db, 'reviews', 'createdAt', reviewId);
      return statsOf(db, from, to);
    }, REPEATABLE_READ);

    expect(stats.reviews.newInPeriod).toBe(2);
    expect(stats.reviews.avgRating).toBeCloseTo(3.5, 2);
  });
});
