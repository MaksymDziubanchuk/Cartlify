import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { MAX_PRODUCT_VARIANTS, MAX_VARIANT_IMAGES } from '@config/limits.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { removeUploads, uploadMark, waitingUploadsSince } from '../../../helpers/cloudinary.js';
import { getCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createProduct,
  createUser,
  createVariant,
  removeProducts,
  uniqueTag,
  type TestUser,
} from '../../../helpers/factories.js';
import {
  createProductForm,
  formVariant,
  productFormParts,
  sendForm,
} from '../../../helpers/productForm.js';
import {
  auditLinesOf,
  distinct,
  markVariantDeleted,
  uniqueBarcode,
  variantRowsOf,
} from '../../../helpers/variants.js';

// POST /api/products makes a product with its variants and its gallery from one form: the files
// are the gallery, `variants` is a JSON list, a variant names its pictures by the number of a file

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let categoryId: number;
const userIds: number[] = [];
const factoryProducts: Awaited<ReturnType<typeof createProduct>>[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  userIds.push(admin.id);
  ({ id: categoryId } = await createCategory());
});

afterAll(async () => {
  try {
    await removeUploads();
  } finally {
    try {
      await asAdmin(async (tx) => {
        await tx.product.deleteMany({ where: { categoryId } });
        await tx.category.deleteMany({ where: { id: categoryId } });
      });
      await removeProducts(factoryProducts);
      await closeSessions(userIds);
    } finally {
      await stopApp();
    }
  }
}, 120_000);

const create = (opts: Omit<Parameters<typeof createProductForm>[3], 'categoryId'>) =>
  createProductForm(app, csrf, admin, { categoryId, ...opts });

type Problem = { index: number; errorCode: string; details?: unknown };

const problemsOf = (res: { json: () => { details?: { variants?: Problem[] } } }) =>
  res.json().details?.variants;

describe('POST /api/products', () => {
  it('makes the product, its variant and its gallery, and answers with the card of an admin', async () => {
    const sku = `FORM-${uniqueTag()}`;
    const barcode = uniqueBarcode();

    const res = await create({
      name: 'Form headphones',
      variants: [formVariant({ price: 49.99, sku, barcode })],
    });
    const body = res.json();

    expect(res.statusCode).toBe(201);
    expect(body.product).toMatchObject({
      name: 'Form headphones',
      category: expect.objectContaining({ id: categoryId }),
      deletedAt: null,
    });
    expect(body.product.gallery).toEqual([
      expect.objectContaining({ position: 0, variantIds: [body.variant.id] }),
    ]);
    expect(body.variant).toMatchObject({
      position: 1,
      name: 'Form headphones',
      price: 49.99,
      // a new variant has no stock: it comes with a delivery
      stock: 0,
      totalStock: 0,
      reservedStock: 0,
      sku,
      barcode,
      weightGrams: 350,
      lengthMm: 200,
      widthMm: 100,
      heightMm: 50,
      visible: true,
      deletedAt: null,
      images: [expect.objectContaining({ position: 1, id: body.product.gallery[0].id })],
    });
    expect(body.variants).toEqual([expect.objectContaining({ id: body.variant.id, position: 1 })]);

    const rows = await variantRowsOf(body.product.id);
    expect(rows).toEqual([
      expect.objectContaining({
        id: body.variant.id,
        position: 1,
        sku,
        barcode,
        weightGrams: 350,
        stock: 0,
        deletedAt: null,
        images: [{ imageId: body.product.gallery[0].id, position: 1 }],
      }),
    ]);
    expect(Number(rows[0]!.price)).toBe(49.99);
  });

  it('puts the variants at the places of the list and names each its own pictures, in the places it gives', async () => {
    const res = await create({
      files: 3,
      variants: [
        formVariant({
          price: 10,
          attributes: await distinct('first'),
          images: [
            { file: 1, position: 2 },
            { file: 0, position: 1 },
          ],
        }),
        formVariant({
          price: 20,
          attributes: await distinct('second'),
          images: [
            { file: 2, position: 1 },
            { file: 1, position: 5 },
          ],
        }),
      ],
    });
    const body = res.json();

    expect(res.statusCode).toBe(201);
    const [first, second] = body.variants as { id: number; position: number; price: number }[];
    expect([first!.position, second!.position]).toEqual([1, 2]);
    expect([first!.price, second!.price]).toEqual([10, 20]);

    const gallery = body.product.gallery as {
      id: number;
      position: number;
      variantIds: number[];
    }[];
    expect(gallery.map((image) => image.position)).toEqual([0, 1, 2]);
    // a picture two variants show is named by both
    expect(gallery.map((image) => image.variantIds)).toEqual([
      [first!.id],
      [first!.id, second!.id],
      [second!.id],
    ]);

    const rows = await variantRowsOf(body.product.id);
    expect(rows.map((row) => row.images.map((image) => [image.imageId, image.position]))).toEqual([
      [
        [gallery[0]!.id, 1],
        [gallery[1]!.id, 2],
      ],
      [
        [gallery[2]!.id, 1],
        [gallery[1]!.id, 5],
      ],
    ]);
    // the answer gives the pictures of a variant by their places
    expect(
      (body.variant.images as { id: number; position: number }[]).map((image) => [
        image.id,
        image.position,
      ]),
    ).toEqual([
      [gallery[0]!.id, 1],
      [gallery[1]!.id, 2],
    ]);
  });

  it('opens the first variant when none has free units, as the card does', async () => {
    const res = await create({
      files: 2,
      variants: [
        formVariant({ attributes: await distinct('first') }),
        formVariant({ attributes: await distinct('second'), images: [{ file: 1, position: 1 }] }),
      ],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().variant.id).toBe(res.json().variants[0].id);
  });

  it('takes a variant without the weight and the sizes when it says they come later', async () => {
    const res = await create({
      variants: [
        {
          price: 5,
          withoutShippingData: true,
          images: [{ file: 0, position: 1 }],
        },
      ],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().variant).toMatchObject({
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
  });

  it('takes a free variant, and the weight without the sizes when the variant says they come later', async () => {
    const res = await create({
      variants: [
        {
          price: 0,
          weightGrams: 120,
          withoutShippingData: true,
          images: [{ file: 0, position: 1 }],
        },
      ],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().variant).toMatchObject({
      price: 0,
      weightGrams: 120,
      lengthMm: null,
    });
  });

  it('takes a variant without an article number or a barcode, and treats an empty one as none', async () => {
    const res = await create({
      variants: [formVariant({ sku: '  ', barcode: '' })],
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().variant).toMatchObject({ sku: null, barcode: null });
  });

  it('writes the line of the product and a line of each variant to the admin log', async () => {
    const sku = `LOG-${uniqueTag()}`;
    const res = await create({
      files: 2,
      variants: [
        formVariant({
          sku,
          attributes: await distinct('first'),
          images: [{ file: 0, position: 1 }],
        }),
        formVariant({
          price: 30,
          attributes: await distinct('second'),
          images: [{ file: 1, position: 1 }],
        }),
      ],
    });
    const body = res.json();
    expect(res.statusCode).toBe(201);

    const productLines = await auditLinesOf('product', body.product.id);
    expect(productLines.map((line) => `${line.action} ${line.event}`)).toEqual([
      'PRODUCT_CREATE product.create',
    ]);
    // the product line has no price, no article number and no weight: they are the variant's
    const fields = (productLines[0]!.meta as { field: string }[]).map((change) => change.field);
    expect(fields).toEqual(expect.arrayContaining(['name', 'categoryId', 'manufacturerId']));
    for (const field of ['price', 'sku', 'weightGrams']) expect(fields).not.toContain(field);

    for (const [index, variant] of (body.variants as { id: number }[]).entries()) {
      const lines = await auditLinesOf('variant', variant.id);

      expect(lines).toEqual([
        {
          actorId: admin.id,
          action: 'OTHER',
          event: 'variant.create',
          meta: expect.arrayContaining([
            { field: 'productId', old: null, new: body.product.id },
            { field: 'position', old: null, new: index + 1 },
            { field: 'price', old: null, new: index === 0 ? 10 : 30 },
          ]),
        },
      ]);
    }
    expect(JSON.stringify((await auditLinesOf('variant', body.variants[0].id))[0]!.meta)).toContain(
      sku,
    );
  });

  describe('a form that is wrong', () => {
    it.each([
      ['no field', null],
      ['an empty text', ''],
      ['a text that is no JSON', 'not json'],
      ['a JSON object', '{"price":1}'],
      ['a JSON text', '"variants"'],
      ['an empty list', '[]'],
    ])('wants a list of variants, not %s (VARIANTS_REQUIRED)', async (_case, variants) => {
      const name = `No variants ${uniqueTag()}`;
      const mark = uploadMark();

      const res = await create({ name, variants });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANTS_REQUIRED' });
      expect(await asAdmin((tx) => tx.product.count({ where: { name } }))).toBe(0);
      expect(await waitingUploadsSince(mark)).toEqual([]);
    });

    it('refuses more variants than the product may have (PRODUCT_VARIANTS_TOO_MANY)', async () => {
      const res = await create({
        variants: Array.from({ length: MAX_PRODUCT_VARIANTS + 1 }, () => formVariant()),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'PRODUCT_VARIANTS_TOO_MANY',
        details: { max: MAX_PRODUCT_VARIANTS },
      });
    });

    it('wants a picture in the form (PRODUCT_IMAGES_REQUIRED)', async () => {
      const res = await create({ files: 0 });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_IMAGES_REQUIRED' });
    });

    it('wants a name (BODY_NOT_FULL)', async () => {
      const parts = productFormParts({ categoryId }).filter((part) => part.name !== 'name');

      const res = await sendForm(app, csrf, 'POST', '/api/products', parts, admin);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'BODY_NOT_FULL' });
    });

    it('wants a category (BODY_NOT_FULL)', async () => {
      const parts = productFormParts({ categoryId }).filter((part) => part.name !== 'categoryId');

      const res = await sendForm(app, csrf, 'POST', '/api/products', parts, admin);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'BODY_NOT_FULL' });
    });

    it('refuses a stock of the form (PRODUCT_STOCK_NOT_ALLOWED)', async () => {
      const res = await create({ extra: [{ name: 'stock', value: '5' }] });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_STOCK_NOT_ALLOWED' });
    });

    it('answers 404 for a category that is not there', async () => {
      const res = await createProductForm(app, csrf, admin, { categoryId: 2_000_000_000 });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_NOT_FOUND' });
    });
  });

  describe('a variant that is wrong', () => {
    // every wrong variant is named with its own error; the product is not made
    it.each([
      ['a price that is missing', { price: undefined }, 'PRODUCT_PRICE_INVALID'],
      ['a negative price', { price: -1 }, 'PRODUCT_PRICE_INVALID'],
      ['a price of a word', { price: 'abc' }, 'PRODUCT_PRICE_INVALID'],
      ['a price with a part of a cent', { price: 10.004 }, 'PRODUCT_PRICE_INVALID'],
      ['an article number over 64 signs', { sku: 'x'.repeat(65) }, 'PRODUCT_SKU_TOO_LONG'],
      ['a barcode of the wrong length', { barcode: '12345' }, 'VARIANT_BARCODE_INVALID'],
      [
        'a barcode with a wrong check digit',
        { barcode: '4006381333930' },
        'VARIANT_BARCODE_INVALID',
      ],
      ['a barcode of letters', { barcode: 'abcdefgh' }, 'VARIANT_BARCODE_INVALID'],
      ['no weight', { weightGrams: undefined }, 'PRODUCT_SHIPPING_DATA_REQUIRED'],
      [
        'no sizes',
        { lengthMm: undefined, widthMm: undefined, heightMm: undefined },
        'PRODUCT_SHIPPING_DATA_REQUIRED',
      ],
      ['one size alone', { widthMm: undefined, heightMm: undefined }, 'PRODUCT_SIZES_INCOMPLETE'],
      ['a weight of 0', { weightGrams: 0 }, 'PRODUCT_WEIGHT_INVALID'],
      ['a weight over the highest', { weightGrams: 1_000_001 }, 'PRODUCT_WEIGHT_INVALID'],
      ['a size of 0', { lengthMm: 0 }, 'PRODUCT_SIZES_INVALID'],
      [
        'a flag that is a word',
        { withoutShippingData: 'maybe' },
        'PRODUCT_WITHOUT_SHIPPING_DATA_INVALID',
      ],
      ['a stock', { stock: 5 }, 'PRODUCT_STOCK_NOT_ALLOWED'],
      ['no picture', { images: undefined }, 'VARIANT_IMAGE_REQUIRED'],
      ['an empty list of pictures', { images: [] }, 'VARIANT_IMAGE_REQUIRED'],
      ['null for the pictures', { images: null }, 'VARIANT_IMAGE_REQUIRED'],
      ['pictures that are a text', { images: 'front' }, 'VARIANT_IMAGES_INVALID'],
      ['pictures that are a number', { images: 1 }, 'VARIANT_IMAGES_INVALID'],
      [
        'pictures that are an object, not a list',
        { images: { file: 0, position: 1 } },
        'VARIANT_IMAGES_INVALID',
      ],
      [
        'more pictures than a variant shows',
        {
          images: Array.from({ length: MAX_VARIANT_IMAGES + 1 }, (_, i) => ({
            file: 0,
            position: i + 1,
          })),
        },
        'VARIANT_IMAGES_TOO_MANY',
      ],
      [
        'a picture twice',
        {
          images: [
            { file: 0, position: 1 },
            { file: 0, position: 2 },
          ],
        },
        'VARIANT_IMAGES_REPEATED',
      ],
      [
        'a place twice',
        {
          images: [
            { file: 0, position: 1 },
            { file: 1, position: 1 },
          ],
        },
        'VARIANT_IMAGE_POSITION_INVALID',
      ],
      ['a place of 0', { images: [{ file: 0, position: 0 }] }, 'VARIANT_IMAGE_POSITION_INVALID'],
      ['no place', { images: [{ file: 0 }] }, 'VARIANT_IMAGE_POSITION_INVALID'],
      [
        'a file the form does not have',
        { images: [{ file: 7, position: 1 }] },
        'VARIANT_IMAGE_NOT_FOUND',
      ],
    ])('names the variant with %s (VARIANTS_INVALID, %s)', async (_case, patch, errorCode) => {
      const name = `Wrong variant ${uniqueTag()}`;
      const mark = uploadMark();

      const res = await create({
        name,
        files: 2,
        variants: [formVariant({ images: [{ file: 1, position: 1 }] }), formVariant(patch)],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
      expect(problemsOf(res)).toEqual([expect.objectContaining({ index: 1, errorCode })]);
      expect(await asAdmin((tx) => tx.product.count({ where: { name } }))).toBe(0);
      expect(await waitingUploadsSince(mark)).toEqual([]);
    });

    it('names every wrong variant, not the first only', async () => {
      const res = await create({
        files: 2,
        variants: [
          formVariant({ price: -2 }),
          formVariant({ images: [{ file: 1, position: 1 }] }),
          formVariant({ barcode: '1' }),
          'not an object',
        ],
      });

      expect(res.statusCode).toBe(400);
      expect(problemsOf(res)).toEqual([
        { index: 0, errorCode: 'PRODUCT_PRICE_INVALID' },
        { index: 2, errorCode: 'VARIANT_BARCODE_INVALID' },
        { index: 3, errorCode: 'VARIANT_INVALID' },
      ]);
    });

    it('names the fields a variant lacks', async () => {
      const res = await create({ variants: [formVariant({ weightGrams: undefined })] });

      expect(problemsOf(res)).toEqual([
        {
          index: 0,
          errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
          details: { fields: ['weightGrams'] },
        },
      ]);
    });

    it('refuses a picture of the gallery no variant shows (GALLERY_IMAGE_UNUSED)', async () => {
      const name = `Unused picture ${uniqueTag()}`;
      const mark = uploadMark();

      const res = await create({
        name,
        files: 3,
        variants: [formVariant({ images: [{ file: 1, position: 1 }] })],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'GALLERY_IMAGE_UNUSED',
        details: { files: [0, 2] },
      });
      expect(await asAdmin((tx) => tx.product.count({ where: { name } }))).toBe(0);
      expect(await waitingUploadsSince(mark)).toEqual([]);
    });
  });

  describe('the codes of the variants', () => {
    it('answers 409 for an article number a live variant has, whatever the case of its letters, and makes nothing', async () => {
      const sku = `Taken-${uniqueTag()}`;
      const holder = await createProduct({ sku });
      factoryProducts.push(holder);
      const name = `Sku taken ${uniqueTag()}`;
      const mark = uploadMark();

      const res = await create({
        name,
        files: 2,
        variants: [
          formVariant({ images: [{ file: 1, position: 1 }] }),
          formVariant({ sku: sku.toUpperCase() }),
        ],
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'PRODUCT_SKU_TAKEN',
        details: { variants: [{ index: 1, sku: sku.toUpperCase() }] },
      });
      expect(await asAdmin((tx) => tx.product.count({ where: { name } }))).toBe(0);
      expect(await waitingUploadsSince(mark)).toEqual([]);
    });

    it('answers 409 for a barcode a live variant has', async () => {
      const barcode = uniqueBarcode();
      factoryProducts.push(await createProduct({ barcode }));

      const res = await create({ variants: [formVariant({ barcode })] });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({
        errorCode: 'VARIANT_BARCODE_TAKEN',
        details: { variants: [{ index: 0, barcode }] },
      });
    });

    it('answers 409 when two variants of the form share an article number or a barcode', async () => {
      const sku = `Twice-${uniqueTag()}`;
      const barcode = uniqueBarcode();

      const bySku = await create({
        files: 2,
        variants: [
          formVariant({ sku }),
          formVariant({ sku: sku.toLowerCase(), images: [{ file: 1, position: 1 }] }),
        ],
      });
      const byBarcode = await create({
        files: 2,
        variants: [
          formVariant({ barcode }),
          formVariant({ barcode, images: [{ file: 1, position: 1 }] }),
        ],
      });

      expect(bySku.statusCode).toBe(409);
      expect(bySku.json()).toMatchObject({
        errorCode: 'PRODUCT_SKU_TAKEN',
        details: { variants: [{ index: 1 }] },
      });
      expect(byBarcode.statusCode).toBe(409);
      expect(byBarcode.json()).toMatchObject({
        errorCode: 'VARIANT_BARCODE_TAKEN',
        details: { variants: [{ index: 1 }] },
      });
    });

    it('lets a variant take the article number and the barcode of a variant taken out of sale', async () => {
      const sku = `Freed-${uniqueTag()}`;
      const barcode = uniqueBarcode();
      const holder = await createProduct({ sku, barcode });
      factoryProducts.push(holder);
      await markVariantDeleted(holder.variantId);

      const res = await create({ variants: [formVariant({ sku, barcode })] });

      expect(res.statusCode).toBe(201);
      expect(res.json().variant).toMatchObject({ sku, barcode });
    });

    it('lets two variants of different products have no article number and no barcode', async () => {
      const first = await create({ variants: [formVariant()] });
      const second = await create({ variants: [formVariant()] });

      expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    });
  });

  it('makes the variants of a product beside one that has more variants of its own', async () => {
    // a factory product with many variants is no obstacle to a new product
    const other = await createProduct();
    factoryProducts.push(other);
    await createVariant(other.id);

    const res = await create({ variants: [formVariant()] });

    expect(res.statusCode).toBe(201);
  });
});
