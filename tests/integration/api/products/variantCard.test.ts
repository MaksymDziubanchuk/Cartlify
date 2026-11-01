import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';

import { shopToday } from '@helpers/shopDay.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  deleteProductFromCatalog,
  putOnSale,
  receiveBatch,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { moveClock } from '../../../helpers/payments.js';
import {
  addGalleryImage,
  galleryIdsOf,
  markVariantDeleted,
  stripVariantImages,
  uniqueBarcode,
} from '../../../helpers/variants.js';

// the card of a product: GET /api/products/:productId[?variantId=] gives the product, the variant
// it opens and the variants to switch between; GET /api/products/:productId/variants/:variantId
// gives one variant on its own. A buyer sees the variants that are for sale and show a picture, an
// admin all of them

let app: FastifyInstance;
let admin: TestUser;
let buyer: TestUser;
const products: TestProduct[] = [];
let clock: { restore: () => void } | null = null;

beforeAll(async () => {
  app = await startApp();
  admin = await createUser({ role: 'ADMIN' });
  buyer = await createUser();
});

afterEach(() => {
  clock?.restore();
  clock = null;
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

const cardOf = (productId: number, opts: { actor?: TestUser; variantId?: number | string } = {}) =>
  app.inject({
    method: 'GET',
    url: `/api/products/${productId}${opts.variantId !== undefined ? `?variantId=${opts.variantId}` : ''}`,
    ...(opts.actor ? { headers: { cookie: accessCookie(opts.actor) } } : {}),
  });

const variantOf = (productId: number, variantId: number | string, actor?: TestUser) =>
  app.inject({
    method: 'GET',
    url: `/api/products/${productId}/variants/${variantId}`,
    ...(actor ? { headers: { cookie: accessCookie(actor) } } : {}),
  });

const viewsOf = async (productId: number) =>
  (
    await asAdmin((tx) =>
      tx.product.findUniqueOrThrow({ where: { id: productId }, select: { views: true } }),
    )
  ).views;

const idsOf = (list: { id: number }[]) => list.map((item) => item.id);

describe('the card of a product for a buyer', () => {
  it('gives the product, the variant it opens and the variants to switch between', async () => {
    const product = await newProduct({
      name: 'Card lamp',
      price: 10,
      stock: 5,
      sku: `CARD-${Date.now()}`,
      weightGrams: 350,
      sizesMm: { length: 200, width: 100, height: 50 },
    });
    const second = await createVariant(product.id, { price: 20, stock: 2 });

    for (const actor of [undefined, buyer]) {
      const res = await cardOf(product.id, actor ? { actor } : {});
      const body = res.json();

      expect(res.statusCode).toBe(200);
      expect(Object.keys(body).sort()).toEqual(['product', 'variant', 'variants']);
      expect(body.product).toMatchObject({
        id: product.id,
        name: 'Card lamp',
        category: { id: product.categoryId, path: [] },
        manufacturer: expect.objectContaining({ id: expect.any(Number) }),
        euResponsible: null,
        warnings: null,
        documents: [],
      });
      // the variant carries the price, the stock and the picture; the product none of them
      for (const field of ['price', 'stock', 'sku', 'images', 'salePrice', 'weightGrams']) {
        expect(body.product).not.toHaveProperty(field);
      }
      expect(body.variant).toMatchObject({
        id: product.variantId,
        position: 1,
        name: 'Card lamp',
        price: 10,
        stock: 5,
        sku: expect.stringMatching(/^CARD-/),
        weightGrams: 350,
        lengthMm: 200,
        widthMm: 100,
        heightMm: 50,
        image: {
          url200: expect.any(String),
          url400: expect.any(String),
          url800: expect.any(String),
        },
        images: [expect.objectContaining({ position: 1, url800: expect.any(String) })],
      });
      expect(body.variants).toEqual([
        expect.objectContaining({ id: product.variantId, position: 1, price: 10, stock: 5 }),
        expect.objectContaining({ id: second.id, position: 2, price: 20, stock: 2 }),
      ]);
      // the short form has no article number, no weight, no list of pictures
      expect(body.variants[0]).not.toHaveProperty('sku');
      expect(body.variants[0]).not.toHaveProperty('images');
    }
  });

  it('shows a buyer nothing of the admin: no popularity, no counters, no stock of the whole, no gallery', async () => {
    const product = await newProduct();

    const body = (await cardOf(product.id)).json();

    for (const field of [
      'popularity',
      'views',
      'updatedAt',
      'popularityOverride',
      'popularityOverrideUntil',
      'deletedAt',
      'gallery',
    ]) {
      expect(body.product).not.toHaveProperty(field);
    }
    for (const field of [
      'barcode',
      'totalStock',
      'reservedStock',
      'expiredStock',
      'lastUnitCost',
      'updatedAt',
      'visible',
      'deletedAt',
    ]) {
      expect(body.variant).not.toHaveProperty(field);
      expect(body.variants[0]).not.toHaveProperty(field);
    }
  });

  describe('the main variant', () => {
    it('is the first by its place that has free units', async () => {
      const product = await newProduct({ stock: 0 });
      const second = await createVariant(product.id, { stock: 3 });
      await createVariant(product.id, { stock: 9 });

      const body = (await cardOf(product.id)).json();

      expect(body.variant.id).toBe(second.id);
      expect(body.variants).toHaveLength(3);
    });

    it('is the first of all when no variant has free units', async () => {
      const product = await newProduct({ stock: 0 });
      await createVariant(product.id, { stock: 0 });

      expect((await cardOf(product.id)).json().variant.id).toBe(product.variantId);
    });

    // a unit of a batch that is over is no free unit
    it('does not count the units of a batch that is over as free', async () => {
      const product = await newProduct({ stock: 0 });
      await receiveBatch(product.id, { quantity: 4, expiresAt: shopToday() });
      const second = await createVariant(product.id, { stock: 2 });
      clock = moveClock(2 * 86_400_000);

      const body = (await cardOf(product.id)).json();

      expect(body.variant.id).toBe(second.id);
      expect(body.variants[0]).toMatchObject({ id: product.variantId, stock: 0 });
    });

    it('is the one asked for by ?variantId=', async () => {
      const product = await newProduct({ stock: 5 });
      const second = await createVariant(product.id, { stock: 1, price: 30 });

      const body = (await cardOf(product.id, { variantId: second.id })).json();

      expect(body.variant).toMatchObject({ id: second.id, price: 30 });
      // the list of the variants is the same whichever is open
      expect(idsOf(body.variants)).toEqual([product.variantId, second.id]);
    });
  });

  describe('the variants a buyer does not see', () => {
    it('leaves out a variant without a picture and a variant taken out of sale', async () => {
      const product = await newProduct();
      const bare = await createVariant(product.id, { imageIds: [] });
      const gone = await createVariant(product.id);
      await markVariantDeleted(gone.id);

      const body = (await cardOf(product.id)).json();

      expect(idsOf(body.variants)).toEqual([product.variantId]);
      for (const hidden of [bare.id, gone.id]) {
        const res = await cardOf(product.id, { variantId: hidden });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
      }
    });

    it('answers VARIANT_NOT_FOUND for a variant of another product', async () => {
      const product = await newProduct();
      const other = await newProduct();

      const res = await cardOf(product.id, { variantId: other.variantId });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
    });

    it('answers VARIANT_NOT_FOUND for a variant that is not there', async () => {
      const product = await newProduct();

      const res = await cardOf(product.id, { variantId: 2_000_000_000 });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
    });

    it('answers PRODUCT_NOT_FOUND for a product none of whose variants is for sale with a picture', async () => {
      const product = await newProduct();
      await stripVariantImages(product.variantId);

      for (const actor of [undefined, buyer]) {
        const res = await cardOf(product.id, actor ? { actor } : {});

        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
      }
    });

    it('answers PRODUCT_NOT_FOUND for a product taken out of the catalog, and for a product that is not there', async () => {
      const product = await newProduct();
      await deleteProductFromCatalog(product.id);

      for (const id of [product.id, 2_000_000_000]) {
        const res = await cardOf(id, { actor: buyer });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
      }
    });
  });

  describe('the sale', () => {
    it('shows the sale next to the price while it lasts', async () => {
      const product = await newProduct({ price: 100 });
      await putOnSale(product.id, 80);

      const { variant, variants } = (await cardOf(product.id)).json();

      for (const shown of [variant, variants[0]]) {
        expect(shown).toMatchObject({
          price: 100,
          salePrice: 80,
          saleEndsAt: expect.any(String),
        });
      }
    });

    it('shows a sale that is over to nobody but an admin', async () => {
      const product = await newProduct({ price: 100 });
      await putOnSale(product.id, 80, 600);
      await new Promise((resolve) => setTimeout(resolve, 900));

      const buyerBody = (await cardOf(product.id)).json();
      const adminBody = (await cardOf(product.id, { actor: admin })).json();

      expect(buyerBody.variant).not.toHaveProperty('salePrice');
      expect(buyerBody.variant).not.toHaveProperty('saleEndsAt');
      // an admin sees the row as it is, a sale past its end too
      expect(adminBody.variant).toMatchObject({ salePrice: 80, saleEndsAt: expect.any(String) });
    });

    it('gives an admin an empty sale as null', async () => {
      const product = await newProduct();

      const { variant } = (await cardOf(product.id, { actor: admin })).json();

      expect(variant).toMatchObject({ salePrice: null, saleEndsAt: null, salePriorPrice: null });
    });
  });

  describe('the views', () => {
    it('counts a visit of a buyer and a guest as a view of the product', async () => {
      const product = await newProduct();
      const before = await viewsOf(product.id);

      await cardOf(product.id);
      await cardOf(product.id, { actor: buyer });

      expect(await viewsOf(product.id)).toBe(before + 2);
    });

    it('does not count a visit of an admin, a variant read on its own or an answer that is not found', async () => {
      const product = await newProduct();
      const before = await viewsOf(product.id);

      await cardOf(product.id, { actor: admin });
      await variantOf(product.id, product.variantId);
      await cardOf(product.id, { variantId: 2_000_000_000 });
      await cardOf(2_000_000_000);

      expect(await viewsOf(product.id)).toBe(before);
    });
  });
});

describe('the card of a product for an admin', () => {
  it('gives the counters, the stock of the whole, the barcode, the cost, and the gallery with the variants that show each picture', async () => {
    const barcode = uniqueBarcode();
    const product = await newProduct({ stock: 0, price: 10, barcode });
    await receiveBatch(product.id, { quantity: 6, unitCost: 2.5 });
    const second = await createVariant(product.id, { stock: 0 });
    const extra = await addGalleryImage(product.id);
    const [firstImage] = await galleryIdsOf(product.id);

    const res = await cardOf(product.id, { actor: admin });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.product).toMatchObject({
      id: product.id,
      popularity: expect.any(Number),
      views: expect.any(Number),
      updatedAt: expect.any(String),
      popularityOverride: null,
      popularityOverrideUntil: null,
      deletedAt: null,
    });
    expect(body.product.gallery).toEqual([
      expect.objectContaining({
        id: firstImage,
        position: 0,
        variantIds: [product.variantId, second.id],
      }),
      expect.objectContaining({ id: extra, position: 1, variantIds: [] }),
    ]);
    expect(body.variant).toMatchObject({
      id: product.variantId,
      stock: 6,
      totalStock: 6,
      reservedStock: 0,
      expiredStock: 0,
      lastUnitCost: 2.5,
      barcode,
      visible: true,
      deletedAt: null,
      updatedAt: expect.any(String),
    });
    expect(body.variants).toEqual([
      expect.objectContaining({ id: product.variantId, visible: true, deletedAt: null }),
      expect.objectContaining({ id: second.id, visible: true, deletedAt: null }),
    ]);
  });

  it('gives a variant no supplier delivered a cost of null', async () => {
    const product = await newProduct({ stock: 0 });

    const { variant } = (await cardOf(product.id, { actor: admin })).json();

    expect(variant).toMatchObject({ lastUnitCost: null, totalStock: 0, barcode: null });
  });

  it('shows the units that are over apart from the free ones', async () => {
    const product = await newProduct({ stock: 0 });
    await receiveBatch(product.id, { quantity: 4, expiresAt: shopToday() });
    await receiveBatch(product.id, { quantity: 1 });
    clock = moveClock(2 * 86_400_000);

    const { variant } = (await cardOf(product.id, { actor: admin })).json();

    expect(variant).toMatchObject({ stock: 1, totalStock: 5, expiredStock: 4 });
  });

  it('lists every variant, the ones without a picture and the ones taken out of sale too, with the reason they are hidden', async () => {
    const product = await newProduct();
    const bare = await createVariant(product.id, { imageIds: [] });
    const gone = await createVariant(product.id);
    await markVariantDeleted(gone.id);

    const body = (await cardOf(product.id, { actor: admin })).json();

    expect(body.variants).toEqual([
      expect.objectContaining({ id: product.variantId, visible: true, deletedAt: null }),
      expect.objectContaining({ id: bare.id, visible: false, deletedAt: null, image: null }),
      expect.objectContaining({
        id: gone.id,
        visible: false,
        deletedAt: expect.any(String),
        image: expect.any(Object),
      }),
    ]);
  });

  it('opens a variant that is hidden from buyers when it is asked for', async () => {
    const product = await newProduct();
    const bare = await createVariant(product.id, { imageIds: [] });

    const res = await cardOf(product.id, { actor: admin, variantId: bare.id });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({
      id: bare.id,
      visible: false,
      image: null,
      images: [],
    });
  });

  it('opens the main variant a buyer would get, not a variant that is hidden', async () => {
    const product = await newProduct({ stock: 0 });
    // the first variant is out of sale, the second shows no picture, the third is the one
    await markVariantDeleted(product.variantId);
    await createVariant(product.id, { imageIds: [], stock: 9 });
    const third = await createVariant(product.id, { stock: 1 });

    const body = (await cardOf(product.id, { actor: admin })).json();

    expect(body.variant.id).toBe(third.id);
  });

  it('opens a product none of whose variants a buyer sees, with the first variant', async () => {
    const product = await newProduct();
    await stripVariantImages(product.variantId);

    const res = await cardOf(product.id, { actor: admin });

    expect(res.statusCode).toBe(200);
    expect(res.json().variant).toMatchObject({ id: product.variantId, visible: false });
  });

  it('opens a product taken out of the catalog, with the time it went and its variants out of sale', async () => {
    const product = await newProduct();
    await deleteProductFromCatalog(product.id);

    const res = await cardOf(product.id, { actor: admin });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.product.deletedAt).toEqual(expect.any(String));
    expect(body.variant).toMatchObject({ id: product.variantId, visible: false });
    expect(body.variant.deletedAt).toBe(body.product.deletedAt);
  });

  it('is no view of the product', async () => {
    const product = await newProduct();
    const before = await viewsOf(product.id);

    await cardOf(product.id, { actor: admin });

    expect(await viewsOf(product.id)).toBe(before);
  });
});

describe('a product that has no variant at all', () => {
  // a product of the shop always has one; a row made by hand without one is no card for anybody
  it('is no product for a buyer, and a failure of the server for an admin', async () => {
    const product = await newProduct({ stock: 0 });
    await asAdmin((tx) => tx.productVariant.deleteMany({ where: { productId: product.id } }));

    const buyerRes = await cardOf(product.id);
    const adminRes = await cardOf(product.id, { actor: admin });

    expect(buyerRes.statusCode).toBe(404);
    expect(buyerRes.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    expect(adminRes.statusCode).toBe(500);
    expect(takeLogs({ msg: 'request failed' })).toHaveLength(1);
  });
});

describe('the ids of the card', () => {
  it.each([
    ['not a number', 'abc'],
    ['zero', '0'],
    ['negative', '-1'],
    ['a fraction', '1.5'],
    ['over the largest id', '2147483648'],
  ])('refuses a variantId that is %s', async (_case, variantId) => {
    const product = await newProduct();

    const res = await cardOf(product.id, { variantId });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  // a path that is not plain digits fails the schema of the route; a number the int column cannot
  // hold passes it and is stopped by the guard of the id
  it.each([
    ['abc', 'VALIDATION_ERROR'],
    ['0', 'VALIDATION_ERROR'],
    ['-5', 'VALIDATION_ERROR'],
    ['1e3', 'VALIDATION_ERROR'],
    ['2147483648', 'INVALID_ID_PARAM'],
  ])('refuses a product id of %s with %s', async (id, errorCode) => {
    const res = await cardOf(id as unknown as number);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
  });
});

describe('GET /api/products/:productId/variants/:variantId', () => {
  it('gives a buyer the variant in full, without its product', async () => {
    const product = await newProduct({
      price: 12,
      stock: 3,
      sku: `ONE-${Date.now()}`,
      weightGrams: 200,
      sizesMm: { length: 30, width: 20, height: 10 },
    });

    const res = await variantOf(product.id, product.variantId, buyer);
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({
      id: product.variantId,
      position: 1,
      price: 12,
      stock: 3,
      sku: expect.stringMatching(/^ONE-/),
      weightGrams: 200,
      lengthMm: 30,
      widthMm: 20,
      heightMm: 10,
      image: expect.any(Object),
      images: [expect.objectContaining({ position: 1 })],
    });
    expect(body).not.toHaveProperty('product');
    for (const field of ['barcode', 'totalStock', 'reservedStock', 'lastUnitCost', 'visible']) {
      expect(body).not.toHaveProperty(field);
    }
  });

  it('gives an admin the stock of the whole, the cost and the barcode', async () => {
    const barcode = uniqueBarcode();
    const product = await newProduct({ stock: 0, barcode });
    await receiveBatch(product.id, { quantity: 8, unitCost: 3 });

    const res = await variantOf(product.id, product.variantId, admin);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: product.variantId,
      totalStock: 8,
      reservedStock: 0,
      expiredStock: 0,
      lastUnitCost: 3,
      barcode,
      visible: true,
      deletedAt: null,
    });
  });

  it('gives an admin a variant that is hidden from buyers', async () => {
    const product = await newProduct();
    const bare = await createVariant(product.id, { imageIds: [] });
    const gone = await createVariant(product.id);
    await markVariantDeleted(gone.id);

    const hidden = await variantOf(product.id, bare.id, admin);
    const out = await variantOf(product.id, gone.id, admin);

    expect(hidden.json()).toMatchObject({ id: bare.id, visible: false, image: null, images: [] });
    expect(out.json()).toMatchObject({
      id: gone.id,
      visible: false,
      deletedAt: expect.any(String),
    });
  });

  it('answers VARIANT_NOT_FOUND to a buyer for a variant that is hidden or of another product', async () => {
    const product = await newProduct();
    const other = await newProduct();
    const bare = await createVariant(product.id, { imageIds: [] });
    const gone = await createVariant(product.id);
    await markVariantDeleted(gone.id);

    for (const variantId of [bare.id, gone.id, other.variantId, 2_000_000_000]) {
      const res = await variantOf(product.id, variantId, buyer);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
    }
  });

  it('answers PRODUCT_NOT_FOUND to a buyer for a product taken out of the catalog or that is not there', async () => {
    const product = await newProduct();
    await deleteProductFromCatalog(product.id);

    for (const id of [product.id, 2_000_000_000]) {
      const res = await variantOf(id, product.variantId, buyer);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    }
  });

  it('gives an admin the variant of a product taken out of the catalog', async () => {
    const product = await newProduct();
    await deleteProductFromCatalog(product.id);

    const res = await variantOf(product.id, product.variantId, admin);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: product.variantId, visible: false });
  });

  it.each([
    ['a product id that is a word', 'abc', '1', 'VALIDATION_ERROR'],
    ['a variant id that is a word', '1', 'abc', 'VALIDATION_ERROR'],
    ['a variant id of 0', '1', '0', 'VALIDATION_ERROR'],
    ['a variant id over the largest id', '1', '2147483648', 'INVALID_ID_PARAM'],
    ['a product id over the largest id', '2147483648', '1', 'INVALID_ID_PARAM'],
  ])('refuses %s', async (_case, productId, variantId, errorCode) => {
    const res = await variantOf(productId as unknown as number, variantId);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
  });
});
