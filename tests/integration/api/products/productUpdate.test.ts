import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
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
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { auditLinesOf, variantRowsOf } from '../../../helpers/variants.js';

// PATCH /api/products/:productId changes the fields of the product itself and answers with the
// card of an admin: the product, the variant the card opens and the variants. The price, the sale,
// the article number and the weight are the variant's, the pictures are the gallery's

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let buyer: TestUser;
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions([admin.id, buyer.id]);
  } finally {
    await stopApp();
  }
});

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct(opts);
  products.push(product);
  return product;
};

const patch = (productId: number, payload: Record<string, unknown>, actor: TestUser = admin) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

const updateLines = (productId: number) => auditLinesOf('product', productId, ['product.update']);

describe('PATCH /api/products/:productId', () => {
  it('changes the name and the description, answers with the card of an admin and writes the admin log', async () => {
    const product = await newProduct({ name: 'Before', price: 12, stock: 4 });
    const second = await createVariant(product.id, { price: 14 });

    const res = await patch(product.id, { name: 'After', description: 'A new text.' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['product', 'variant', 'variants']);
    expect(body.product).toMatchObject({
      id: product.id,
      name: 'After',
      description: 'A new text.',
      gallery: [expect.objectContaining({ variantIds: [product.variantId, second.id] })],
    });
    // the variants carry the new name and nothing else of theirs changed
    expect(body.variant).toMatchObject({
      id: product.variantId,
      name: 'After',
      price: 12,
      stock: 4,
      totalStock: 4,
    });
    expect(body.variants.map((v: { id: number; name: string }) => [v.id, v.name])).toEqual([
      [product.variantId, 'After'],
      [second.id, 'After'],
    ]);
    expect(await updateLines(product.id)).toEqual([
      {
        actorId: admin.id,
        action: 'PRODUCT_UPDATE',
        event: 'product.update',
        meta: [
          { field: 'name', old: 'Before', new: 'After' },
          { field: 'description', old: null, new: 'A new text.' },
        ],
      },
    ]);
  });

  it('leaves the variants of the product as they were', async () => {
    const product = await newProduct();
    await createVariant(product.id);
    const before = await variantRowsOf(product.id);

    await patch(product.id, {
      name: `Renamed ${uniqueTag()}`,
      categoryId: (await createCategory()).id,
    });

    expect(await variantRowsOf(product.id)).toEqual(before);
  });

  it('moves the product to another category', async () => {
    const product = await newProduct();
    const category = await createCategory();

    const res = await patch(product.id, { categoryId: category.id });

    expect(res.statusCode).toBe(200);
    expect(res.json().product.category).toMatchObject({ id: category.id, path: [] });
    expect(await updateLines(product.id)).toEqual([
      expect.objectContaining({
        meta: [{ field: 'categoryId', old: product.categoryId, new: category.id }],
      }),
    ]);
  });

  it('takes the description away with an empty text', async () => {
    const product = await newProduct();
    await patch(product.id, { description: 'Some text.' });

    const res = await patch(product.id, { description: '' });

    expect(res.statusCode).toBe(200);
    expect(res.json().product).not.toHaveProperty('description');
  });

  it('writes no line and changes nothing for what the product has', async () => {
    const product = await newProduct({ name: 'Same name' });

    const res = await patch(product.id, { name: 'Same name' });

    expect(res.statusCode).toBe(200);
    expect(await updateLines(product.id)).toEqual([]);
  });

  it('opens the variant the card would open, and lists the variants that are hidden from buyers too', async () => {
    const product = await newProduct({ stock: 0 });
    const hidden = await createVariant(product.id, { imageIds: [] });
    const open = await createVariant(product.id, { stock: 3 });

    const body = (await patch(product.id, { name: `Card ${uniqueTag()}` })).json();

    expect(body.variant.id).toBe(open.id);
    expect(body.variants.map((v: { id: number; visible: boolean }) => [v.id, v.visible])).toEqual([
      [product.variantId, true],
      [hidden.id, false],
      [open.id, true],
    ]);
  });

  // the price, the sale, the article number, the weight and the pictures are not fields of a
  // product: a request that sends them changes the product's own fields only
  it('does not take the price, the article number or the weight: they belong to the variant', async () => {
    const product = await newProduct({ price: 10, weightGrams: 350 });

    const alone = await patch(product.id, { price: 99, sku: 'NOPE', weightGrams: 1 });
    const mixed = await patch(product.id, { name: `Mixed ${uniqueTag()}`, price: 99, sku: 'NOPE' });

    expect(alone.statusCode).toBe(400);
    expect(alone.json()).toMatchObject({ errorCode: 'NO_FIELDS_TO_UPDATE' });
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json().variant).toMatchObject({ price: 10, sku: null, weightGrams: 350 });
    expect((await variantRowsOf(product.id))[0]).toMatchObject({ sku: null, weightGrams: 350 });
  });

  it('refuses a stock: it changes only with a delivery or a write-off', async () => {
    const product = await newProduct();

    const res = await patch(product.id, { name: 'Stocked', stock: 3 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_STOCK_NOT_ALLOWED' });
  });

  it('refuses an empty change and a blank name', async () => {
    const product = await newProduct();

    const empty = await patch(product.id, {});
    const blank = await patch(product.id, { name: '   ' });
    const none = await patch(product.id, { name: '' });

    expect(empty.json()).toMatchObject({ errorCode: 'NO_FIELDS_TO_UPDATE' });
    expect(blank.json()).toMatchObject({ errorCode: 'PRODUCT_NAME_INVALID' });
    expect(none.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('changes a product that is taken out of the catalog, and shows it so', async () => {
    const product = await newProduct();
    await deleteProductFromCatalog(product.id);

    const res = await patch(product.id, { name: 'Changed while out' });

    expect(res.statusCode).toBe(200);
    expect(res.json().product).toMatchObject({
      name: 'Changed while out',
      deletedAt: expect.any(String),
    });
  });

  it('answers 404 for a product that is not there', async () => {
    const res = await patch(2_000_000_000, { name: 'Nobody' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  it('refuses a user and changes nothing', async () => {
    const product = await newProduct({ name: 'Not for a user' });

    const res = await patch(product.id, { name: 'Taken' }, buyer);

    expect(res.statusCode).toBe(403);
    expect(
      (
        await asAdmin((tx) =>
          tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { name: true } }),
        )
      ).name,
    ).toBe('Not for a user');
  });

  it('lets two changes of one product meet', async () => {
    const product = await newProduct();

    const results = await Promise.all([
      patch(product.id, { name: `First ${uniqueTag()}` }),
      patch(product.id, { description: 'Second.' }),
      patch(product.id, {
        popularityOverride: 5,
        popularityOverrideUntil: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    ]);

    expect(results.map((res) => res.statusCode)).toEqual([200, 200, 200]);
  });
});
