import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cancelPaidOrder } from '../../../helpers/cancel.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  receiveBatch,
  uniqueTag,
  writeOffStock,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { orderRowOf, placeOrder } from '../../../helpers/orders.js';
import { cancelAndRefund } from '../../../helpers/returns.js';
import { markVariantDeleted } from '../../../helpers/variants.js';

// GET /api/admin/reports/accounting/products, /categories and /timeline: the money of a period by
// product (a row is a product, the money of its variants added up; the breakdown by variant is
// /variants, reportVariants.test.ts), by category (with its whole branch, or only its own
// products) and by day, week or month of the shop (SHOP_TIME_ZONE, Europe/Madrid unless given),
// each sorted the way the admin asks and as a csv file for the accountant. A category and a step
// add up the variants. The sales are the orders paid in the period, cancelled later or not; the
// returns are the rows whose money went back in the period; the net is the two together, and the
// write-offs and the stock (opening, received, left, closing) are columns of their own. Other test
// files make orders and batches at the same time, so each test reads only its own categories

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

// a tree of its own: top (alpha, empty) and its child (beta, zeta)
//  - alpha: 10 in at 2; 3 sold at 10, then 2 more sold at 10 and cancelled by the shop with the
//    money given back (the units are back in their batch), 1 written off; 6 left
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
const NO_RETURNS = { units: 0, revenue: 0, cost: 0 };
const NO_NET = { units: 0, revenue: 0, cost: 0, margin: 0, marginPercent: null };
const NOTHING = { units: 0, value: 0 };

// the order of alpha that was cancelled is a sale of the period it was paid in, whole; its return is
// in the period the money went back in, and the net is the sales less the returns. The units that
// came back are in the stock again: they came in (received) and went out with the sale (left)
const ALPHA = {
  sales: { units: 5, revenue: 50, cost: 10, margin: 40, marginPercent: 80 },
  returns: { units: 2, revenue: 20, cost: 4 },
  net: { units: 3, revenue: 30, cost: 6, margin: 24, marginPercent: 80 },
  writeOffs: { units: 1, value: 2 },
  afterWriteOffs: { margin: 22, marginPercent: 73.33 },
  purchases: { units: 10, value: 20 },
  stock: {
    opening: NOTHING,
    received: { units: 12, value: 24 },
    left: { units: 6, value: 12 },
    closing: { units: 6, value: 12 },
    onTheWayBack: NOTHING,
  },
};
const BETA = {
  sales: { units: 2, revenue: 40, cost: 10, margin: 30, marginPercent: 75 },
  returns: NO_RETURNS,
  net: { units: 2, revenue: 40, cost: 10, margin: 30, marginPercent: 75 },
  writeOffs: NOTHING,
  afterWriteOffs: { margin: 30, marginPercent: 75 },
  purchases: { units: 5, value: 25 },
  stock: {
    opening: NOTHING,
    received: { units: 5, value: 25 },
    left: { units: 2, value: 10 },
    closing: { units: 3, value: 15 },
    onTheWayBack: NOTHING,
  },
};
const ZETA = {
  sales: { ...NO_SALES, marginPercent: null },
  returns: NO_RETURNS,
  net: NO_NET,
  writeOffs: NOTHING,
  afterWriteOffs: { margin: 0, marginPercent: null },
  purchases: { units: 2, value: 3 },
  stock: {
    opening: NOTHING,
    received: { units: 2, value: 3 },
    left: NOTHING,
    closing: { units: 2, value: 3 },
    onTheWayBack: NOTHING,
  },
};

// the branch of top: alpha, beta, zeta
const TREE = {
  sales: { units: 7, revenue: 90, cost: 20, margin: 70, marginPercent: 77.78 },
  returns: { units: 2, revenue: 20, cost: 4 },
  net: { units: 5, revenue: 70, cost: 16, margin: 54, marginPercent: 77.14 },
  writeOffs: { units: 1, value: 2 },
  afterWriteOffs: { margin: 52, marginPercent: 74.29 },
  purchases: { units: 17, value: 48 },
  stock: {
    opening: NOTHING,
    received: { units: 19, value: 52 },
    left: { units: 8, value: 22 },
    closing: { units: 11, value: 30 },
    onTheWayBack: NOTHING,
  },
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
  await cancelAndRefund(admin.id, await placeOrder(app, csrf, buyer, alpha, 'paid', 2));
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
const productIdsOf = (res: { json: () => { items: Array<{ product: { id: number } }> } }) =>
  res.json().items.map((row) => row.product.id);

describe('GET /api/admin/reports/accounting/products', () => {
  // a row is a product: the money of all its variants added up (the breakdown by variant is
  // GET /api/admin/reports/accounting/variants, reportVariants.test.ts)
  const rowOf = (
    product: TestProduct,
    name: string,
    category: { id: number; name: string },
    money: object,
  ) => ({
    product: { id: product.id, name, deleted: false },
    category: { id: category.id, name: category.name },
    ...money,
  });

  // the most revenue is of the sales: alpha 50 (30 of it left in the net) before beta 40
  it('gives each product of the branch with its money, the most revenue of the sales first', async () => {
    const res = await get('products', { ...period(), categoryId: String(top.id) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ currency: 'eur', limit: 20, nextCursor: null });
    expect(res.json().items).toEqual([
      rowOf(alpha, `Alpha ${tag}`, top, ALPHA),
      rowOf(beta, `Beta ${tag}`, child, BETA),
      rowOf(zeta, `Zeta, the "quoted" ${tag}`, child, ZETA),
    ]);
  });

  it('gives the totals of every product of the filter', async () => {
    const res = await get('products', { ...period(), categoryId: String(top.id), limit: '1' });

    expect(res.json().totals).toEqual(TREE);
  });

  it('keeps to the own products of the category without its branch', async () => {
    const own = await get('products', { ...period(), categoryId: String(top.id), branch: 'false' });
    const ofChild = await get('products', { ...period(), categoryId: String(child.id) });

    expect(productIdsOf(own)).toEqual([alpha.id]);
    expect(productIdsOf(ofChild)).toEqual([beta.id, zeta.id]);
  });

  it.each([
    // the margin of the sales: 40, 30 and nothing (of the net it would be 24 and 30)
    ['margin', 'asc', () => [zeta.id, beta.id, alpha.id]],
    // nothing sold has no percent: it comes last either way
    ['marginPercent', 'desc', () => [alpha.id, beta.id, zeta.id]],
    ['marginPercent', 'asc', () => [beta.id, alpha.id, zeta.id]],
    // the units of the sales: 5 and 2
    ['units', 'desc', () => [alpha.id, beta.id, zeta.id]],
    // the margin of the net less the write-offs: 22 for alpha (of the sales it would be 38), 30
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
    expect(productIdsOf(res)).toEqual(expected());
  });

  it.each([
    ['revenue', 'desc'],
    ['marginPercent', 'desc'],
    ['marginPercent', 'asc'],
    ['name', 'asc'],
  ])('pages by %s %s with the cursor, each product once', async (sortBy, sortOrder) => {
    const query = { ...period(), categoryId: String(top.id), sortBy, sortOrder };
    const whole = productIdsOf(await get('products', query));

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const res = await get('products', { ...query, limit: '1', ...(cursor ? { cursor } : {}) });
      expect(res.statusCode).toBe(200);
      seen.push(...productIdsOf(res));
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

  // the cursor of the breakdown by variant names the id of a variant, this one the id of a product
  it('refuses a cursor of the breakdown by variant', async () => {
    const first = await get('variants', { ...period(), categoryId: String(top.id), limit: '1' });
    expect(first.json().nextCursor).not.toBeNull();

    const res = await get('products', {
      ...period(),
      categoryId: String(top.id),
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
        product: expect.objectContaining({ id: gone.id, deleted: true }),
        sales: expect.objectContaining({ revenue: 10 }),
      }),
    ]);
  });

  // the cancel of a paid order whose money has not gone back is no return: the sale stands whole,
  // the units are on the shelf again (they came in, as the sale took them out)
  it('keeps the sale whole and counts no return for a cancel whose money did not go back', async () => {
    const category = await createCategory();
    const product = await createProduct({ stock: 0, price: 10, categoryId: category.id });
    await receiveBatch(product.id, { quantity: 4, unitCost: 2 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid', 2);
    await cancelPaidOrder(admin.id, orderId);

    const res = await get('products', { ...period(), categoryId: String(category.id) });

    expect(res.json().items).toHaveLength(1);
    expect(res.json().items[0]).toMatchObject({
      sales: { units: 2, revenue: 20, cost: 4, margin: 16, marginPercent: 80 },
      returns: NO_RETURNS,
      net: { units: 2, revenue: 20, cost: 4, margin: 16, marginPercent: 80 },
      stock: {
        opening: NOTHING,
        received: { units: 6, value: 12 },
        left: { units: 2, value: 4 },
        closing: { units: 4, value: 8 },
        onTheWayBack: NOTHING,
      },
    });
    expect(res.json().totals).toMatchObject({
      returns: NO_RETURNS,
      net: { units: 2, revenue: 20, cost: 4, margin: 16 },
    });
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
      'product_id,product_name,category,deleted,' +
        'sold_units,sold_revenue,sold_cost,sold_margin,sold_margin_percent,' +
        'returned_units,returned_revenue,returned_cost,' +
        'net_units,net_revenue,net_cost,net_margin,net_margin_percent,' +
        'written_off_units,written_off_value,margin_after_write_offs,' +
        'margin_after_write_offs_percent,purchased_units,purchased_value,' +
        'stock_opening_units,stock_opening_value,stock_received_units,stock_received_value,' +
        'stock_left_units,stock_left_value,stock_closing_units,stock_closing_value,' +
        'stock_on_the_way_back_units,stock_on_the_way_back_value',
    );
    // every product, not a page; the most revenue of the sales first
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe(
      `${alpha.id},Alpha ${tag},${top.name},no,5,50.00,10.00,40.00,80.00,2,20.00,4.00,3,30.00,6.00,24.00,80.00,1,2.00,22.00,73.33,10,20.00,0,0.00,12,24.00,6,12.00,6,12.00,0,0.00`,
    );
    expect(lines[2]).toBe(
      `${beta.id},Beta ${tag},${child.name},no,2,40.00,10.00,30.00,75.00,0,0.00,0.00,2,40.00,10.00,30.00,75.00,0,0.00,30.00,75.00,5,25.00,0,0.00,5,25.00,2,10.00,3,15.00,0,0.00`,
    );
    expect(lines[3]).toBe(
      `${zeta.id},"Zeta, the ""quoted"" ${tag}",${child.name},no,0,0.00,0.00,0.00,,0,0.00,0.00,0,0.00,0.00,0.00,,0,0.00,0.00,,2,3.00,0,0.00,2,3.00,0,0.00,2,3.00,0,0.00`,
    );
    expect(lines[4]).toBe(
      ',Total,,,7,90.00,20.00,70.00,77.78,2,20.00,4.00,5,70.00,16.00,54.00,77.14,1,2.00,52.00,74.29,17,48.00,0,0.00,19,52.00,8,22.00,11,30.00,0,0.00',
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

    expect(res.body).toContain(`${odd.id},'=SUM(A1) ${tag},${category.name},`);
  });

  // a product with variants is ONE row, the money of its variants added up. A: 6 in at 2, 2 sold at
  // 10; B (sku): 4 in at 5, 1 sold at 30, 1 written off; C: nothing at all; D: 1 in at 3 and taken
  // out of sale
  describe('with the variants of a product', () => {
    async function productWithVariants() {
      const category = await createCategory();
      const name = `Shirt ${uniqueTag()}`;
      const product = await createProduct({ stock: 0, price: 10, categoryId: category.id, name });
      const sku = `RB-${uniqueTag()}`;
      const b = await createVariant(product.id, { price: 30, stock: 0, sku });
      const c = await createVariant(product.id, { price: 40, stock: 0 });
      const d = await createVariant(product.id, { price: 50, stock: 0 });
      await receiveBatch({ variantId: product.variantId }, { quantity: 6, unitCost: 2 });
      const batchB = await receiveBatch({ variantId: b.id }, { quantity: 4, unitCost: 5 });
      await receiveBatch({ variantId: d.id }, { quantity: 1, unitCost: 3 });
      const buyer = await newUser();
      await placeOrder(app, csrf, buyer, product, 'paid', 2);
      await placeOrder(app, csrf, buyer, { ...product, variantId: b.id }, 'paid', 1);
      await writeOffStock({ variantId: b.id }, 1, { batchId: batchB, reason: 'damaged' });
      await markVariantDeleted(d.id);
      return { category, product, name, a: product.variantId, b: b.id, c: c.id, d: d.id, sku };
    }

    const SUM = {
      sales: { units: 3, revenue: 50, cost: 9, margin: 41, marginPercent: 82 },
      returns: NO_RETURNS,
      net: { units: 3, revenue: 50, cost: 9, margin: 41, marginPercent: 82 },
      writeOffs: { units: 1, value: 5 },
      afterWriteOffs: { margin: 36, marginPercent: 72 },
      purchases: { units: 11, value: 35 },
      // 11 came in (6 at 2, 4 at 5, 1 at 3); 4 went out (2 at 2 and 1 at 5 sold, 1 at 5 written off)
      stock: {
        opening: NOTHING,
        received: { units: 11, value: 35 },
        left: { units: 4, value: 14 },
        closing: { units: 7, value: 21 },
        onTheWayBack: NOTHING,
      },
    };

    it('gives one row for the product, the money of its variants added up', async () => {
      const { category, product } = await productWithVariants();

      const res = await get('products', { ...period(), categoryId: String(category.id) });

      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([
        {
          product: { id: product.id, name: expect.any(String), deleted: false },
          category: { id: category.id, name: category.name },
          ...SUM,
        },
      ]);
      // no variant in the row of a product, the breakdown by variant has them
      expect(Object.keys(res.json().items[0])).not.toContain('variant');
    });

    it('is the sum of the rows of its variants in the breakdown by variant', async () => {
      const { category } = await productWithVariants();
      const query = { ...period(), categoryId: String(category.id) };

      const products = await get('products', query);
      const variants = await get('variants', query);

      type UnitsValue = { units: number; value: number };
      const rows = variants.json().items as Array<{
        sales: { units: number; revenue: number; cost: number };
        returns: { units: number; revenue: number; cost: number };
        net: { units: number; revenue: number; cost: number };
        writeOffs: UnitsValue;
        purchases: UnitsValue;
        stock: Record<'opening' | 'received' | 'left' | 'closing' | 'onTheWayBack', UnitsValue>;
      }>;
      expect(rows).toHaveLength(3);
      const total = (pick: (row: (typeof rows)[number]) => number) =>
        rows.reduce((sum, row) => sum + pick(row), 0);
      const [only] = products.json().items;
      expect(only.sales).toMatchObject({
        units: total((row) => row.sales.units),
        revenue: total((row) => row.sales.revenue),
        cost: total((row) => row.sales.cost),
      });
      expect(only.returns).toMatchObject({
        units: total((row) => row.returns.units),
        revenue: total((row) => row.returns.revenue),
        cost: total((row) => row.returns.cost),
      });
      expect(only.net).toMatchObject({
        units: total((row) => row.net.units),
        revenue: total((row) => row.net.revenue),
        cost: total((row) => row.net.cost),
      });
      expect(only.writeOffs).toMatchObject({
        units: total((row) => row.writeOffs.units),
        value: total((row) => row.writeOffs.value),
      });
      expect(only.purchases).toMatchObject({
        units: total((row) => row.purchases.units),
        value: total((row) => row.purchases.value),
      });
      for (const part of ['opening', 'received', 'left', 'closing', 'onTheWayBack'] as const) {
        expect(only.stock[part]).toMatchObject({
          units: total((row) => row.stock[part].units),
          value: total((row) => row.stock[part].value),
        });
      }
      expect(products.json().totals).toEqual(variants.json().totals);
    });

    it('adds the variants up in the totals, in the category and in the steps of time', async () => {
      const { category } = await productWithVariants();

      const products = await get('products', {
        ...period(),
        categoryId: String(category.id),
        limit: '1',
      });
      const categories = await get('categories', {
        ...period(),
        categoryId: String(category.id),
      });
      const timeline = await get('timeline', {
        ...period(),
        step: 'month',
        categoryId: String(category.id),
      });

      expect(products.json().totals).toMatchObject({
        sales: SUM.sales,
        returns: SUM.returns,
        net: SUM.net,
        writeOffs: SUM.writeOffs,
        afterWriteOffs: SUM.afterWriteOffs,
        purchases: SUM.purchases,
        stock: SUM.stock,
      });
      // one product, one row: the page of one holds it, there is no next one
      expect(products.json().items).toHaveLength(1);
      expect(products.json().nextCursor).toBeNull();
      expect(categories.json().items).toEqual([
        expect.objectContaining({ id: category.id, ...SUM }),
      ]);
      const months = timeline.json().items as Array<{
        sales: { revenue: number; units: number };
        purchases: { value: number };
        writeOffs: { value: number };
      }>;
      expect(months.reduce((total, item) => total + item.sales.revenue, 0)).toBe(50);
      expect(months.reduce((total, item) => total + item.sales.units, 0)).toBe(3);
      expect(months.reduce((total, item) => total + item.purchases.value, 0)).toBe(35);
      expect(months.reduce((total, item) => total + item.writeOffs.value, 0)).toBe(5);
    });

    // the products are the rows: sorted by the name of the product, the ties by the id of the product
    it('sorts the products by name, the ties by the id of the product', async () => {
      const category = await createCategory();
      const name = `Twin ${uniqueTag()}`;
      const first = await createProduct({ stock: 0, categoryId: category.id, name });
      const second = await createProduct({ stock: 0, categoryId: category.id, name });
      const other = await createProduct({ stock: 0, categoryId: category.id, name: `Aaa ${name}` });
      for (const product of [first, second, other]) {
        await receiveBatch(product.id, { quantity: 1, unitCost: 1 });
      }
      await createVariant(first.id, { stock: 1 });

      const asc = await get('products', {
        ...period(),
        categoryId: String(category.id),
        sortBy: 'name',
        sortOrder: 'asc',
      });
      const desc = await get('products', {
        ...period(),
        categoryId: String(category.id),
        sortBy: 'name',
        sortOrder: 'desc',
      });

      expect(productIdsOf(asc)).toEqual([other.id, first.id, second.id]);
      expect(productIdsOf(desc)).toEqual([second.id, first.id, other.id]);
    });

    it.each([
      ['revenue', 'desc'],
      ['name', 'asc'],
      ['name', 'desc'],
      ['marginPercent', 'asc'],
    ])('pages the products by %s %s, each product once', async (sortBy, sortOrder) => {
      const { category } = await productWithVariants();
      // a second product of the category, with a variant of its own
      const second = await createProduct({ stock: 0, price: 5, categoryId: category.id });
      await receiveBatch(second.id, { quantity: 2, unitCost: 1 });
      await placeOrder(app, csrf, await newUser(), second, 'paid', 1);
      const query = { ...period(), categoryId: String(category.id), sortBy, sortOrder };
      const whole = productIdsOf(await get('products', query));

      const seen: number[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 4; page += 1) {
        const res = await get('products', { ...query, limit: '1', ...(cursor ? { cursor } : {}) });
        expect(res.statusCode).toBe(200);
        seen.push(...productIdsOf(res));
        cursor = res.json().nextCursor;
        if (!cursor) break;
      }

      expect(whole).toHaveLength(2);
      expect(seen).toEqual(whole);
    });

    it('gives one csv row for the product', async () => {
      const { category, product, name } = await productWithVariants();

      const res = await get('products', {
        ...period(),
        categoryId: String(category.id),
        format: 'csv',
      });

      const lines = res.body
        .replace(/^\uFEFF/, '')
        .trimEnd()
        .split('\r\n');
      expect(lines).toHaveLength(3);
      expect(lines[1]).toBe(
        `${product.id},${name},${category.name},no,3,50.00,9.00,41.00,82.00,0,0.00,0.00,3,50.00,9.00,41.00,82.00,1,5.00,36.00,72.00,11,35.00,0,0.00,11,35.00,4,14.00,7,21.00,0,0.00`,
      );
      expect(lines[2]!.startsWith(',Total,,,3,50.00,')).toBe(true);
    });

    it('takes the variants it is asked for, whatever the other variants did', async () => {
      const { category, product, a, b } = await productWithVariants();
      const query = { ...period(), categoryId: String(category.id) };

      const onlyB = await get('products', { ...query, variantIds: String(b) });
      const aAndB = await get('products', { ...query, variantIds: `${a},${b}` });
      const none = await get('products', { ...query, variantIds: '2000000000' });

      expect(productIdsOf(onlyB)).toEqual([product.id]);
      expect(onlyB.json().items[0]).toMatchObject({
        sales: { units: 1, revenue: 30 },
        writeOffs: { units: 1, value: 5 },
        purchases: { units: 4, value: 20 },
        // 4 at 5 came in; the one sold and the one written off went out
        stock: {
          received: { units: 4, value: 20 },
          left: { units: 2, value: 10 },
          closing: { units: 2, value: 10 },
        },
      });
      expect(aAndB.json().items[0]).toMatchObject({ sales: { units: 3, revenue: 50 } });
      expect(none.json().items).toEqual([]);
      expect(none.json().totals).toMatchObject({
        sales: { units: 0 },
        stock: { received: NOTHING, left: NOTHING, closing: NOTHING },
      });
    });

    it('takes the products it is asked for, and the variants of those among the variants asked for', async () => {
      const { category, product, b } = await productWithVariants();
      const query = { ...period(), categoryId: String(category.id) };

      const byProduct = await get('products', { ...query, productIds: String(product.id) });
      const other = await get('products', { ...query, productIds: String(alpha.id) });
      const both = await get('products', {
        ...query,
        productIds: String(product.id),
        variantIds: String(b),
      });

      expect(productIdsOf(byProduct)).toEqual([product.id]);
      expect(other.json().items).toEqual([]);
      expect(both.json().items[0]).toMatchObject({ sales: { units: 1, revenue: 30 } });
    });
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
    ['ids that are no list', { productIds: 'a,b' }],
    ['variant ids that are no list', { variantIds: '1,,2' }],
  ])('refuses %s', async (_case, query) => {
    const res = await get('products', query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses a product id past the largest id and more than 100 product ids', async () => {
    const past = await get('products', { productIds: '2147483648' });
    const many = await get('products', {
      productIds: Array.from({ length: 101 }, (_, n) => n + 1).join(','),
    });

    for (const res of [past, many]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_IDS_INVALID' });
    }
  });

  it('refuses a variant id past the largest id and more than 100 variant ids', async () => {
    const past = await get('products', { variantIds: '2147483648' });
    const many = await get('products', {
      variantIds: Array.from({ length: 101 }, (_, n) => n + 1).join(','),
    });

    for (const res of [past, many]) {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANT_IDS_INVALID' });
    }
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
      returns: ALPHA.returns,
      net: ALPHA.net,
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
    // the revenue of the sales (70 is the net, with the return of 20 out of it)
    expect(whole.json().items[0].sales.revenue).toBe(90);
    expect(whole.json().items[0].net.revenue).toBe(70);
    expect(idsOf(own)).toEqual([top.id]);
    expect(own.json().items[0].sales.revenue).toBe(50);
    expect(own.json().items[0].net.revenue).toBe(30);
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
    // margin of the sales 40 and 30 (of the net it would be 24 and 30)
    ['margin', 'top'],
    // 80 and 75 percent
    ['marginPercent', 'top'],
    // 5 and 2 units sold
    ['units', 'top'],
    // margin of the net less the write-offs: 22 and 30 (of the sales it would be 38 and 30)
    ['marginAfterWriteOffs', 'child'],
    // 2 and nothing written off
    ['writeOffs', 'top'],
    // 20 and 28 taken in
    ['purchases', 'child'],
    // 12 and 18 left at cost (the closing stock)
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
    expect(lines[0]).toBe(
      'id,name,parent_id,' +
        'sold_units,sold_revenue,sold_cost,sold_margin,sold_margin_percent,' +
        'returned_units,returned_revenue,returned_cost,' +
        'net_units,net_revenue,net_cost,net_margin,net_margin_percent,' +
        'written_off_units,written_off_value,margin_after_write_offs,' +
        'margin_after_write_offs_percent,purchased_units,purchased_value,' +
        'stock_opening_units,stock_opening_value,stock_received_units,stock_received_value,' +
        'stock_left_units,stock_left_value,stock_closing_units,stock_closing_value,' +
        'stock_on_the_way_back_units,stock_on_the_way_back_value',
    );
    // beta and zeta: 7 came in (28), 2 sold at 20 (cost 10), 5 left (18)
    expect(lines[1]).toBe(
      `${child.id},${child.name},${top.id},2,40.00,10.00,30.00,75.00,0,0.00,0.00,2,40.00,10.00,30.00,75.00,0,0.00,30.00,75.00,7,28.00,0,0.00,7,28.00,2,10.00,5,18.00,0,0.00`,
    );
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
      returns: NO_RETURNS,
      net: NO_NET,
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
      returnShipping: { sends: 0, cost: 0, withoutCost: 0, deducted: 0, reimbursed: 0 },
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
    // the sales whole, the return of 20 apart, the net the two together
    expect(sum((item) => item.sales!.revenue!)).toBe(90);
    expect(sum((item) => item.returns!.revenue!)).toBe(20);
    expect(sum((item) => item.returns!.cost!)).toBe(4);
    expect(sum((item) => item.net!.revenue!)).toBe(70);
    expect(sum((item) => item.net!.units!)).toBe(5);
    expect(sum((item) => item.sales!.margin!)).toBe(70);
    expect(sum((item) => item.net!.margin!)).toBe(54);
    expect(sum((item) => item.writeOffs!.value!)).toBe(2);
    expect(sum((item) => item.afterWriteOffs!.margin!)).toBe(52);
    expect(sum((item) => item.purchases!.value!)).toBe(48);
    const summary = (pick: (s: Record<string, Record<string, number>>) => number) =>
      res.json().items.reduce((total: number, item: never) => total + pick(item['summary']), 0);
    // the income is the net revenue, the cost of goods the net cost
    expect(summary((s) => s.income!.items!)).toBe(70);
    expect(summary((s) => s.expenses!.costOfGoods!)).toBe(16);
    expect(summary((s) => s.expenses!.total!)).toBe(18);
    expect(summary((s) => s.margin!.total!)).toBe(52);
  });

  // a sale is in the step it was paid in and the return of it in the step its money went back in:
  // a step with a return and no sale has a negative net, and the steps add up to nothing
  it('puts a sale and the return of it into the steps they happened in', async () => {
    const category = await createCategory();
    const product = await createProduct({ stock: 0, price: 10, categoryId: category.id });
    await receiveBatch(product.id, { quantity: 5, unitCost: 4 });
    const orderId = await placeOrder(app, csrf, await newUser(), product, 'paid', 2);
    const { paidAt } = await orderRowOf(orderId);
    const { refundedAt } = await cancelAndRefund(admin.id, orderId);
    // the time of the database after the payment and the refund: the moment each is counted at
    expect(paidAt!.getTime()).toBeLessThan(refundedAt.getTime());
    const stepAt = async (at: Date) => {
      const res = await get('timeline', {
        from: at.toISOString(),
        to: new Date(at.getTime() + 1).toISOString(),
        step: 'day',
        categoryId: String(category.id),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toHaveLength(1);
      return res.json().items[0];
    };

    const ofPayment = await stepAt(paidAt!);
    const ofRefund = await stepAt(refundedAt);

    expect(ofPayment).toMatchObject({
      sales: { units: 2, revenue: 20, cost: 8, margin: 12, marginPercent: 60 },
      returns: NO_RETURNS,
      net: { units: 2, revenue: 20, cost: 8, margin: 12, marginPercent: 60 },
      summary: {
        income: { items: 20, total: 20 },
        expenses: { costOfGoods: 8, total: 8 },
        margin: { items: 12, total: 12 },
      },
    });
    expect(ofRefund).toMatchObject({
      sales: { ...NO_SALES, marginPercent: null },
      returns: { units: 2, revenue: 20, cost: 8 },
      net: { units: -2, revenue: -20, cost: -8, margin: -12 },
      afterWriteOffs: { margin: -12 },
      summary: {
        income: { items: -20, total: -20 },
        expenses: { costOfGoods: -8, total: -8 },
        margin: { items: -12, total: -12 },
      },
    });
    // a step has no stock
    expect(ofPayment).not.toHaveProperty('stock');
    expect(ofRefund).not.toHaveProperty('stock');
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
    expect(last.sales.revenue).toBe(90);
    expect(last.net.revenue).toBe(70);
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

    expect(res.json().items[0].sales.revenue).toBe(90);
    expect(res.json().items).toHaveLength(12);
  });

  // all the money of the tree is in the month of now, the other eleven have none; the margin and the
  // units are of the sales, the margin after the write-offs and the total are of the net
  it.each([
    ['margin', (row: Step) => row.sales.margin, 70],
    ['units', (row: Step) => row.sales.units, 7],
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
          'shipping_sends_without_cost,return_shipping_sends,return_shipping_cost,' +
          'return_shipping_sends_without_cost,return_shipping_deducted,return_shipping_reimbursed,' +
          'delivery_result,income_items,income_delivery,income_total,' +
          'expense_cost_of_goods,expense_write_offs,expense_shipping,expense_total,margin_items,' +
          'margin_delivery,margin_total',
      ),
    ).toBe(true);
    // the eleven of the delivery empty, the summary without its delivery and its sends
    expect(lines[1]!.endsWith(',0.00,,,,,,,,,,,,0.00,,0.00,0.00,0.00,,0.00,0.00,,0.00')).toBe(true);
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
        ',0.00,0.00,0,0.00,0,0,0.00,0,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00,0.00',
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

    // three orders were paid, the cancelled one among them
    expect(whole.json().sales).toEqual({ orders: 3, units: 7, revenue: 90, cost: 20, margin: 70 });
    expect(whole.json().returns).toEqual({
      orders: 1,
      units: 2,
      revenue: 20,
      cost: 4,
      byKind: {
        withdrawal: NO_RETURNS,
        refused: NO_RETURNS,
        defect: NO_RETURNS,
        wrong_item: NO_RETURNS,
        damaged: NO_RETURNS,
        goodwill: NO_RETURNS,
        shop_cancel: { units: 2, revenue: 20, cost: 4 },
        other: NO_RETURNS,
      },
    });
    expect(whole.json().net).toEqual(TREE.net);
    expect(whole.json().summary).toEqual({
      income: { items: 70, delivery: null, total: 70 },
      expenses: { costOfGoods: 16, writeOffs: 2, shipping: null, total: 18 },
      margin: { items: 54, delivery: null, total: 52 },
    });
    expect(whole.json().stock).toEqual(TREE.stock);
    expect(own.json().sales).toEqual({ orders: 2, units: 5, revenue: 50, cost: 10, margin: 40 });
    expect(own.json().net).toEqual(ALPHA.net);
    expect(own.json().stock).toEqual(ALPHA.stock);
  });
});
