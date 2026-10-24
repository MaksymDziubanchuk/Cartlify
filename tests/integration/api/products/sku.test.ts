import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  stockOf,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import { imageField, pngImage } from '../../../helpers/cloudinary.js';
import { multipartBody } from '../../../helpers/multipart.js';
import { safetyFormFields } from '../../../helpers/productSafety.js';

// the article number of a product (sku): optional, any signs up to 64, one product of the catalog
// has it at a time; an admin finds a product by it and takes in or writes off goods by it, the way
// the papers of a supplier name them

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

const sku = () => `SKU-${uniqueTag()}`;

const patch = (productId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

const post = (path: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/api/products/stock/${path}`,
    headers: withCsrf(csrf, accessCookie(admin)),
    payload,
  });

describe('the article number of a product', () => {
  it('comes with a new product from the form and shows in the card of a buyer and of an admin', async () => {
    const code = sku();
    const product = await createProduct({ price: 10 });
    const { payload, headers } = multipartBody([
      { name: 'name', value: `Sku product ${uniqueTag()}` },
      { name: 'price', value: '10' },
      { name: 'categoryId', value: String(product.categoryId) },
      { name: 'sku', value: ` ${code} ` },
      ...safetyFormFields(),
      imageField('images', pngImage(30, 20)),
    ]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/products',
      headers: { ...withCsrf(csrf, accessCookie(admin)), ...headers },
      payload,
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ sku: code });
    const card = await app.inject({ method: 'GET', url: `/api/products/${res.json().id}` });
    expect(card.json()).toMatchObject({ sku: code });
  });

  it('changes with the product and goes with an empty value', async () => {
    const product = await createProduct({ price: 10 });
    const code = sku();

    expect((await patch(product.id, { sku: code })).json()).toMatchObject({ sku: code });
    expect((await patch(product.id, { sku: '' })).json()).toMatchObject({ sku: null });
  });

  it('takes any signs and refuses more than 64', async () => {
    const product = await createProduct({ price: 10 });
    const code = `АБ/12 #${uniqueTag()}`;

    expect((await patch(product.id, { sku: code })).json()).toMatchObject({ sku: code });
    const long = await patch(product.id, { sku: 'x'.repeat(65) });
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // an article number names one product: the papers of a delivery could not tell two apart
  it('belongs to one product of the catalog at a time', async () => {
    const code = sku();
    const first = await createProduct({ price: 10 });
    const second = await createProduct({ price: 10 });
    await patch(first.id, { sku: code });

    const taken = await patch(second.id, { sku: code });

    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ errorCode: 'PRODUCT_SKU_TAKEN' });

    // a product taken out of the catalog lets it go
    await deleteProductFromCatalog(first.id);
    expect((await patch(second.id, { sku: code })).statusCode).toBe(200);
  });

  // SKU-1 and sku-1 are one number on the papers of a supplier
  it('is one number whatever the case of its letters', async () => {
    const code = sku();
    const first = await createProduct({ price: 10 });
    const second = await createProduct({ price: 10 });
    await patch(first.id, { sku: code });

    const taken = await patch(second.id, { sku: code.toLowerCase() });

    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ errorCode: 'PRODUCT_SKU_TAKEN' });
  });

  // a product taken out let its number go: another one may have it now
  it('stops the product coming back while another product of the catalog has its number', async () => {
    const code = sku();
    const old = await createProduct({ price: 10 });
    await patch(old.id, { sku: code });
    await deleteProductFromCatalog(old.id);
    const current = await createProduct({ price: 10 });
    await patch(current.id, { sku: code });

    const res = await app.inject({
      method: 'POST',
      url: `/api/products/${old.id}/restore`,
      headers: withCsrf(csrf, accessCookie(admin)),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SKU_TAKEN' });
  });

  it('finds the product in the search of an admin and of a buyer', async () => {
    const code = sku();
    const product = await createProduct({ price: 10 });
    await patch(product.id, { sku: code });

    for (const cookie of ['', accessCookie(admin)]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/products?search=${encodeURIComponent(code)}`,
        headers: cookie ? { cookie } : {},
      });

      expect(res.json().items.map((item: { id: number }) => item.id)).toContain(product.id);
    }
  });
});

describe('goods by the article number', () => {
  it('takes in a delivery that names the products by their article numbers', async () => {
    const code = sku();
    const product = await createProduct({ price: 10, stock: 0 });
    await patch(product.id, { sku: code });

    const res = await post('deliveries', {
      source: 'supplier',
      items: [{ sku: code, quantity: 3, unitCost: 2 }],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().batches).toEqual([
      expect.objectContaining({ productId: product.id, quantity: 3 }),
    ]);
    expect(await stockOf(product.id)).toMatchObject({ stock: 3 });
  });

  it('writes off the goods of an article number', async () => {
    const code = sku();
    const product = await createProduct({ price: 10, stock: 5 });
    await patch(product.id, { sku: code });

    const res = await post('write-offs', {
      reason: 'damaged',
      items: [{ sku: code.toLowerCase(), quantity: 2 }],
    });

    expect(res.statusCode).toBe(201);
    expect(await stockOf(product.id)).toMatchObject({ stock: 3 });
  });

  it('answers 404 with the article numbers no product of the catalog has, and takes in nothing', async () => {
    const product = await createProduct({ price: 10, stock: 0 });
    const missing = sku();

    const res = await post('deliveries', {
      source: 'supplier',
      items: [
        { productId: product.id, quantity: 1, unitCost: 1 },
        { sku: missing, quantity: 1, unitCost: 1 },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'PRODUCT_NOT_FOUND',
      details: { skus: [missing] },
    });
    expect(await stockOf(product.id)).toMatchObject({ stock: 0 });
  });

  it.each([
    ['neither a product id nor an article number', {}],
    ['both a product id and an article number', { productId: 1, sku: 'SKU-1' }],
  ])('refuses an item with %s', async (_case, names) => {
    const res = await post('deliveries', {
      source: 'supplier',
      items: [{ ...names, quantity: 1, unitCost: 1 }],
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});
