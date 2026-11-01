import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  removeProducts,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  auditLinesOf,
  markVariantDeleted,
  tellApart,
  uniqueBarcode,
  variantRowsOf,
} from '../../../helpers/variants.js';

// DELETE /api/products/:productId/variants/:variantId takes a variant out of sale (it is only
// marked), POST .../restore puts it back; the delete of a product takes its variants with it and
// the restore of the product brings back the ones that went with it

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions([admin.id]);
  } finally {
    await stopApp();
  }
});

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct(opts);
  products.push(product);
  return product;
};

const send = (method: 'DELETE' | 'POST', url: string, actor: TestUser = admin) =>
  app.inject({ method, url, headers: withCsrf(csrf, accessCookie(actor)) });

const removeVariant = (productId: number | string, variantId: number | string) =>
  send('DELETE', `/api/products/${productId}/variants/${variantId}`);

const restoreVariant = (productId: number | string, variantId: number | string) =>
  send('POST', `/api/products/${productId}/variants/${variantId}/restore`);

const cardOf = (productId: number, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: `/api/products/${productId}`,
    ...(actor ? { headers: { cookie: accessCookie(actor) } } : {}),
  });

const deletedAtOf = async (variantId: number) =>
  (
    await asAdmin((tx) =>
      tx.productVariant.findUniqueOrThrow({
        where: { id: variantId },
        select: { deletedAt: true },
      }),
    )
  ).deletedAt;

describe('DELETE /api/products/:productId/variants/:variantId', () => {
  it('takes the variant out of sale, keeps its row and its place, and writes the admin log', async () => {
    const product = await newProduct();
    const second = await createVariant(product.id);

    const res = await removeVariant(product.id, product.variantId);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: product.variantId, deletedAt: expect.any(String) });
    expect((await deletedAtOf(product.variantId))?.toISOString()).toBe(res.json().deletedAt);
    expect((await variantRowsOf(product.id)).map((row) => [row.id, row.position])).toEqual([
      [product.variantId, 1],
      [second.id, 2],
    ]);
    expect(await auditLinesOf('variant', product.variantId, ['variant.delete'])).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        event: 'variant.delete',
        meta: [{ field: 'deletedAt', old: null, new: res.json().deletedAt }],
      },
    ]);
  });

  it('hides the variant from a buyer and shows it to an admin', async () => {
    const product = await newProduct();
    const second = await createVariant(product.id);

    await removeVariant(product.id, second.id);

    const buyerCard = (await cardOf(product.id)).json();
    const adminCard = (await cardOf(product.id, admin)).json();
    expect(buyerCard.variants.map((v: { id: number }) => v.id)).toEqual([product.variantId]);
    expect(adminCard.variants).toEqual([
      expect.objectContaining({ id: product.variantId, visible: true }),
      expect.objectContaining({ id: second.id, visible: false, deletedAt: expect.any(String) }),
    ]);
  });

  it('takes the product out of the catalog for a buyer when its last variant goes', async () => {
    const product = await newProduct();

    await removeVariant(product.id, product.variantId);

    const res = await cardOf(product.id);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    expect((await cardOf(product.id, admin)).statusCode).toBe(200);
  });

  it('lets its article number and its barcode go', async () => {
    const sku = `Release-${uniqueTag()}`;
    const barcode = uniqueBarcode();
    const product = await newProduct({ sku, barcode });
    await removeVariant(product.id, product.variantId);

    const taker = await newProduct({ sku, barcode });

    expect(taker.variantId).toEqual(expect.any(Number));
  });

  it('answers 409 the second time, and for a variant of a product that was deleted, and writes no second line', async () => {
    const product = await newProduct();
    const other = await newProduct();
    await removeVariant(product.id, product.variantId);
    await send('DELETE', `/api/products/${other.id}`);

    const again = await removeVariant(product.id, product.variantId);
    const withProduct = await removeVariant(other.id, other.variantId);

    for (const res of [again, withProduct]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANT_ALREADY_DELETED' });
    }
    expect(await auditLinesOf('variant', product.variantId, ['variant.delete'])).toHaveLength(1);
  });

  it('answers 404 for a variant of another product, a variant that is not there, a product that is not there', async () => {
    const product = await newProduct();
    const other = await newProduct();

    const foreign = await removeVariant(product.id, other.variantId);
    const missing = await removeVariant(product.id, 2_000_000_000);
    const noProduct = await removeVariant(2_000_000_000, 1);

    expect(foreign.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
    expect(missing.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
    expect(noProduct.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    expect([foreign.statusCode, missing.statusCode, noProduct.statusCode]).toEqual([404, 404, 404]);
    expect(await deletedAtOf(other.variantId)).toBeNull();
  });
});

describe('POST /api/products/:productId/variants/:variantId/restore', () => {
  it('puts the variant back on sale and writes the admin log', async () => {
    const product = await newProduct();
    const second = await createVariant(product.id);
    await tellApart([product.variantId, second.id]);
    await removeVariant(product.id, product.variantId);

    const res = await restoreVariant(product.id, product.variantId);

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['product', 'variant']);
    expect(res.json().product).toMatchObject({ id: product.id, deletedAt: null });
    expect(res.json().variant).toMatchObject({
      id: product.variantId,
      deletedAt: null,
      visible: true,
    });
    expect(await deletedAtOf(product.variantId)).toBeNull();
    expect(await auditLinesOf('variant', product.variantId, ['variant.restore'])).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        event: 'variant.restore',
        meta: [{ field: 'deletedAt', old: expect.any(String), new: null }],
      },
    ]);
    expect((await cardOf(product.id)).statusCode).toBe(200);
  });

  it('answers 409 for a variant that is for sale', async () => {
    const product = await newProduct();

    const res = await restoreVariant(product.id, product.variantId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'VARIANT_NOT_DELETED' });
  });

  it('answers 409 when a live variant took the article number meanwhile, and keeps the variant out', async () => {
    const sku = `Back-${uniqueTag()}`;
    const product = await newProduct({ sku });
    await removeVariant(product.id, product.variantId);
    await newProduct({ sku });

    const res = await restoreVariant(product.id, product.variantId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SKU_TAKEN', details: { sku } });
    expect(await deletedAtOf(product.variantId)).not.toBeNull();
  });

  it('answers 409 when a live variant took the barcode meanwhile', async () => {
    const barcode = uniqueBarcode();
    const product = await newProduct({ barcode });
    await removeVariant(product.id, product.variantId);
    await newProduct({ barcode });

    const res = await restoreVariant(product.id, product.variantId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'VARIANT_BARCODE_TAKEN', details: { barcode } });
  });

  it('restores a variant whose code is held by no live variant, once the holder is gone too', async () => {
    const sku = `Again-${uniqueTag()}`;
    const product = await newProduct({ sku });
    await removeVariant(product.id, product.variantId);
    const holder = await newProduct({ sku });
    await removeVariant(holder.id, holder.variantId);

    const res = await restoreVariant(product.id, product.variantId);

    expect(res.statusCode).toBe(200);
  });

  // a variant of a removed product is not brought back alone: the product comes first
  it('answers 409 for a variant of a product that is deleted, and the database refuses it too', async () => {
    const product = await newProduct();
    await send('DELETE', `/api/products/${product.id}`);

    const res = await restoreVariant(product.id, product.variantId);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_DELETED' });
    expect(await deletedAtOf(product.variantId)).not.toBeNull();
    await expect(
      asAdmin((tx) =>
        tx.productVariant.update({ where: { id: product.variantId }, data: { deletedAt: null } }),
      ),
    ).rejects.toThrow();
  });

  it('answers 404 for a variant of another product, a variant that is not there, a product that is not there', async () => {
    const product = await newProduct();
    const other = await newProduct();
    await removeVariant(other.id, other.variantId);

    const foreign = await restoreVariant(product.id, other.variantId);
    const missing = await restoreVariant(product.id, 2_000_000_000);
    const noProduct = await restoreVariant(2_000_000_000, 1);

    expect(foreign.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
    expect(missing.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
    expect(noProduct.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });
});

describe('the delete and the restore of a product, and its variants', () => {
  it('takes the variants that are for sale out of sale with the product, with its time', async () => {
    const product = await newProduct();
    const second = await createVariant(product.id);

    const res = await send('DELETE', `/api/products/${product.id}`);

    expect(res.statusCode).toBe(200);
    const productRow = await asAdmin((tx) =>
      tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { deletedAt: true } }),
    );
    expect(await deletedAtOf(product.variantId)).toEqual(productRow.deletedAt);
    expect(await deletedAtOf(second.id)).toEqual(productRow.deletedAt);
  });

  it('brings back with the product the variants that went with it, and leaves out the one an admin took out before', async () => {
    const product = await newProduct();
    const gone = await createVariant(product.id);
    const kept = await createVariant(product.id);
    await markVariantDeleted(gone.id, new Date(Date.now() - 3_600_000));
    const goneAt = await deletedAtOf(gone.id);
    await send('DELETE', `/api/products/${product.id}`);

    const res = await send('POST', `/api/products/${product.id}/restore`);

    expect(res.statusCode).toBe(200);
    expect(await deletedAtOf(product.variantId)).toBeNull();
    expect(await deletedAtOf(kept.id)).toBeNull();
    expect(await deletedAtOf(gone.id)).toEqual(goneAt);
    // the answer is the card of an admin
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(['product', 'variant', 'variants']);
    expect(body.product).toMatchObject({ id: product.id, deletedAt: null });
    expect(body.variants).toEqual([
      expect.objectContaining({ id: product.variantId, visible: true }),
      expect.objectContaining({ id: gone.id, visible: false }),
      expect.objectContaining({ id: kept.id, visible: true }),
    ]);
  });

  it('keeps the product deleted when a variant of it cannot come back: its code is taken (409)', async () => {
    const sku = `Held-${uniqueTag()}`;
    const barcode = uniqueBarcode();
    const bySku = await newProduct({ sku });
    const byBarcode = await newProduct({ barcode });
    await send('DELETE', `/api/products/${bySku.id}`);
    await send('DELETE', `/api/products/${byBarcode.id}`);
    await newProduct({ sku });
    await newProduct({ barcode });

    const skuRes = await send('POST', `/api/products/${bySku.id}/restore`);
    const barcodeRes = await send('POST', `/api/products/${byBarcode.id}/restore`);

    expect(skuRes.statusCode).toBe(409);
    expect(skuRes.json()).toMatchObject({ errorCode: 'PRODUCT_SKU_TAKEN' });
    expect(barcodeRes.statusCode).toBe(409);
    expect(barcodeRes.json()).toMatchObject({ errorCode: 'VARIANT_BARCODE_TAKEN' });
    for (const product of [bySku, byBarcode]) {
      const row = await asAdmin((tx) =>
        tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { deletedAt: true } }),
      );
      expect(row.deletedAt).not.toBeNull();
      expect(await deletedAtOf(product.variantId)).not.toBeNull();
    }
    // nothing of the failed restore reached the admin log
    expect(await auditLinesOf('product', bySku.id, ['product.restore'])).toEqual([]);
  });
});
