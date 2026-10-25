import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { encodeCursor } from '@helpers/codeCursor.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  type TestUser,
} from '../../../helpers/factories.js';
import { imageField, pngImage } from '../../../helpers/cloudinary.js';
import { multipartBody } from '../../../helpers/multipart.js';
import { safetyFormFields } from '../../../helpers/productSafety.js';
import { moveClock } from '../../../helpers/payments.js';

// what the routes of products and categories refuse before the database fails on it: a category
// that does not exist, money past the cent or past what the column holds, a sale on a product
// taken out, a year postgres has no date for, a cursor past the ids, a code a trigger raises

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;

const MISSING = 2_000_000_000;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
});

// the products stay: a change of a price writes the price log, and a product with a log cannot be
// deleted; the test database goes after the run
afterAll(async () => {
  try {
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  return createProduct({ price: 20, ...opts });
};

const patchProduct = (productId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

const adminGet = (url: string) =>
  app.inject({ method: 'GET', url, headers: { cookie: accessCookie(admin) } });

// the category of a product is a choice of the page: a stale one failed with 500
describe('a category that does not exist', () => {
  it('is 404 CATEGORY_NOT_FOUND for a new product', async () => {
    const { payload, headers } = multipartBody([
      { name: 'name', value: 'No category product' },
      { name: 'price', value: '10' },
      { name: 'categoryId', value: String(MISSING) },
      ...safetyFormFields(),
      imageField('images', pngImage(30, 20)),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { ...withCsrf(csrf, accessCookie(admin)), ...headers },
      payload,
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_NOT_FOUND' });
  });

  it('is 404 CATEGORY_NOT_FOUND for a change of a product', async () => {
    const product = await newProduct();

    const res = await patchProduct(product.id, { categoryId: MISSING });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_NOT_FOUND' });
  });

  it('is 404 CATEGORY_NOT_FOUND for the move of a product to a category', async () => {
    const product = await newProduct();

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/products/${product.id}/category`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: { categoryId: MISSING },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_NOT_FOUND' });
  });
});

describe('money', () => {
  // 10.004 went through as more than 10.00, the database kept 10.00 and ended the sale
  it.each([
    ['past the cent', 10.004],
    ['past what the column holds', 100_000_000],
  ])('refuses a price %s', async (_case, price) => {
    const product = await newProduct();

    const res = await patchProduct(product.id, { price });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('takes the highest price the column holds', async () => {
    const product = await newProduct();

    const res = await patchProduct(product.id, { price: 99_999_999.99 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ price: 99_999_999.99 });
  });
});

describe('a sale through the change of a product', () => {
  it('is 404 for a product taken out of the catalog, as on the route of the sale', async () => {
    const product = await newProduct();
    await deleteProductFromCatalog(product.id);

    const res = await patchProduct(product.id, {
      price: 30,
      sale: { percent: 10, endsAt: new Date(Date.now() + 86_400_000).toISOString() },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  // an end just ahead by the clock of the server and already behind by the one of the database:
  // the trigger refused it and the route answered 500
  it('answers the end the database refuses the way the route of the sale does', async () => {
    const product = await newProduct();
    const endsAt = new Date(Date.now() - 30_000).toISOString();
    const clock = moveClock(-60_000);

    try {
      const res = await patchProduct(product.id, { price: 30, sale: { percent: 10, endsAt } });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID' });
    } finally {
      clock.restore();
    }
  });
});

// postgres has no year 0, and no id past the int: both failed with 500
describe('values the database has no room for', () => {
  it.each([
    ['the stats', '/api/admin/stats?from=0000-01-01T00:00:00.000Z'],
    ['the journal of the stock', '/api/admin/stock/movements?from=0000-01-01T00:00:00.000Z'],
    ['the batches', '/api/admin/stock/batches?expiresBy=0000-01-01'],
  ])('refuses the year 0 in %s', async (_case, url) => {
    const res = await adminGet(url);

    expect(res.statusCode).toBe(400);
  });

  it('refuses a cursor with an id past the ids of the database', async () => {
    const cursor = encodeCursor({ id: 9_999_999_999, v: null });

    const res = await adminGet(`/api/admin/stock/batches?cursor=${cursor}`);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CURSOR_INVALID' });
  });
});

// the new category named itself its parent: the id it gets is the one the page sent
describe('POST /api/categories', () => {
  it('answers a parent that is the new category itself with 409, as the change of a category does', async () => {
    let refused = false;

    for (let attempt = 0; attempt < 5 && !refused; attempt += 1) {
      const [{ next }] = await asAdmin(
        (tx) =>
          tx.$queryRaw<{ next: number }[]>`
          select (last_value + case when is_called then 1 else 0 end)::int as next
          from cartlify.categories_id_seq
        `,
      );
      const tag = `${Date.now()}-${attempt}`;

      const res = await app.inject({
        method: 'POST',
        url: '/api/categories',
        headers: withCsrf(csrf, accessCookie(admin)),
        payload: { name: `Own parent ${tag}`, slug: `own-parent-${tag}`, parentId: next },
      });

      // another file took the id meanwhile: the parent is a category of it, or one not made yet
      expect([201, 409, 422]).toContain(res.statusCode);
      if (res.statusCode === 409) {
        expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_PARENT_CYCLE' });
        refused = true;
      }
    }

    expect(refused).toBe(true);
  });
});
