import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  putOnSale,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';
import { placePaidOrder } from '../../../helpers/payments.js';

// two sorts of the catalog for everybody: by the discount (the products on sale first, the biggest
// discount first going desc, then the rest by popularity) and by the units sold in a period (the
// orders paid in it that were not cancelled)
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
const products: TestProduct[] = [];
const DAY = 86_400_000;

async function newProduct(opts: { price?: number; stock?: number } = {}) {
  const product = await createProduct({ price: 10, stock: 20, ...opts });
  products.push(product);
  return product;
}

async function newUser(role: TestUser['role'] = 'USER') {
  const user = await createUser({ role });
  userIds.push(user.id);
  return user;
}

const list = (query: Record<string, string>, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: `/api/products?${new URLSearchParams(query)}`,
    headers: actor ? { cookie: accessCookie(actor) } : {},
  });

const idsOf = (res: LightMyRequestResponse) =>
  (res.json().items as Array<{ id: number }>).map((item) => item.id);

// the ids of every page, walked by the cursor, two products to a page
async function walk(query: Record<string, string>, actor?: TestUser): Promise<number[]> {
  const ids: number[] = [];
  let cursor: string | undefined;
  do {
    const res = await list({ ...query, limit: '2', ...(cursor ? { cursor } : {}) }, actor);
    expect(res.statusCode).toBe(200);
    ids.push(...idsOf(res));
    cursor = res.json().nextCursor ?? undefined;
  } while (cursor);

  return ids;
}

const categoriesOf = (...of: TestProduct[]) => of.map((product) => product.categoryId).join(',');

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser('ADMIN');
});

afterAll(async () => {
  try {
    for (const product of products) await deleteProductFromCatalog(product.id);
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('GET /api/products?sort=discount', () => {
  let half: TestProduct;
  let third: TestProduct;
  let fifth: TestProduct;
  let plain: TestProduct;
  let categoryIds: string;

  // three products on sale (50, 35 and 20 percent off) and one without a sale
  beforeAll(async () => {
    [half, third, fifth, plain] = [
      await newProduct({ price: 100 }),
      await newProduct({ price: 100 }),
      await newProduct({ price: 100 }),
      await newProduct({ price: 100 }),
    ];
    await putOnSale(half.id, 50, DAY);
    await putOnSale(third.id, 65, DAY);
    await putOnSale(fifth.id, 80, DAY);
    categoryIds = categoriesOf(half, third, fifth, plain);
  });

  it.each([
    ['desc', () => [half.id, third.id, fifth.id, plain.id]],
    ['asc', () => [fifth.id, third.id, half.id, plain.id]],
  ])(
    'gives the products on sale first, going %s by the discount, then the rest',
    async (order, ids) => {
      const res = await list({ categoryIds, sort: 'discount', order });

      expect(res.statusCode).toBe(200);
      expect(idsOf(res)).toEqual(ids());
    },
  );

  it('pages through both parts of the list by the cursor', async () => {
    expect(await walk({ categoryIds, sort: 'discount', order: 'desc' })).toEqual([
      half.id,
      third.id,
      fifth.id,
      plain.id,
    ]);
    expect(await walk({ categoryIds, sort: 'discount', order: 'asc' })).toEqual([
      fifth.id,
      third.id,
      half.id,
      plain.id,
    ]);
  });

  it('is the sort of a guest, a buyer and an admin with the sale flag; an admin without it is refused', async () => {
    const buyer = await newUser();

    for (const actor of [undefined, buyer]) {
      expect(idsOf(await list({ categoryIds, sort: 'discount' }, actor))).toEqual([
        half.id,
        third.id,
        fifth.id,
        plain.id,
      ]);
    }

    // an admin lists the products on sale by their flag, the plain ones are another list
    const flagged = await list({ categoryIds, sort: 'discount', onSale: 'true' }, admin);
    expect(idsOf(flagged)).toEqual([half.id, third.id, fifth.id]);

    const refused = await list({ categoryIds, sort: 'discount' }, admin);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ errorCode: 'SORT_DISCOUNT_REQUIRES_ON_SALE' });
  });

  it('refuses a cursor of another sort', async () => {
    const page = await list({ categoryIds, sort: 'discount', limit: '1' });
    const cursor = page.json().nextCursor as string;

    const res = await list({ categoryIds, sort: 'saleEndsAt', limit: '1', cursor });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });
});

describe('GET /api/products?sort=sales', () => {
  let best: TestProduct;
  let some: TestProduct;
  let cancelled: TestProduct;
  let none: TestProduct;
  let categoryIds: string;
  let period: { salesFrom: string; salesTo: string };

  // 3 units, 1 unit, 2 units of an order cancelled afterwards, and none
  beforeAll(async () => {
    [best, some, cancelled, none] = [
      await newProduct(),
      await newProduct(),
      await newProduct(),
      await newProduct(),
    ];
    const buyer = await newUser();
    await placeOrder(app, csrf, buyer, best, 'paid', 3);
    await placeOrder(app, csrf, buyer, some, 'paid', 1);
    // a real payment: the cancel gives it back at the provider
    const { orderId } = await placePaidOrder(app, csrf, buyer, cancelled, { quantity: 2 });
    const cancel = await app.inject({
      method: 'POST',
      url: `/api/orders/${orderId}/cancel`,
      headers: withCsrf(csrf, accessCookie(admin)),
    });
    expect(cancel.statusCode).toBe(200);

    categoryIds = categoriesOf(best, some, cancelled, none);
    const now = Date.now();
    period = {
      salesFrom: new Date(now - DAY).toISOString(),
      salesTo: new Date(now + DAY).toISOString(),
    };
  });

  it('puts the best selling product first going desc, the units of a cancelled order do not count', async () => {
    const res = await list({ categoryIds, sort: 'sales', order: 'desc', ...period });

    expect(res.statusCode).toBe(200);
    // the products without a sale count tie by id, the newer first going desc
    expect(idsOf(res)).toEqual([best.id, some.id, none.id, cancelled.id]);
  });

  it('puts the least selling product first going asc', async () => {
    const res = await list({ categoryIds, sort: 'sales', order: 'asc', ...period });

    expect(idsOf(res)).toEqual([cancelled.id, none.id, some.id, best.id]);
  });

  it('pages through a fixed period by the cursor, for a guest, a buyer and an admin', async () => {
    const buyer = await newUser();

    for (const actor of [undefined, buyer, admin]) {
      expect(await walk({ categoryIds, sort: 'sales', order: 'desc', ...period }, actor)).toEqual([
        best.id,
        some.id,
        none.id,
        cancelled.id,
      ]);
    }
  });

  it('counts the days before today by default, and the orders paid in the period only', async () => {
    const byDefault = await list({ categoryIds, sort: 'sales', order: 'desc' });
    const longAgo = await list({
      categoryIds,
      sort: 'sales',
      order: 'desc',
      salesFrom: '2000-01-01T00:00:00.000Z',
      salesTo: '2000-02-01T00:00:00.000Z',
    });

    expect(idsOf(byDefault).slice(0, 2)).toEqual([best.id, some.id]);
    // nothing was sold then: every product ties at 0, the newer first
    expect(idsOf(longAgo)).toEqual([best.id, some.id, cancelled.id, none.id].sort((a, b) => b - a));
  });

  it('takes the period [from, to): an order paid before from does not count', async () => {
    const res = await list({
      categoryIds,
      sort: 'sales',
      order: 'desc',
      salesFrom: new Date(Date.now() + 60_000).toISOString(),
      salesTo: new Date(Date.now() + DAY).toISOString(),
    });

    expect(idsOf(res)).toEqual([best.id, some.id, cancelled.id, none.id].sort((a, b) => b - a));
  });

  it.each([
    [
      'a period that ends before it starts',
      { salesFrom: '2026-02-01T00:00:00Z', salesTo: '2026-01-01T00:00:00Z' },
    ],
    [
      'a period of no length',
      { salesFrom: '2026-01-01T00:00:00Z', salesTo: '2026-01-01T00:00:00Z' },
    ],
  ])('refuses %s', async (_case, query) => {
    const res = await list({ categoryIds, sort: 'sales', ...query });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'SALES_PERIOD_INVALID' });
  });

  it('refuses a text that is no date', async () => {
    const res = await list({ categoryIds, sort: 'sales', salesFrom: 'yesterday' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('ignores the period when the sort is another one', async () => {
    const res = await list({
      categoryIds,
      sort: 'createdAt',
      salesFrom: '2026-02-01T00:00:00Z',
      salesTo: '2026-01-01T00:00:00Z',
    });

    expect(res.statusCode).toBe(200);
  });
});
