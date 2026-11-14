import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { setUserContext } from '@db/dbContext.service.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
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
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';
import { cancelAndRefund } from '../../../helpers/returns.js';
import { markVariantDeleted } from '../../../helpers/variants.js';

// GET /api/admin/reports/accounting/variants: the money of a period by variant, a row for each
// variant of the filter with its product (the report by product, /products, adds the variants of a
// product up: reportBreakdowns.test.ts). The columns, the filters, the sorts, the pages and the csv
// file are those of the report by product, with the variant named in every row: the sales, the
// returns whose money went back, the net, the write-offs, the purchases and the stock (opening,
// received, left, closing). Other test files make orders and batches at the same time, so each
// test reads only its own categories

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const get = (path: 'variants' | 'products', query: Record<string, string>, actor = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/reports/accounting/${path}?${new URLSearchParams(query)}`,
    headers: { cookie: accessCookie(actor) },
  });

let startedAt: number;

const period = () => ({
  from: new Date(startedAt - 60_000).toISOString(),
  to: new Date(Date.now() + 60_000).toISOString(),
});

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser({ role: 'ADMIN' });
  root = await newUser({ role: 'ROOT' });
  startedAt = Date.now();
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

type UnitsValue = { units: number; value: number };
type Money = {
  sales: { units: number; revenue: number; cost: number; margin: number };
  returns: { units: number; revenue: number; cost: number };
  net: { units: number; revenue: number; cost: number; margin: number };
  writeOffs: UnitsValue;
  purchases: UnitsValue;
  stock: Record<'opening' | 'received' | 'left' | 'closing' | 'onTheWayBack', UnitsValue>;
};
type VariantRow = {
  product: { id: number; name: string; deleted: boolean };
  variant: { id: number; position: number; name: string; sku: string | null; deleted: boolean };
  category: { id: number; name: string };
} & Money;

const variantIdsOf = (res: { json: () => { items: VariantRow[] } }) =>
  res.json().items.map((row) => row.variant.id);
const productIdsOf = (res: { json: () => { items: Array<{ product: { id: number } }> } }) =>
  res.json().items.map((row) => row.product.id);

const withoutMark = (body: string) => (body.charCodeAt(0) === 0xfeff ? body.slice(1) : body);

const csvLines = (body: string) => withoutMark(body).trimEnd().split(String.fromCharCode(13, 10));

// a product with variants. A: 6 in at 2, 2 sold at 10; B (sku): 4 in at 5, 1 sold at 30, 1 written
// off; C: nothing at all; D: 1 in at 3 and taken out of sale
async function productWithVariants() {
  const category = await createCategory();
  const name = `Shirt ${uniqueTag()}`;
  const product = await createProduct({ stock: 0, price: 10, categoryId: category.id, name });
  const sku = `RV-${uniqueTag()}`;
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

describe('GET /api/admin/reports/accounting/variants', () => {
  it('gives a row for each variant, the product named in every row, the one with no money left out', async () => {
    const { category, product, name, a, b, c, d, sku } = await productWithVariants();

    const res = await get('variants', { ...period(), categoryId: String(category.id) });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ currency: 'eur', limit: 20, nextCursor: null });
    const items = res.json().items as VariantRow[];
    // the variant with the most revenue first; C has nothing in the period and nothing left
    expect(items.map((row) => row.variant.id)).toEqual([b, a, d]);
    expect(items.map((row) => row.product.id)).toEqual([product.id, product.id, product.id]);
    expect(items.map((row) => row.variant.id)).not.toContain(c);
    expect(items[0]!.product).toEqual({ id: product.id, name, deleted: false });
    expect(items[0]!.variant).toMatchObject({ id: b, position: 2, sku, deleted: false });
    expect(items[1]!.variant).toMatchObject({ id: a, position: 1, sku: null, deleted: false });
    expect(items[2]!.variant).toMatchObject({ id: d, position: 4, deleted: true });
    // the product of a variant taken out of sale is still in the catalog
    expect(items[2]!.product.deleted).toBe(false);
    expect(items[0]!.category).toEqual({ id: category.id, name: category.name });
    expect(items[0]).toMatchObject({
      sales: { units: 1, revenue: 30, cost: 5, margin: 25, marginPercent: 83.33 },
      returns: { units: 0, revenue: 0, cost: 0 },
      net: { units: 1, revenue: 30, cost: 5, margin: 25, marginPercent: 83.33 },
      writeOffs: { units: 1, value: 5 },
      afterWriteOffs: { margin: 20, marginPercent: 66.67 },
      purchases: { units: 4, value: 20 },
      // 4 at 5 came in; the one sold and the one written off went out
      stock: {
        opening: { units: 0, value: 0 },
        received: { units: 4, value: 20 },
        left: { units: 2, value: 10 },
        closing: { units: 2, value: 10 },
        onTheWayBack: { units: 0, value: 0 },
      },
    });
    expect(items[1]).toMatchObject({
      sales: { units: 2, revenue: 20, cost: 4, margin: 16, marginPercent: 80 },
      purchases: { units: 6, value: 12 },
      stock: {
        received: { units: 6, value: 12 },
        left: { units: 2, value: 4 },
        closing: { units: 4, value: 8 },
      },
    });
    // the units of a variant taken out of sale stay in its stock until they are written off
    expect(items[2]).toMatchObject({
      sales: { units: 0, revenue: 0 },
      purchases: { units: 1, value: 3 },
      stock: {
        received: { units: 1, value: 3 },
        left: { units: 0, value: 0 },
        closing: { units: 1, value: 3 },
      },
    });
  });

  it('gives the totals of every variant of the filter, whatever the page', async () => {
    const { category } = await productWithVariants();

    const res = await get('variants', {
      ...period(),
      categoryId: String(category.id),
      limit: '1',
    });

    expect(res.json().items).toHaveLength(1);
    expect(res.json().nextCursor).not.toBeNull();
    expect(res.json().totals).toMatchObject({
      sales: { units: 3, revenue: 50, cost: 9, margin: 41, marginPercent: 82 },
      returns: { units: 0, revenue: 0, cost: 0 },
      net: { units: 3, revenue: 50, cost: 9, margin: 41, marginPercent: 82 },
      writeOffs: { units: 1, value: 5 },
      afterWriteOffs: { margin: 36, marginPercent: 72 },
      purchases: { units: 11, value: 35 },
      // 11 came in (6 at 2, 4 at 5, 1 at 3); 4 went out (2 at 2 and 1 at 5 sold, 1 at 5 written off)
      stock: {
        opening: { units: 0, value: 0 },
        received: { units: 11, value: 35 },
        left: { units: 4, value: 14 },
        closing: { units: 7, value: 21 },
        onTheWayBack: { units: 0, value: 0 },
      },
    });
  });

  // the report by product adds the variants of a product up, so the two agree
  it('adds up to the rows of the report by product and to its totals', async () => {
    const first = await productWithVariants();
    const category = first.category;
    const second = await createProduct({ stock: 0, price: 5, categoryId: category.id });
    await receiveBatch(second.id, { quantity: 3, unitCost: 1 });
    await placeOrder(app, csrf, await newUser(), second, 'paid', 2);
    const query = { ...period(), categoryId: String(category.id) };

    const variants = await get('variants', query);
    const products = await get('products', query);

    expect(variants.statusCode).toBe(200);
    expect(products.statusCode).toBe(200);
    const rows = variants.json().items as VariantRow[];
    const sumOf = (productId: number, pick: (row: VariantRow) => number) =>
      rows.filter((row) => row.product.id === productId).reduce((sum, row) => sum + pick(row), 0);
    for (const item of products.json().items as Array<{ product: { id: number } } & Money>) {
      const id = item.product.id;
      expect(item.sales.units).toBe(sumOf(id, (row) => row.sales.units));
      expect(item.sales.revenue).toBeCloseTo(
        sumOf(id, (row) => row.sales.revenue),
        2,
      );
      expect(item.sales.cost).toBeCloseTo(
        sumOf(id, (row) => row.sales.cost),
        2,
      );
      expect(item.writeOffs.value).toBeCloseTo(
        sumOf(id, (row) => row.writeOffs.value),
        2,
      );
      expect(item.purchases.value).toBeCloseTo(
        sumOf(id, (row) => row.purchases.value),
        2,
      );
      expect(item.returns.units).toBe(sumOf(id, (row) => row.returns.units));
      expect(item.net.units).toBe(sumOf(id, (row) => row.net.units));
      expect(item.net.revenue).toBeCloseTo(
        sumOf(id, (row) => row.net.revenue),
        2,
      );
      for (const part of ['opening', 'received', 'left', 'closing', 'onTheWayBack'] as const) {
        expect(item.stock[part].units).toBe(sumOf(id, (row) => row.stock[part].units));
        expect(item.stock[part].value).toBeCloseTo(
          sumOf(id, (row) => row.stock[part].value),
          2,
        );
      }
    }
    expect(products.json().items).toHaveLength(2);
    expect(rows.length).toBeGreaterThan(products.json().items.length);
    expect(variants.json().totals).toEqual(products.json().totals);
  });

  // the return of a sale is in the row of the variant it was sold from: the sales stay whole, the
  // net is the sales less the return, and the units that came back are in the stock again. A: 4 in
  // at 2, 2 sold at 10 and taken back with the money; B: 2 in at 3, 1 sold at 10 and kept. The sort
  // by the margin is by the sales (A 16, B 7), the one after the write-offs is by the net (A 0, B 7)
  it('counts a refunded return in the row of its variant, and sorts by the sales or by the net as asked', async () => {
    const category = await createCategory();
    const product = await createProduct({ stock: 0, price: 10, categoryId: category.id });
    const second = await createVariant(product.id, { price: 10, stock: 0 });
    await receiveBatch({ variantId: product.variantId }, { quantity: 4, unitCost: 2 });
    await receiveBatch({ variantId: second.id }, { quantity: 2, unitCost: 3 });
    const buyer = await newUser();
    const returned = await placeOrder(app, csrf, buyer, product, 'paid', 2);
    await placeOrder(app, csrf, buyer, { ...product, variantId: second.id }, 'paid', 1);
    await cancelAndRefund(admin.id, returned);
    const query = { ...period(), categoryId: String(category.id) };

    const byRevenue = await get('variants', query);
    const byMargin = await get('variants', { ...query, sortBy: 'margin', sortOrder: 'desc' });
    const byNet = await get('variants', {
      ...query,
      sortBy: 'marginAfterWriteOffs',
      sortOrder: 'desc',
    });

    expect(variantIdsOf(byRevenue)).toEqual([product.variantId, second.id]);
    expect(variantIdsOf(byMargin)).toEqual([product.variantId, second.id]);
    expect(variantIdsOf(byNet)).toEqual([second.id, product.variantId]);
    const [first, other] = byRevenue.json().items as VariantRow[];
    expect(first).toMatchObject({
      sales: { units: 2, revenue: 20, cost: 4, margin: 16, marginPercent: 80 },
      returns: { units: 2, revenue: 20, cost: 4 },
      net: { units: 0, revenue: 0, cost: 0, margin: 0, marginPercent: null },
      afterWriteOffs: { margin: 0, marginPercent: null },
      purchases: { units: 4, value: 8 },
      // the 2 that came back are received again, the 2 sold are left: all 4 are on the shelf
      stock: {
        opening: { units: 0, value: 0 },
        received: { units: 6, value: 12 },
        left: { units: 2, value: 4 },
        closing: { units: 4, value: 8 },
        onTheWayBack: { units: 0, value: 0 },
      },
    });
    expect(other).toMatchObject({
      sales: { units: 1, revenue: 10, cost: 3, margin: 7, marginPercent: 70 },
      returns: { units: 0, revenue: 0, cost: 0 },
      net: { units: 1, revenue: 10, cost: 3, margin: 7, marginPercent: 70 },
      stock: {
        received: { units: 2, value: 6 },
        left: { units: 1, value: 3 },
        closing: { units: 1, value: 3 },
      },
    });
    expect(byRevenue.json().totals).toMatchObject({
      sales: { units: 3, revenue: 30, cost: 7, margin: 23, marginPercent: 76.67 },
      returns: { units: 2, revenue: 20, cost: 4 },
      net: { units: 1, revenue: 10, cost: 3, margin: 7, marginPercent: 70 },
      stock: { closing: { units: 5, value: 11 } },
    });
  });

  // money given back by hand in the dashboard of the provider for one unit (the event writes it, root
  // says what it was for): the return of the item in the period of the decision, money without units;
  // the whole order comes back later, its transfer takes those 10
  // first, and the report counts the money once
  it('counts money already with the buyer as the return of its item when decided, and a later return of it never twice', async () => {
    const category = await createCategory();
    const product = await createProduct({ stock: 0, price: 10, categoryId: category.id });
    await receiveBatch({ variantId: product.variantId }, { quantity: 2, unitCost: 2 });
    const buyer = await newUser();
    const orderId = await placeOrder(app, csrf, buyer, product, 'paid', 2);
    await asAdmin(async (tx) => {
      const order = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { paymentId: true, items: { select: { id: true } } },
      });
      const [hand] = await tx.$queryRaw<{ result: { id: number } }[]>`
        select cartlify.record_hand_refund(
          'stripe'::cartlify."PaymentProvider", ${order.paymentId}, ${`re_hand_${orderId}`}, 10,
          'succeeded', 'eur'
        ) as result
      `;
      await setUserContext(tx, { userId: root.id, role: 'ROOT' });
      await tx.$queryRaw`
        select cartlify.decide_money_use(
          ${hand!.result.id}::int,
          ${JSON.stringify([{ orderItemId: order.items[0]!.id, quantity: 1, amount: 10 }])}::jsonb,
          0,
          'For one of the units.'
        ) as result
      `;
    });
    const query = { ...period(), categoryId: String(category.id) };

    const decided = (await get('variants', query)).json().items as VariantRow[];
    await cancelAndRefund(admin.id, orderId);
    const back = (await get('variants', query)).json().items as VariantRow[];

    expect(decided[0]!.returns).toMatchObject({ units: 0, revenue: 10 });
    expect(back[0]!.returns).toMatchObject({ units: 2, revenue: 20, cost: 4 });
    expect(back[0]!.net).toMatchObject({ units: 0, revenue: 0 });
  });

  it('keeps to the own products of the category without its branch', async () => {
    const top = await createCategory();
    const child = await createCategory({ parentId: top.id });
    const own = await createProduct({ stock: 0, categoryId: top.id });
    const below = await createProduct({ stock: 0, categoryId: child.id });
    for (const product of [own, below])
      await receiveBatch(product.id, { quantity: 1, unitCost: 1 });

    const withBranch = await get('variants', { ...period(), categoryId: String(top.id) });
    const without = await get('variants', {
      ...period(),
      categoryId: String(top.id),
      branch: 'false',
    });

    expect(variantIdsOf(withBranch).sort((x, y) => x - y)).toEqual(
      [own.variantId, below.variantId].sort((x, y) => x - y),
    );
    expect(variantIdsOf(without)).toEqual([own.variantId]);
  });

  it('takes the variants of the products it is asked for, the variants it is asked for, or both', async () => {
    const { category, product, a, b, d } = await productWithVariants();
    const other = await createProduct({ stock: 0, categoryId: category.id });
    await receiveBatch(other.id, { quantity: 1, unitCost: 1 });
    const query = { ...period(), categoryId: String(category.id) };

    const byProduct = await get('variants', { ...query, productIds: String(product.id) });
    const byVariant = await get('variants', { ...query, variantIds: `${a},${other.variantId}` });
    const both = await get('variants', {
      ...query,
      productIds: String(product.id),
      variantIds: `${a},${b},${other.variantId}`,
    });

    // C has nothing in the period and nothing left; D is out of sale and has stock
    expect(variantIdsOf(byProduct).sort((x, y) => x - y)).toEqual([a, b, d].sort((x, y) => x - y));
    expect(productIdsOf(byProduct).every((id) => id === product.id)).toBe(true);
    expect(variantIdsOf(byVariant).sort((x, y) => x - y)).toEqual(
      [a, other.variantId].sort((x, y) => x - y),
    );
    // both: the variants of those products that are among the variants asked for
    expect(variantIdsOf(both).sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
    expect(both.json().totals.sales.units).toBe(3);
  });

  it.each([
    ['margin', 'desc', ['b', 'a', 'd']],
    ['margin', 'asc', ['d', 'a', 'b']],
    ['units', 'desc', ['a', 'b', 'd']],
    ['marginPercent', 'desc', ['b', 'a', 'd']],
    ['marginPercent', 'asc', ['a', 'b', 'd']],
    // B: 25 less the 5 written off is 20, A: 16, D: nothing
    ['marginAfterWriteOffs', 'desc', ['b', 'a', 'd']],
    // nothing written off: the ties come by the id of the variant, the later first going down
    ['writeOffs', 'desc', ['b', 'd', 'a']],
    // 20, 12 and 3 taken in at cost; 10, 8 and 3 left at cost (the closing stock)
    ['purchases', 'desc', ['b', 'a', 'd']],
    ['stockValue', 'desc', ['b', 'a', 'd']],
    ['stockUnits', 'asc', ['d', 'b', 'a']],
  ] as const)('sorts by %s %s', async (sortBy, sortOrder, expected) => {
    const { category, a, b, d } = await productWithVariants();
    const ids = { a, b, d };

    const res = await get('variants', {
      ...period(),
      categoryId: String(category.id),
      sortBy,
      sortOrder,
    });

    expect(res.statusCode).toBe(200);
    expect(variantIdsOf(res)).toEqual(expected.map((key) => ids[key]));
  });

  it('keeps the variants of one product together when sorted by name, the ties by the id of the variant', async () => {
    const { category, a, b, d } = await productWithVariants();

    const asc = await get('variants', {
      ...period(),
      categoryId: String(category.id),
      sortBy: 'name',
      sortOrder: 'asc',
    });
    const desc = await get('variants', {
      ...period(),
      categoryId: String(category.id),
      sortBy: 'name',
      sortOrder: 'desc',
    });

    expect(variantIdsOf(asc)).toEqual([a, b, d].sort((x, y) => x - y));
    expect(variantIdsOf(desc)).toEqual([a, b, d].sort((x, y) => y - x));
  });

  it.each([
    ['revenue', 'desc'],
    ['name', 'asc'],
    ['name', 'desc'],
    ['marginPercent', 'asc'],
  ])('pages the variants by %s %s, each variant once', async (sortBy, sortOrder) => {
    const { category } = await productWithVariants();
    const query = { ...period(), categoryId: String(category.id), sortBy, sortOrder };
    const whole = variantIdsOf(await get('variants', query));

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const res = await get('variants', { ...query, limit: '1', ...(cursor ? { cursor } : {}) });
      expect(res.statusCode).toBe(200);
      seen.push(...variantIdsOf(res));
      cursor = res.json().nextCursor;
      if (!cursor) break;
    }

    expect(whole).toHaveLength(3);
    expect(seen).toEqual(whole);
  });

  it('refuses a cursor of another sort', async () => {
    const { category } = await productWithVariants();
    const first = await get('variants', {
      ...period(),
      categoryId: String(category.id),
      limit: '1',
    });

    const res = await get('variants', {
      ...period(),
      categoryId: String(category.id),
      sortBy: 'name',
      cursor: first.json().nextCursor,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });

  // the cursor of the report by product names the id of a product, this one the id of a variant
  it('refuses a cursor of the report by product', async () => {
    const { category } = await productWithVariants();
    const other = await createProduct({ stock: 0, categoryId: category.id });
    await receiveBatch(other.id, { quantity: 1, unitCost: 1 });
    const first = await get('products', {
      ...period(),
      categoryId: String(category.id),
      limit: '1',
    });
    expect(first.json().nextCursor).not.toBeNull();

    const res = await get('variants', {
      ...period(),
      categoryId: String(category.id),
      cursor: first.json().nextCursor,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });

  it('lists the variants of a product removed from the catalog with what they sold', async () => {
    const category = await createCategory();
    const gone = await createProduct({ stock: 0, price: 10, categoryId: category.id });
    await receiveBatch(gone.id, { quantity: 1, unitCost: 4 });
    await placeOrder(app, csrf, await newUser(), gone, 'paid');
    await deleteProductFromCatalog(gone.id);

    const res = await get('variants', { ...period(), categoryId: String(category.id) });

    expect(res.json().items).toEqual([
      expect.objectContaining({
        product: expect.objectContaining({ id: gone.id, deleted: true }),
        // the variants of a product taken out of the catalog are out of sale
        variant: expect.objectContaining({ id: gone.variantId, deleted: true }),
        sales: expect.objectContaining({ revenue: 10 }),
      }),
    ]);
  });

  it('gives the accountant a csv file with a row for each variant, the totals last', async () => {
    const { category, product, name, a, b, d, sku } = await productWithVariants();

    const res = await get('variants', {
      ...period(),
      categoryId: String(category.id),
      format: 'csv',
      limit: '1',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(
      /^attachment; filename="accounting-variants-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    const lines = csvLines(res.body);
    expect(lines[0]).toBe(
      'product_id,product_name,variant_id,variant_name,sku,category,deleted,variant_deleted,' +
        'sold_units,sold_revenue,sold_cost,sold_margin,sold_margin_percent,' +
        'returned_units,returned_revenue,returned_cost,' +
        'net_units,net_revenue,net_cost,net_margin,net_margin_percent,' +
        'written_off_units,written_off_value,margin_after_write_offs,' +
        'margin_after_write_offs_percent,purchased_units,purchased_value,' +
        'stock_opening_units,stock_opening_value,stock_received_units,stock_received_value,' +
        'stock_left_units,stock_left_value,stock_closing_units,stock_closing_value,' +
        'stock_on_the_way_back_units,stock_on_the_way_back_value',
    );
    // every variant, not a page
    expect(lines).toHaveLength(5);
    const cells = (line: string) => line.split(',');
    expect(cells(lines[1]!).slice(0, 2)).toEqual([String(product.id), name]);
    expect(cells(lines[1]!)[2]).toBe(String(b));
    expect(cells(lines[1]!)[4]).toBe(sku);
    expect(cells(lines[2]!)[2]).toBe(String(a));
    expect(cells(lines[2]!)[4]).toBe('');
    // the variant taken out of sale is told in its own column, its product is in the catalog
    expect(cells(lines[3]!)[2]).toBe(String(d));
    expect(cells(lines[3]!)[6]).toBe('no');
    expect(cells(lines[3]!)[7]).toBe('yes');
    expect(lines[4]).toBe(
      ',Total,,,,,,,3,50.00,9.00,41.00,82.00,0,0.00,0.00,3,50.00,9.00,41.00,82.00,1,5.00,36.00,72.00,11,35.00,0,0.00,11,35.00,4,14.00,7,21.00,0,0.00',
    );
  });

  it('keeps a name that looks like a formula as text in the csv', async () => {
    const category = await createCategory();
    const odd = await createProduct({
      stock: 0,
      categoryId: category.id,
      name: `=SUM(A1) ${uniqueTag()}`,
    });
    await receiveBatch(odd.id, { quantity: 1, unitCost: 1 });

    const res = await get('variants', {
      ...period(),
      categoryId: String(category.id),
      format: 'csv',
    });

    expect(res.body).toContain(`${odd.id},'=SUM(A1)`);
  });

  it('answers 404 for a category that does not exist', async () => {
    const res = await get('variants', { categoryId: '2000000000' });

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
    const res = await get('variants', query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('refuses ids past the largest id and more than 100 ids', async () => {
    const hundred = Array.from({ length: 101 }, (_, n) => n + 1).join(',');

    for (const [query, errorCode] of [
      [{ productIds: '2147483648' }, 'PRODUCT_IDS_INVALID'],
      [{ productIds: hundred }, 'PRODUCT_IDS_INVALID'],
      [{ variantIds: '2147483648' }, 'VARIANT_IDS_INVALID'],
      [{ variantIds: hundred }, 'VARIANT_IDS_INVALID'],
    ] as const) {
      const res = await get('variants', query);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode });
    }
  });

  it('lets root read it, and refuses a user and a guest', async () => {
    const root = await get('variants', {}, await newUser({ role: 'ROOT' }));
    const user = await get('variants', {}, await newUser());
    const guest = await app.inject({
      method: 'GET',
      url: '/api/admin/reports/accounting/variants',
    });

    expect(root.statusCode).toBe(200);
    expect(user.statusCode).toBe(403);
    expect(user.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
    expect(guest.statusCode).toBe(403);
  });
});
