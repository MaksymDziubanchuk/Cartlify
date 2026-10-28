import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  receiveBatch,
  uniqueTag,
  writeOffStock,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';

// GET /api/admin/reports/accounting/products, /categories and /timeline: the money of a period by
// product, by category (with its whole branch, or only its own products) and by day, week or month
// of the shop (SHOP_TIME_ZONE, Europe/Madrid unless given), each sorted the way the admin asks and
// as a csv file for the accountant. The margin is of the sales; the write-offs are a column of
// their own. Other test files make orders and batches at the same time, so each test reads only
// its own categories

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

// a breakdown by its name, the summary without one
const get = (path: string, query: Record<string, string>, actor: TestUser = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/reports/accounting${path ? `/${path}` : ''}?${new URLSearchParams(query)}`,
    headers: { cookie: accessCookie(actor) },
  });

const cancelPaid = (orderId: number) =>
  asAdmin((tx) => tx.$executeRaw`select cartlify.cancel_paid_order(${orderId}::int)`);

// a tree of its own: top (alpha, empty) and its child (beta, zeta)
//  - alpha: 10 in at 2; 3 sold at 10, 1 sold and cancelled, 1 written off; 6 left
//  - beta: 5 in at 5; 2 sold at 20; 3 left
//  - zeta: 2 in at 1.50, nothing sold, 2 left
//  - empty: nothing at all, never listed
const tag = uniqueTag();
let top: { id: number; name: string };
let child: { id: number; name: string };
let alpha: TestProduct;
let beta: TestProduct;
let zeta: TestProduct;
let startedAt: number;

const period = () => ({
  from: new Date(startedAt - 60_000).toISOString(),
  to: new Date(Date.now() + 60_000).toISOString(),
});

const NO_SALES = { units: 0, revenue: 0, cost: 0, margin: 0 };
const NO_CANCELS = { units: 0, revenue: 0, cost: 0 };
const NOTHING = { units: 0, value: 0 };

// the order of alpha cancelled later is no sale: it is told apart, in no margin
const ALPHA = {
  sales: { units: 3, revenue: 30, cost: 6, margin: 24, marginPercent: 80 },
  cancellations: { units: 1, revenue: 10, cost: 2 },
  writeOffs: { units: 1, value: 2 },
  afterWriteOffs: { margin: 22, marginPercent: 73.33 },
  purchases: { units: 10, value: 20 },
  stock: { units: 6, value: 12 },
};
const BETA = {
  sales: { units: 2, revenue: 40, cost: 10, margin: 30, marginPercent: 75 },
  cancellations: NO_CANCELS,
  writeOffs: NOTHING,
  afterWriteOffs: { margin: 30, marginPercent: 75 },
  purchases: { units: 5, value: 25 },
  stock: { units: 3, value: 15 },
};
const ZETA = {
  sales: { ...NO_SALES, marginPercent: null },
  cancellations: NO_CANCELS,
  writeOffs: NOTHING,
  afterWriteOffs: { margin: 0, marginPercent: null },
  purchases: { units: 2, value: 3 },
  stock: { units: 2, value: 3 },
};

// the branch of top: alpha, beta, zeta
const TREE = {
  sales: { units: 5, revenue: 70, cost: 16, margin: 54, marginPercent: 77.14 },
  cancellations: { units: 1, revenue: 10, cost: 2 },
  writeOffs: { units: 1, value: 2 },
  afterWriteOffs: { margin: 52, marginPercent: 74.29 },
  purchases: { units: 17, value: 48 },
  stock: { units: 11, value: 30 },
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  startedAt = Date.now();

  top = await createCategory({ name: `Report top ${tag}` });
  child = await createCategory({ name: `Report child ${tag}`, parentId: top.id });

  alpha = await createProduct({ stock: 0, price: 10, categoryId: top.id, name: `Alpha ${tag}` });
  beta = await createProduct({ stock: 0, price: 20, categoryId: child.id, name: `Beta ${tag}` });
  zeta = await createProduct({
    stock: 0,
    price: 5,
    categoryId: child.id,
    name: `Zeta, the "quoted" ${tag}`,
  });
  await createProduct({ stock: 0, price: 1, categoryId: top.id, name: `Empty ${tag}` });

  await receiveBatch(alpha.id, { quantity: 10, unitCost: 2 });
  await receiveBatch(beta.id, { quantity: 5, unitCost: 5 });
  await receiveBatch(zeta.id, { quantity: 2, unitCost: 1.5 });

  const buyer = await newUser();
  await placeOrder(app, csrf, buyer, alpha, 'paid', 3);
  await cancelPaid(await placeOrder(app, csrf, buyer, alpha, 'paid', 1));
  await placeOrder(app, csrf, buyer, beta, 'paid', 2);
  await writeOffStock(alpha.id, 1, { reason: 'damaged' });
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type Row = { id: number; name: string } & Record<string, unknown>;
type Step = {
  sales: { margin: number; units: number };
  afterWriteOffs: { margin: number };
  summary: { margin: { total: number } };
  writeOffs: { value: number };
  purchases: { value: number };
};
const idsOf = (res: { json: () => { items: Row[] } }) => res.json().items.map((row) => row.id);

describe('GET /api/admin/reports/accounting/products', () => {
  it('gives each product of the branch with its money, the most revenue first', async () => {
    const res = await get('products', { ...period(), categoryId: String(top.id) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ currency: 'eur', limit: 20, nextCursor: null });
    expect(res.json().items).toEqual([
      {
        id: beta.id,
        name: `Beta ${tag}`,
        deleted: false,
        category: { id: child.id, name: child.name },
        ...BETA,
      },
      {
        id: alpha.id,
        name: `Alpha ${tag}`,
        deleted: false,
        category: { id: top.id, name: top.name },
        ...ALPHA,
      },
      {
        id: zeta.id,
        name: `Zeta, the "quoted" ${tag}`,
        deleted: false,
        category: { id: child.id, name: child.name },
        ...ZETA,
      },
    ]);
  });

  it('gives the totals of every product of the filter', async () => {
    const res = await get('products', { ...period(), categoryId: String(top.id), limit: '1' });

    expect(res.json().totals).toEqual(TREE);
  });

  it('keeps to the own products of the category without its branch', async () => {
    const own = await get('products', { ...period(), categoryId: String(top.id), branch: 'false' });
    const ofChild = await get('products', { ...period(), categoryId: String(child.id) });

    expect(idsOf(own)).toEqual([alpha.id]);
    expect(idsOf(ofChild)).toEqual([beta.id, zeta.id]);
  });

  it.each([
    ['margin', 'asc', () => [zeta.id, alpha.id, beta.id]],
    // nothing sold has no percent: it comes last either way
    ['marginPercent', 'desc', () => [alpha.id, beta.id, zeta.id]],
    ['marginPercent', 'asc', () => [beta.id, alpha.id, zeta.id]],
    ['units', 'desc', () => [alpha.id, beta.id, zeta.id]],
    ['marginAfterWriteOffs', 'desc', () => [beta.id, alpha.id, zeta.id]],
    ['writeOffs', 'desc', () => [alpha.id, zeta.id, beta.id]],
    ['purchases', 'desc', () => [beta.id, alpha.id, zeta.id]],
    ['stockValue', 'desc', () => [beta.id, alpha.id, zeta.id]],
    ['stockUnits', 'asc', () => [zeta.id, beta.id, alpha.id]],
    ['name', 'asc', () => [alpha.id, beta.id, zeta.id]],
  ])('sorts by %s %s', async (sortBy, sortOrder, expected) => {
    const res = await get('products', {
      ...period(),
      categoryId: String(top.id),
      sortBy,
      sortOrder,
    });

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual(expected());
  });

  it.each([
    ['revenue', 'desc'],
    ['marginPercent', 'desc'],
    ['marginPercent', 'asc'],
    ['name', 'asc'],
  ])('pages by %s %s with the cursor, each product once', async (sortBy, sortOrder) => {
    const query = { ...period(), categoryId: String(top.id), sortBy, sortOrder };
    const whole = idsOf(await get('products', query));

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const res = await get('products', { ...query, limit: '1', ...(cursor ? { cursor } : {}) });
      expect(res.statusCode).toBe(200);
      seen.push(...idsOf(res));
      cursor = res.json().nextCursor;
      if (!cursor) break;
    }

    expect(seen).toEqual(whole);
  });

  it('refuses a cursor of another sort', async () => {
    const first = await get('products', { ...period(), categoryId: String(top.id), limit: '1' });

    const res = await get('products', {
      ...period(),
      categoryId: String(top.id),
      sortBy: 'name',
      cursor: first.json().nextCursor,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });

  it('lists a product removed from the catalog with what it sold', async () => {
    const category = await createCategory();
    const gone = await createProduct({ stock: 0, price: 10, categoryId: category.id });
    await receiveBatch(gone.id, { quantity: 1, unitCost: 4 });
    await placeOrder(app, csrf, await newUser(), gone, 'paid');
    await deleteProductFromCatalog(gone.id);

    const res = await get('products', { ...period(), categoryId: String(category.id) });

    expect(res.json().items).toEqual([
      expect.objectContaining({
        id: gone.id,
        deleted: true,
        sales: expect.objectContaining({ revenue: 10 }),
      }),
    ]);
  });

  it('gives the accountant a csv file of every product, the totals last', async () => {
    const res = await get('products', {
      ...period(),
      categoryId: String(top.id),
      format: 'csv',
      limit: '1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="accounting-products-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(lines[0]).toBe(
      'id,name,category,deleted,sold_units,sold_revenue,sold_cost,sold_margin,' +
        'sold_margin_percent,cancelled_units,cancelled_revenue,cancelled_cost,' +
        'written_off_units,written_off_value,margin_after_write_offs,' +
        'margin_after_write_offs_percent,purchased_units,purchased_value,stock_units,stock_value',
    );
    // every product, not a page
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe(
      `${beta.id},Beta ${tag},${child.name},no,2,40.00,10.00,30.00,75.00,0,0.00,0.00,0,0.00,30.00,75.00,5,25.00,3,15.00`,
    );
    expect(lines[3]).toBe(
      `${zeta.id},"Zeta, the ""quoted"" ${tag}",${child.name},no,0,0.00,0.00,0.00,,0,0.00,0.00,0,0.00,0.00,,2,3.00,2,3.00`,
    );
    expect(lines[4]).toBe(
      ',Total,,,5,70.00,16.00,54.00,77.14,1,10.00,2.00,1,2.00,52.00,74.29,17,48.00,11,30.00',
    );
  });

  it('keeps a name that looks like a formula as text in the csv', async () => {
    const category = await createCategory();
    const odd = await createProduct({ stock: 0, categoryId: category.id, name: `=SUM(A1) ${tag}` });
    await receiveBatch(odd.id, { quantity: 1, unitCost: 1 });

    const res = await get('products', {
      ...period(),
      categoryId: String(category.id),
      format: 'csv',
    });

    expect(res.body).toContain(`${odd.id},'=SUM(A1) ${tag},`);
  });

  it('answers 404 for a category that does not exist', async () => {
    const res = await get('products', { categoryId: '2000000000' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_NOT_FOUND' });
  });

  it.each([
    ['an unknown sort', { sortBy: 'popularity' }],
    ['an unknown format', { format: 'xlsx' }],
    ['a page of 101', { limit: '101' }],
  ])('refuses %s', async (_case, query) => {
    const res = await get('products', query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a user', async () => {
    const res = await get('products', {}, await newUser());

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
  });
});

describe('GET /api/admin/reports/accounting/categories', () => {
  const rowOf = (res: { json: () => { items: Row[] } }, id: number) => {
    const row = res.json().items.find((item) => item.id === id);
    if (!row) throw new Error(`the report has no category ${id}`);
    return row;
  };

  it('counts each category with its whole branch', async () => {
    const res = await get('categories', period());

    expect(res.statusCode).toBe(200);
    expect(rowOf(res, top.id)).toEqual({ id: top.id, name: top.name, parentId: null, ...TREE });
    expect(rowOf(res, child.id)).toMatchObject({
      parentId: top.id,
      sales: { revenue: 40, margin: 30 },
      purchases: { units: 7, value: 28 },
    });
  });

  it('counts each category with its own products only, without the branch', async () => {
    const res = await get('categories', { ...period(), branch: 'false' });

    expect(rowOf(res, top.id)).toMatchObject({
      sales: ALPHA.sales,
      afterWriteOffs: ALPHA.afterWriteOffs,
      stock: ALPHA.stock,
    });
  });

  it('gives the one category asked for, with its branch or without it', async () => {
    const whole = await get('categories', { ...period(), categoryId: String(top.id) });
    const own = await get('categories', {
      ...period(),
      categoryId: String(top.id),
      branch: 'false',
    });

    expect(idsOf(whole)).toEqual([top.id]);
    expect(whole.json().items[0].sales.revenue).toBe(70);
    expect(idsOf(own)).toEqual([top.id]);
    expect(own.json().items[0].sales.revenue).toBe(30);
  });

  it('sorts the categories the way it is asked', async () => {
    const ours = (res: { json: () => { items: Row[] } }) =>
      idsOf(res).filter((id) => id === top.id || id === child.id);

    const byRevenue = await get('categories', { ...period(), sortBy: 'revenue' });
    const byName = await get('categories', { ...period(), sortBy: 'name', sortOrder: 'desc' });

    expect(ours(byRevenue)).toEqual([top.id, child.id]);
    // "Report top" comes after "Report child" by name
    expect(ours(byName)).toEqual([top.id, child.id]);
  });

  // their own products: top has alpha, child has beta and zeta
  it.each([
    // margin 24 and 30
    ['margin', 'child'],
    // 80 and 75 percent
    ['marginPercent', 'top'],
    // 3 and 2 units sold
    ['units', 'top'],
    // 2 and nothing written off
    ['writeOffs', 'top'],
    // 20 and 28 taken in
    ['purchases', 'child'],
    // 12 and 18 left at cost
    ['stockValue', 'child'],
    // 6 and 5 units left
    ['stockUnits', 'top'],
  ] as const)('sorts the categories by %s', async (sortBy, first) => {
    const ours = (res: { json: () => { items: Row[] } }) =>
      idsOf(res).filter((id) => id === top.id || id === child.id);
    const order = first === 'top' ? [top.id, child.id] : [child.id, top.id];
    const query = { ...period(), branch: 'false', sortBy };

    const desc = await get('categories', { ...query, sortOrder: 'desc' });
    const asc = await get('categories', { ...query, sortOrder: 'asc' });

    expect(desc.statusCode).toBe(200);
    expect(ours(desc)).toEqual(order);
    expect(ours(asc)).toEqual([...order].reverse());
  });

  it('gives a csv file of the categories', async () => {
    const res = await get('categories', {
      ...period(),
      categoryId: String(child.id),
      format: 'csv',
    });

    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(lines[0]!.startsWith('id,name,parent_id,sold_units,')).toBe(true);
    expect(lines[1]!.startsWith(`${child.id},${child.name},${top.id},2,40.00,`)).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it('answers 404 for a category that does not exist', async () => {
    const res = await get('categories', { categoryId: '2000000000' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_NOT_FOUND' });
  });
});

describe('GET /api/admin/reports/accounting/timeline', () => {
  const step = (label: string, from: string, to: string) =>
    expect.objectContaining({ label, period: { from, to } });

  // in Madrid october ends at 23:00 utc: the clocks went back on the 26th (of 2025)
  it('splits the period into the months of the shop, by its time zone', async () => {
    const res = await get('timeline', {
      from: '2025-09-30T22:00:00.000Z',
      to: '2025-11-30T23:00:00.000Z',
      step: 'month',
      categoryId: String(top.id),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ step: 'month', timeZone: 'Europe/Madrid', currency: 'eur' });
    expect(res.json().items).toEqual([
      step('2025-10', '2025-09-30T22:00:00.000Z', '2025-10-31T23:00:00.000Z'),
      step('2025-11', '2025-10-31T23:00:00.000Z', '2025-11-30T23:00:00.000Z'),
    ]);
    expect(res.json().items[0]).toMatchObject({
      sales: NO_SALES,
      cancellations: NO_CANCELS,
      writeOffs: NOTHING,
      purchases: NOTHING,
      // the delivery is of no category: a report of one has none
      delivery: null,
    });
  });

  // months long before the tests: no order was paid, cancelled or sent in them
  it('gives the delivery of the whole shop to each step, none to a report of some products', async () => {
    const query = {
      from: '2025-09-30T22:00:00.000Z',
      to: '2025-11-30T23:00:00.000Z',
      step: 'month',
    };

    const whole = await get('timeline', query);
    const some = await get('timeline', { ...query, productIds: String(alpha.id) });

    const nothing = {
      income: { orders: 0, revenue: 0 },
      refunded: { orders: 0, revenue: 0 },
      shipping: { sends: 0, cost: 0, withoutCost: 0 },
      result: 0,
    };
    expect(whole.json().items.map((item: { delivery: unknown }) => item.delivery)).toEqual([
      nothing,
      nothing,
    ]);
    expect(some.json().items.map((item: { delivery: unknown }) => item.delivery)).toEqual([
      null,
      null,
    ]);
  });

  it('cuts the first and the last step to the period', async () => {
    const res = await get('timeline', {
      from: '2026-10-15T10:00:00.000Z',
      to: '2026-11-02T00:00:00.000Z',
      step: 'month',
      categoryId: String(top.id),
    });

    expect(res.json().items).toEqual([
      step('2026-10', '2026-10-15T10:00:00.000Z', '2026-10-31T23:00:00.000Z'),
      step('2026-11', '2026-10-31T23:00:00.000Z', '2026-11-02T00:00:00.000Z'),
    ]);
  });

  it('starts a week on monday, by the calendar of the shop', async () => {
    const res = await get('timeline', {
      from: '2026-10-21T10:00:00.000Z',
      to: '2026-11-04T10:00:00.000Z',
      step: 'week',
      categoryId: String(top.id),
    });

    expect(res.json().items).toEqual([
      step('2026-10-19', '2026-10-21T10:00:00.000Z', '2026-10-25T23:00:00.000Z'),
      step('2026-10-26', '2026-10-25T23:00:00.000Z', '2026-11-01T23:00:00.000Z'),
      step('2026-11-02', '2026-11-01T23:00:00.000Z', '2026-11-04T10:00:00.000Z'),
    ]);
  });

  it('puts the money of the period into its days', async () => {
    const res = await get('timeline', { ...period(), step: 'day', categoryId: String(top.id) });

    const sum = (pick: (item: Record<string, Record<string, number>>) => number) =>
      res.json().items.reduce((total: number, item: never) => total + pick(item), 0);
    expect(sum((item) => item.sales!.revenue!)).toBe(70);
    expect(sum((item) => item.cancellations!.revenue!)).toBe(10);
    expect(sum((item) => item.sales!.margin!)).toBe(54);
    expect(sum((item) => item.writeOffs!.value!)).toBe(2);
    expect(sum((item) => item.afterWriteOffs!.margin!)).toBe(52);
    expect(sum((item) => item.purchases!.value!)).toBe(48);
    const summary = (pick: (s: Record<string, Record<string, number>>) => number) =>
      res.json().items.reduce((total: number, item: never) => total + pick(item['summary']), 0);
    expect(summary((s) => s.income!.items!)).toBe(70);
    expect(summary((s) => s.expenses!.total!)).toBe(18);
    expect(summary((s) => s.margin!.total!)).toBe(52);
  });

  // the end a minute after the money: the last step is the month of the setup, also when the test
  // runs just after the month turned
  const endOfSetup = () => new Date(startedAt + 60_000).toISOString();

  it('gives the step of its end and the eleven before it without a start', async () => {
    const res = await get('timeline', {
      step: 'month',
      to: endOfSetup(),
      categoryId: String(top.id),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(12);
    const last = res.json().items.at(-1);
    expect(Date.parse(last.period.from)).toBeLessThanOrEqual(Date.now());
    expect(last.sales.revenue).toBe(70);
  });

  // an end at the start of a month is the end of the month before it: that month is the last step
  it('gives twelve steps for an end at the start of a month', async () => {
    const res = await get('timeline', {
      step: 'month',
      to: '2026-10-31T23:00:00.000Z',
      categoryId: String(top.id),
    });

    const labels = res.json().items.map((item: { label: string }) => item.label);
    expect(labels).toHaveLength(12);
    expect(labels[0]).toBe('2025-11');
    expect(labels.at(-1)).toBe('2026-10');
  });

  it.each([
    ['day', '2026-10-24T22:00:00.000Z', '2026-10-24'],
    ['week', '2026-10-25T23:00:00.000Z', '2026-10-19'],
  ])('gives twelve steps of a %s for an end at the start of one', async (unit, to, lastLabel) => {
    const res = await get('timeline', { step: unit, to, categoryId: String(top.id) });

    const labels = res.json().items.map((item: { label: string }) => item.label);
    expect(labels).toHaveLength(12);
    expect(labels.at(-1)).toBe(lastLabel);
  });

  // the steps are counted before they are made: a typo in the year asks for millions of days
  it('refuses a period of thousands of years at once, without making its steps', async () => {
    const started = Date.now();

    const res = await get('timeline', {
      from: '0001-01-01T00:00:00.000Z',
      to: '9999-12-31T00:00:00.000Z',
      step: 'day',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'REPORT_PERIOD_TOO_LONG' });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('sorts the steps by their money when asked', async () => {
    const res = await get('timeline', {
      step: 'month',
      to: endOfSetup(),
      categoryId: String(top.id),
      sortBy: 'revenue',
      sortOrder: 'desc',
    });

    expect(res.json().items[0].sales.revenue).toBe(70);
    expect(res.json().items).toHaveLength(12);
  });

  // all the money of the tree is in the month of now, the other eleven have none
  it.each([
    ['margin', (row: Step) => row.sales.margin, 54],
    ['units', (row: Step) => row.sales.units, 5],
    ['marginAfterWriteOffs', (row: Step) => row.afterWriteOffs.margin, 52],
    ['marginTotal', (row: Step) => row.summary.margin.total, 52],
    ['writeOffs', (row: Step) => row.writeOffs.value, 2],
    ['purchases', (row: Step) => row.purchases.value, 48],
  ] as const)('sorts the steps by %s', async (sortBy, valueOf, value) => {
    const query = { step: 'month', to: endOfSetup(), categoryId: String(top.id), sortBy };

    const desc = (await get('timeline', { ...query, sortOrder: 'desc' })).json().items;
    const asc = (await get('timeline', { ...query, sortOrder: 'asc' })).json().items;

    expect(valueOf(desc[0])).toBe(value);
    expect(valueOf(asc.at(-1))).toBe(value);
    expect(valueOf(asc[0])).toBe(0);
  });

  it('refuses more than 400 steps', async () => {
    const res = await get('timeline', {
      from: '2020-01-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
      step: 'day',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'REPORT_PERIOD_TOO_LONG',
      details: { maxSteps: 400 },
    });
  });

  it('gives a csv file of the steps', async () => {
    const res = await get('timeline', {
      from: '2025-09-30T22:00:00.000Z',
      to: '2025-11-30T23:00:00.000Z',
      step: 'month',
      categoryId: String(top.id),
      format: 'csv',
    });

    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(lines[0]!.startsWith('step,from,to,sold_units,sold_revenue,')).toBe(true);
    expect(
      lines[1]!.startsWith('2025-10,2025-09-30T22:00:00.000Z,2025-10-31T23:00:00.000Z,0,0.00,'),
    ).toBe(true);
    expect(lines).toHaveLength(3);
    // the columns of the delivery, empty for a report of a category, then the ones of the summary
    expect(
      lines[0]!.endsWith(
        ',purchased_value,delivery_income,delivery_refunded,shipping_sends,shipping_cost,' +
          'shipping_sends_without_cost,delivery_result,income_items,income_delivery,income_total,' +
          'expense_cost_of_goods,expense_write_offs,expense_shipping,expense_total,margin_items,' +
          'margin_delivery,margin_total',
      ),
    ).toBe(true);
    // the six of the delivery empty, the summary without its delivery and its sends
    expect(lines[1]!.endsWith(',0.00,,,,,,,0.00,,0.00,0.00,0.00,,0.00,0.00,,0.00')).toBe(true);
  });

  it('gives the delivery in the csv of the whole shop', async () => {
    const res = await get('timeline', {
      from: '2025-09-30T22:00:00.000Z',
      to: '2025-10-31T23:00:00.000Z',
      step: 'month',
      format: 'csv',
    });

    const lines = res.body
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(
      lines[1]!.endsWith(
        ',0.00,0.00,0,0.00,0,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00',
      ),
    ).toBe(true);
  });

  it('refuses an unknown step', async () => {
    const res = await get('timeline', { step: 'year' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('GET /api/admin/reports/accounting', () => {
  it('keeps to the category asked for, with its branch or without it', async () => {
    const whole = await get('', { ...period(), categoryId: String(top.id) });
    const own = await get('', { ...period(), categoryId: String(top.id), branch: 'false' });

    expect(whole.json().sales).toMatchObject({ revenue: 70, cost: 16, margin: 54 });
    expect(whole.json().summary).toEqual({
      income: { items: 70, delivery: null, total: 70 },
      expenses: { costOfGoods: 16, writeOffs: 2, shipping: null, total: 18 },
      margin: { items: 54, delivery: null, total: 52 },
    });
    expect(own.json().sales).toMatchObject({ revenue: 30, cost: 6, margin: 24 });
    expect(own.json().stock).toEqual(ALPHA.stock);
  });
});
