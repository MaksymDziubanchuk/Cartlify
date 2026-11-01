import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { MAX_PRODUCT_VARIANTS, MAX_VARIANT_IMAGES } from '@config/limits.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  deleteProductFromCatalog,
  removeProducts,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  addGalleryImage,
  auditLinesOf,
  galleryIdsOf,
  markVariantDeleted,
  tellingAttribute,
  uniqueBarcode,
  variantRowsOf,
} from '../../../helpers/variants.js';

// POST /api/products/:productId/variants adds 1 to 100 variants to a product that is there, all of
// them or none; a variant shows pictures of the gallery of the product and takes the next place

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let telling: Awaited<ReturnType<typeof tellingAttribute>>;
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  telling = await tellingAttribute();
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

// every variant a test makes has a value of its own, or it would repeat the one before (no two
// variants of a product have the same values: VARIANT_DUPLICATE)
let kinds = 0;

// a variant that is right: the price, the weight and the sizes, the first picture of the gallery
const variantBody = (imageId: number, over: Record<string, unknown> = {}) => ({
  price: 15,
  weightGrams: 300,
  lengthMm: 100,
  widthMm: 80,
  heightMm: 40,
  images: [{ imageId, position: 1 }],
  attributes: [{ attributeId: telling.id, value: `Kind ${(kinds += 1)}` }],
  ...over,
});

const add = (productId: number | string, variants: unknown[], actor: TestUser = admin) =>
  app.inject({
    method: 'POST',
    url: `/api/products/${productId}/variants`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload: { variants },
  });

type Problem = { index: number; errorCode: string; details?: unknown };

const problemsOf = (res: { json: () => { details?: { variants?: Problem[] } } }) =>
  res.json().details?.variants;

describe('POST /api/products/:productId/variants', () => {
  it('adds a variant at the next place and answers with it as an admin sees it', async () => {
    const product = await newProduct({ name: 'Add lamp' });
    const [image] = await galleryIdsOf(product.id);
    const sku = `ADD-${uniqueTag()}`;
    const barcode = uniqueBarcode();

    const res = await add(product.id, [variantBody(image!, { price: 25.5, sku, barcode })]);

    expect(res.statusCode).toBe(201);
    expect(res.json().variants).toEqual([
      expect.objectContaining({
        position: 2,
        // the first variant has no value of the telling characteristic, this one has
        name: expect.stringMatching(/^Add lamp — Kind \d+$/),
        price: 25.5,
        stock: 0,
        totalStock: 0,
        reservedStock: 0,
        expiredStock: 0,
        lastUnitCost: null,
        sku,
        barcode,
        weightGrams: 300,
        lengthMm: 100,
        widthMm: 80,
        heightMm: 40,
        visible: true,
        deletedAt: null,
        images: [expect.objectContaining({ id: image, position: 1 })],
        image: expect.any(Object),
      }),
    ]);
    const rows = await variantRowsOf(product.id);
    expect(rows.map((row) => row.position)).toEqual([1, 2]);
    expect(rows[1]).toMatchObject({ sku, barcode, stock: 0, deletedAt: null });
  });

  it('adds many at once, in the order of the list, each with the pictures and the places it gives', async () => {
    const product = await newProduct();
    const [first] = await galleryIdsOf(product.id);
    const second = await addGalleryImage(product.id);

    const res = await add(product.id, [
      variantBody(first!, { price: 11 }),
      variantBody(second, {
        price: 12,
        images: [
          { imageId: second, position: 3 },
          { imageId: first!, position: 1 },
        ],
      }),
      variantBody(first!, { price: 13 }),
    ]);

    expect(res.statusCode).toBe(201);
    const made = res.json().variants as {
      id: number;
      position: number;
      price: number;
      images: { id: number; position: number }[];
    }[];
    expect(made.map((v) => [v.position, v.price])).toEqual([
      [2, 11],
      [3, 12],
      [4, 13],
    ]);
    // the pictures of a variant come by their places
    expect(made[1]!.images.map((image) => [image.id, image.position])).toEqual([
      [first, 1],
      [second, 3],
    ]);
  });

  it('keeps the places of the variants taken out of sale: the new one goes after them', async () => {
    const product = await newProduct();
    const [image] = await galleryIdsOf(product.id);
    const first = await add(product.id, [variantBody(image!)]);
    await markVariantDeleted(first.json().variants[0].id);

    const res = await add(product.id, [variantBody(image!)]);

    expect(res.json().variants[0].position).toBe(3);
  });

  it('takes a variant without the weight and the sizes when it says they come later', async () => {
    const product = await newProduct();
    const [image] = await galleryIdsOf(product.id);

    const res = await add(product.id, [
      {
        price: 3,
        withoutShippingData: true,
        images: [{ imageId: image, position: 1 }],
        attributes: [{ attributeId: telling.id, value: 'Later' }],
      },
    ]);

    expect(res.statusCode).toBe(201);
    expect(res.json().variants[0]).toMatchObject({
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
  });

  it('writes a line of the admin log for each variant', async () => {
    const product = await newProduct();
    const [image] = await galleryIdsOf(product.id);

    const res = await add(product.id, [variantBody(image!, { price: 21 }), variantBody(image!)]);
    const made = res.json().variants as { id: number }[];

    for (const [index, variant] of made.entries()) {
      expect(await auditLinesOf('variant', variant.id)).toEqual([
        {
          actorId: admin.id,
          action: 'OTHER',
          event: 'variant.create',
          meta: expect.arrayContaining([
            { field: 'productId', old: null, new: product.id },
            { field: 'position', old: null, new: index + 2 },
            { field: 'price', old: null, new: index === 0 ? 21 : 15 },
            { field: 'images', old: null, new: [{ imageId: image, position: 1 }] },
          ]),
        },
      ]);
    }
  });

  it('does not touch the product itself', async () => {
    const product = await newProduct();
    const [image] = await galleryIdsOf(product.id);
    const before = await asAdmin((tx) =>
      tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { updatedAt: true } }),
    );

    await add(product.id, [variantBody(image!)]);

    expect(
      await auditLinesOf('product', product.id, [
        'product.update',
        'product.gallery_add',
        'product.gallery_remove',
        'variant.create',
      ]),
    ).toEqual([]);
    expect(
      (
        await asAdmin((tx) =>
          tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { updatedAt: true } }),
        )
      ).updatedAt,
    ).toEqual(before.updatedAt);
  });

  describe('a variant that is wrong', () => {
    it.each([
      ['no price', { price: undefined }, 'PRODUCT_PRICE_INVALID'],
      ['a price below 0', { price: -0.01 }, 'PRODUCT_PRICE_INVALID'],
      ['an article number over 64 signs', { sku: 'x'.repeat(65) }, 'PRODUCT_SKU_TOO_LONG'],
      [
        'a barcode with a wrong check digit',
        { barcode: '4006381333930' },
        'VARIANT_BARCODE_INVALID',
      ],
      ['no weight', { weightGrams: undefined }, 'PRODUCT_SHIPPING_DATA_REQUIRED'],
      ['two sizes only', { heightMm: undefined }, 'PRODUCT_SIZES_INCOMPLETE'],
      ['a weight of 0', { weightGrams: 0 }, 'PRODUCT_WEIGHT_INVALID'],
      ['a size over the highest', { lengthMm: 10_001 }, 'PRODUCT_SIZES_INVALID'],
      ['a stock', { stock: 3 }, 'PRODUCT_STOCK_NOT_ALLOWED'],
      ['no pictures', { images: undefined }, 'VARIANT_IMAGE_REQUIRED'],
      ['an empty list of pictures', { images: [] }, 'VARIANT_IMAGE_REQUIRED'],
      ['a place of 0', { images: [{ imageId: 5, position: 0 }] }, 'VARIANT_IMAGE_POSITION_INVALID'],
    ])('names the variant with %s (VARIANTS_INVALID, %s)', async (_case, patch, errorCode) => {
      const product = await newProduct();
      const [image] = await galleryIdsOf(product.id);
      const rowsBefore = await variantRowsOf(product.id);

      const res = await add(product.id, [variantBody(image!), variantBody(image!, patch)]);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
      expect(problemsOf(res)).toEqual([expect.objectContaining({ index: 1, errorCode })]);
      // all or none: the right variant before it was not made
      expect(await variantRowsOf(product.id)).toEqual(rowsBefore);
    });

    // the shape of the list is the schema's: pictures that are no list never reach the service
    it.each([
      ['null', null],
      ['a text', 'front'],
      ['an object', { imageId: 1, position: 1 }],
    ])('refuses pictures that are %s as a wrong shape, and adds none', async (_case, images) => {
      const product = await newProduct();
      const [image] = await galleryIdsOf(product.id);

      const res = await add(product.id, [variantBody(image!, { images })]);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'VALIDATION_ERROR',
        details: [{ in: 'body', field: 'variants.0.images', message: 'must be array' }],
      });
      expect(await variantRowsOf(product.id)).toHaveLength(1);
    });

    it('names more pictures than a variant shows, a picture twice, a place twice', async () => {
      const product = await newProduct();
      const [image] = await galleryIdsOf(product.id);
      const other = await addGalleryImage(product.id);

      const res = await add(product.id, [
        variantBody(image!, {
          images: Array.from({ length: MAX_VARIANT_IMAGES + 1 }, (_, i) => ({
            imageId: image,
            position: i + 1,
          })),
        }),
        variantBody(image!, {
          images: [
            { imageId: image, position: 1 },
            { imageId: image, position: 2 },
          ],
        }),
        variantBody(image!, {
          images: [
            { imageId: image, position: 1 },
            { imageId: other, position: 1 },
          ],
        }),
      ]);

      expect(problemsOf(res)).toEqual([
        { index: 0, errorCode: 'VARIANT_IMAGES_TOO_MANY', details: { max: MAX_VARIANT_IMAGES } },
        { index: 1, errorCode: 'VARIANT_IMAGES_REPEATED', details: { imageId: image } },
        { index: 2, errorCode: 'VARIANT_IMAGE_POSITION_INVALID', details: { position: 1 } },
      ]);
    });

    it('names every wrong variant, not the first only', async () => {
      const product = await newProduct();
      const [image] = await galleryIdsOf(product.id);

      const res = await add(product.id, [
        variantBody(image!, { price: -5 }),
        variantBody(image!),
        variantBody(image!, { barcode: '9' }),
      ]);

      expect(problemsOf(res)).toEqual([
        { index: 0, errorCode: 'PRODUCT_PRICE_INVALID' },
        { index: 2, errorCode: 'VARIANT_BARCODE_INVALID' },
      ]);
    });

    it('refuses a picture that is not in the gallery of this product', async () => {
      const product = await newProduct();
      const other = await newProduct();
      const [image] = await galleryIdsOf(product.id);
      const [foreign] = await galleryIdsOf(other.id);

      for (const imageId of [foreign!, 2_000_000_000]) {
        const res = await add(product.id, [variantBody(image!), variantBody(imageId)]);

        expect(res.statusCode).toBe(400);
        expect(problemsOf(res)).toEqual([
          { index: 1, errorCode: 'VARIANT_IMAGE_NOT_FOUND', details: { imageIds: [imageId] } },
        ]);
      }
      expect(await variantRowsOf(product.id)).toHaveLength(1);
    });
  });

  describe('the limits', () => {
    it.each([
      ['no variants', 0],
      ['101 variants', 101],
    ])('refuses %s in a request', async (_case, count) => {
      const product = await newProduct();
      const [image] = await galleryIdsOf(product.id);

      const res = await add(
        product.id,
        Array.from({ length: count }, () => variantBody(image!)),
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    });

    it('takes 100 variants in a request', async () => {
      const product = await newProduct();
      const [image] = await galleryIdsOf(product.id);

      const res = await add(
        product.id,
        Array.from({ length: 100 }, (_, i) => variantBody(image!, { price: i + 1 })),
      );

      expect(res.statusCode).toBe(201);
      expect((res.json().variants as { position: number }[]).map((v) => v.position)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 2),
      );
    });

    it('counts the variants taken out of sale in the limit of the product', async () => {
      const product = await newProduct();
      const [image] = await galleryIdsOf(product.id);
      // the product has MAX - 1 variants in all, some of them out of sale
      await asAdmin((tx) =>
        tx.productVariant.createMany({
          data: Array.from({ length: MAX_PRODUCT_VARIANTS - 2 }, (_, i) => ({
            productId: product.id,
            position: i + 2,
            price: 1,
            ...(i % 2 ? { deletedAt: new Date() } : {}),
          })),
        }),
      );

      const refused = await add(product.id, [variantBody(image!), variantBody(image!)]);
      const taken = await add(product.id, [variantBody(image!)]);

      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        errorCode: 'PRODUCT_VARIANTS_TOO_MANY',
        details: { max: MAX_PRODUCT_VARIANTS, have: MAX_PRODUCT_VARIANTS - 1 },
      });
      expect(taken.statusCode).toBe(201);
      expect(await variantRowsOf(product.id)).toHaveLength(MAX_PRODUCT_VARIANTS);

      const full = await add(product.id, [variantBody(image!)]);
      expect(full.statusCode).toBe(400);
      expect(full.json()).toMatchObject({ errorCode: 'PRODUCT_VARIANTS_TOO_MANY' });
    });
  });

  describe('the codes', () => {
    it('answers 409 for an article number or a barcode a live variant has, and adds none of the variants', async () => {
      const sku = `Held-${uniqueTag()}`;
      const barcode = uniqueBarcode();
      await newProduct({ sku, barcode });
      const product = await newProduct();
      const [image] = await galleryIdsOf(product.id);

      const bySku = await add(product.id, [
        variantBody(image!),
        variantBody(image!, { sku: sku.toLowerCase() }),
      ]);
      const byBarcode = await add(product.id, [variantBody(image!, { barcode })]);

      expect(bySku.statusCode).toBe(409);
      expect(bySku.json()).toMatchObject({
        errorCode: 'PRODUCT_SKU_TAKEN',
        details: { variants: [{ index: 1, sku: sku.toLowerCase() }] },
      });
      expect(byBarcode.statusCode).toBe(409);
      expect(byBarcode.json()).toMatchObject({
        errorCode: 'VARIANT_BARCODE_TAKEN',
        details: { variants: [{ index: 0, barcode }] },
      });
      expect(await variantRowsOf(product.id)).toHaveLength(1);
    });

    it('answers 409 when two variants of the request share a code', async () => {
      const product = await newProduct();
      const [image] = await galleryIdsOf(product.id);
      const sku = `Dup-${uniqueTag()}`;

      const res = await add(product.id, [
        variantBody(image!, { sku }),
        variantBody(image!, { sku: sku.toUpperCase() }),
      ]);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'PRODUCT_SKU_TAKEN',
        details: { variants: [{ index: 1 }] },
      });
    });

    it('lets a variant take a code that a variant taken out of sale let go', async () => {
      const sku = `Gone-${uniqueTag()}`;
      const holder = await newProduct({ sku });
      await markVariantDeleted(holder.variantId);
      const product = await newProduct();
      const [image] = await galleryIdsOf(product.id);

      const res = await add(product.id, [variantBody(image!, { sku })]);

      expect(res.statusCode).toBe(201);
    });
  });

  it('answers 409 for a product that is taken out of the catalog (PRODUCT_DELETED)', async () => {
    const product = await newProduct();
    const [image] = await galleryIdsOf(product.id);
    await deleteProductFromCatalog(product.id);

    const res = await add(product.id, [variantBody(image!)]);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_DELETED' });
    expect(await variantRowsOf(product.id)).toHaveLength(1);
  });

  it('answers 404 for a product that is not there', async () => {
    const res = await add(2_000_000_000, [variantBody(1)]);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
  });

  // two requests that want the same next place wait for each other on the product, so each takes
  // a place of its own
  it('gives each of the requests that meet its own place', async () => {
    const product = await newProduct();
    const [image] = await galleryIdsOf(product.id);

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => add(product.id, [variantBody(image!, { price: i + 1 })])),
    );

    expect(results.map((res) => res.statusCode)).toEqual([201, 201, 201, 201, 201, 201]);
    const rows = await variantRowsOf(product.id);
    expect(rows.map((row) => row.position)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const prices = rows.slice(1).map((row) => Number(row.price));
    expect([...prices].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
