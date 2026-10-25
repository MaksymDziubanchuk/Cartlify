import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  putOnSale,
  type TestUser,
} from '../../../helpers/factories.js';
import { placeOrder } from '../../../helpers/orders.js';

// the products of an admin with few free units (maxStock): like the other flags of an admin it
// lists every product of the catalog with its condition, on sale or with an override too, and
// leaves the deleted ones out; the free units are the stock less the reserve and the units of the
// batches that are over, the number the list shows as stock. The alerts of low stock and no stock
// send an admin to it. A test looks at the products of a category of its own

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

const list = (query: Record<string, string>, actor: TestUser = admin) =>
  app.inject({
    method: 'GET',
    url: `/api/products?${new URLSearchParams(query)}`,
    headers: { cookie: accessCookie(actor) },
  });

const idsOf = (res: LightMyRequestResponse) =>
  (res.json().items as Array<{ id: number }>).map((item) => item.id);

describe('GET /api/products with maxStock', () => {
  it('lists every product of the catalog with free units up to the number, the fewest first', async () => {
    const { id: categoryId } = await createCategory();
    const none = await createProduct({ categoryId, price: 10, stock: 0 });
    const two = await createProduct({ categoryId, price: 10, stock: 2 });
    const onSale = await createProduct({ categoryId, price: 10, stock: 1 });
    await putOnSale(onSale.id, 5);
    const three = await createProduct({ categoryId, price: 10, stock: 3 });
    const deleted = await createProduct({ categoryId, price: 10, stock: 1 });
    await deleteProductFromCatalog(deleted.id);

    const res = await list({
      categoryIds: String(categoryId),
      maxStock: '2',
      sort: 'stock',
      order: 'asc',
    });

    expect(res.statusCode).toBe(200);
    expect(idsOf(res)).toEqual([none.id, onSale.id, two.id]);
    expect(idsOf(res)).not.toContain(three.id);
  });

  it('takes the units the orders hold as not free', async () => {
    const { id: categoryId } = await createCategory();
    const product = await createProduct({ categoryId, price: 10, stock: 4 });
    await placeOrder(app, csrf, await createUser(), product, 'waiting', 3);

    const res = await list({ categoryIds: String(categoryId), maxStock: '1' });

    expect(idsOf(res)).toEqual([product.id]);
  });

  it('lists only the products with some free units with inStock', async () => {
    const { id: categoryId } = await createCategory();
    await createProduct({ categoryId, price: 10, stock: 0 });
    const few = await createProduct({ categoryId, price: 10, stock: 2 });

    const res = await list({ categoryIds: String(categoryId), maxStock: '5', inStock: 'true' });

    expect(idsOf(res)).toEqual([few.id]);
  });

  it('refuses a buyer', async () => {
    const buyer = await createUser();
    userIds.push(buyer.id);

    const res = await list({ maxStock: '2' }, buyer);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      errorCode: 'FILTER_FORBIDDEN',
      details: { filter: 'maxStock' },
    });
  });

  it.each(['-1', '1.5', 'few'])('refuses maxStock=%s', async (maxStock) => {
    const res = await list({ maxStock });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});
