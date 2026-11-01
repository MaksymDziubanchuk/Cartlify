import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { removeUploads } from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  removeProducts,
  stockOf,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { createProductForm, formVariant } from '../../../helpers/productForm.js';
import { markVariantDeleted } from '../../../helpers/variants.js';

// the article number of a variant (sku): optional, any signs up to 64, one live variant of the
// catalog has it at a time; an admin finds a product by the number of its variants and takes in or
// writes off goods by it, the way the papers of a supplier name them

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
// the category of the products the form makes
let formCategoryId: number;
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  ({ id: formCategoryId } = await createCategory());
});

afterAll(async () => {
  try {
    await removeUploads();
    await asAdmin(async (tx) => {
      await tx.product.deleteMany({ where: { categoryId: formCategoryId } });
      await tx.category.deleteMany({ where: { id: formCategoryId } });
    });
    await removeProducts(products);
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

const sku = () => `SKU-${uniqueTag()}`;

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct({ price: 10, ...opts });
  products.push(product);
  return product;
};

// the article number is changed on the variant
const patch = (product: { id: number }, variantId: number, payload: Record<string, unknown>) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${product.id}/variants/${variantId}`,
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

describe('the article number of a variant', () => {
  it('comes with a new product from the form and shows in the card of a buyer and of an admin', async () => {
    const code = sku();

    const res = await createProductForm(app, csrf, admin, {
      categoryId: formCategoryId,
      variants: [formVariant({ sku: ` ${code} ` })],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().variant).toMatchObject({ sku: code });
    for (const headers of [{}, { cookie: accessCookie(admin) }]) {
      const card = await app.inject({
        method: 'GET',
        url: `/api/products/${res.json().product.id}`,
        headers,
      });

      expect(card.json().variant).toMatchObject({ sku: code });
    }
  });

  it('changes with the variant and goes with an empty value', async () => {
    const product = await newProduct();
    const code = sku();

    expect((await patch(product, product.variantId, { sku: code })).json().variant).toMatchObject({
      sku: code,
    });
    expect((await patch(product, product.variantId, { sku: '' })).json().variant).toMatchObject({
      sku: null,
    });
  });

  it('takes any signs and refuses more than 64', async () => {
    const product = await newProduct();
    const code = `АБ/12 #${uniqueTag()}`;

    expect((await patch(product, product.variantId, { sku: code })).json().variant).toMatchObject({
      sku: code,
    });
    const long = await patch(product, product.variantId, { sku: 'x'.repeat(65) });
    expect(long.statusCode).toBe(400);
    expect(long.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // an article number names one variant: the papers of a delivery could not tell two apart
  it('belongs to one variant of the catalog at a time, one of the same product too', async () => {
    const code = sku();
    const first = await newProduct();
    const second = await newProduct();
    const sibling = await createVariant(first.id);
    await patch(first, first.variantId, { sku: code });

    const taken = await patch(second, second.variantId, { sku: code });
    const same = await patch(first, sibling.id, { sku: code });

    for (const res of [taken, same]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SKU_TAKEN' });
    }

    // a variant taken out of sale lets it go
    await markVariantDeleted(first.variantId);
    expect((await patch(second, second.variantId, { sku: code })).statusCode).toBe(200);
  });

  // a product taken out of the catalog takes its variants out of sale and lets their numbers go
  it('is free once the product of the variant is taken out of the catalog', async () => {
    const code = sku();
    const first = await newProduct({ sku: code });
    const second = await newProduct();
    await deleteProductFromCatalog(first.id);

    expect((await patch(second, second.variantId, { sku: code })).statusCode).toBe(200);
  });

  // SKU-1 and sku-1 are one number on the papers of a supplier
  it('is one number whatever the case of its letters', async () => {
    const code = sku();
    const first = await newProduct();
    const second = await newProduct();
    await patch(first, first.variantId, { sku: code });

    const taken = await patch(second, second.variantId, { sku: code.toLowerCase() });

    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ errorCode: 'PRODUCT_SKU_TAKEN' });
  });

  // a product taken out let its numbers go: another variant may have one now
  it('stops the product coming back while another variant of the catalog has its number', async () => {
    const code = sku();
    const old = await newProduct({ sku: code });
    await deleteProductFromCatalog(old.id);
    const current = await newProduct();
    await patch(current, current.variantId, { sku: code });

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
    const product = await newProduct();
    await patch(product, product.variantId, { sku: code });

    for (const cookie of ['', accessCookie(admin)]) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/products?search=${encodeURIComponent(code)}`,
        headers: cookie ? { cookie } : {},
      });

      expect(
        res.json().items.map((item: { product: { id: number } }) => item.product.id),
      ).toContain(product.id);
    }
  });
});

// the routes of the stock are the business of the stock tests; these name the variants by their
// article numbers
describe('goods by the article number', () => {
  it('takes in a delivery that names the variants by their article numbers', async () => {
    const code = sku();
    const product = await newProduct({ stock: 0 });
    await patch(product, product.variantId, { sku: code });

    const res = await post('deliveries', {
      source: 'supplier',
      items: [{ sku: code, quantity: 3, unitCost: 2 }],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().batches).toEqual([
      expect.objectContaining({ variantId: product.variantId, quantity: 3 }),
    ]);
    expect(await stockOf(product.id)).toMatchObject({ stock: 3 });
  });

  it('writes off the goods of an article number', async () => {
    const code = sku();
    const product = await newProduct({ stock: 5 });
    await patch(product, product.variantId, { sku: code });

    const res = await post('write-offs', {
      reason: 'damaged',
      items: [{ sku: code.toLowerCase(), quantity: 2 }],
    });

    expect(res.statusCode).toBe(201);
    expect(await stockOf(product.id)).toMatchObject({ stock: 3 });
  });

  it('answers 404 with the article numbers no variant of the catalog has, and takes in nothing', async () => {
    const product = await newProduct({ stock: 0 });
    const missing = sku();

    const res = await post('deliveries', {
      source: 'supplier',
      items: [
        { variantId: product.variantId, quantity: 1, unitCost: 1 },
        { sku: missing, quantity: 1, unitCost: 1 },
      ],
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANT_NOT_FOUND',
      details: { skus: [missing] },
    });
    expect(await stockOf(product.id)).toMatchObject({ stock: 0 });
  });
});
