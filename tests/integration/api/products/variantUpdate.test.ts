import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { MAX_VARIANT_IMAGES } from '@config/limits.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import {
  closeSessions,
  createProduct,
  createVariant,
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
  imagesOfVariant,
  markVariantDeleted,
  uniqueBarcode,
  variantRowsOf,
} from '../../../helpers/variants.js';

// PATCH /api/products/:productId/variants/:variantId changes what is sent of a variant: the
// article number, the barcode, the weight and the sizes, the place among the variants, the
// pictures it shows. (The price and the sale are changed by their own steps.)

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let root: TestUser;
const products: TestProduct[] = [];

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await createUser({ role: 'ADMIN' });
  root = await createUser({ role: 'ROOT' });
});

afterAll(async () => {
  try {
    await removeProducts(products);
    await closeSessions([admin.id, root.id]);
  } finally {
    await stopApp();
  }
});

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct({
    weightGrams: 350,
    sizesMm: { length: 200, width: 100, height: 50 },
    ...opts,
  });
  products.push(product);
  return product;
};

const change = (
  productId: number | string,
  variantId: number | string,
  payload: Record<string, unknown>,
  actor: TestUser = admin,
) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/variants/${variantId}`,
    headers: withCsrf(csrf, accessCookie(actor)),
    payload,
  });

const updateLines = (variantId: number) => auditLinesOf('variant', variantId, ['variant.update']);

const placesOf = async (productId: number) =>
  (await variantRowsOf(productId)).map((row) => [row.id, row.position]);

describe('PATCH /api/products/:productId/variants/:variantId', () => {
  it('changes the fields sent, answers with the product and the variant as an admin sees them, and keeps the change in the admin log', async () => {
    const product = await newProduct({ name: 'Patch lamp' });
    const sku = `PATCH-${uniqueTag()}`;
    const barcode = uniqueBarcode();

    const res = await change(product.id, product.variantId, {
      sku,
      barcode,
      weightGrams: 500,
      lengthMm: 210,
    });

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json()).sort()).toEqual(['product', 'variant']);
    expect(res.json().product).toMatchObject({
      id: product.id,
      name: 'Patch lamp',
      views: expect.any(Number),
      deletedAt: null,
    });
    expect(res.json().variant).toMatchObject({
      id: product.variantId,
      sku,
      barcode,
      weightGrams: 500,
      lengthMm: 210,
      widthMm: 100,
      heightMm: 50,
      totalStock: 5,
      visible: true,
    });
    expect(await updateLines(product.variantId)).toEqual([
      {
        actorId: admin.id,
        action: 'OTHER',
        event: 'variant.update',
        meta: [
          { field: 'sku', old: null, new: sku },
          { field: 'barcode', old: null, new: barcode },
          { field: 'weightGrams', old: 350, new: 500 },
          { field: 'lengthMm', old: 200, new: 210 },
        ],
      },
    ]);
  });

  it('lets root change it too', async () => {
    const product = await newProduct();

    const res = await change(product.id, product.variantId, { weightGrams: 400 }, root);

    expect(res.statusCode).toBe(200);
    expect((await updateLines(product.variantId))[0]).toMatchObject({ actorId: root.id });
  });

  it('writes no line when what is sent is what the variant has', async () => {
    const sku = `SAME-${uniqueTag()}`;
    const product = await newProduct({ sku });

    const res = await change(product.id, product.variantId, { sku, weightGrams: 350 });

    expect(res.statusCode).toBe(200);
    expect(await updateLines(product.variantId)).toEqual([]);
  });

  it('does not change the product or the other variants', async () => {
    const product = await newProduct();
    const other = await createVariant(product.id, { sku: `OTHER-${uniqueTag()}` });
    const before = await variantRowsOf(product.id);

    await change(product.id, product.variantId, { weightGrams: 999 });

    const after = await variantRowsOf(product.id);
    expect(after[1]).toEqual(before[1]);
    expect(after[0]).toMatchObject({ id: product.variantId, weightGrams: 999 });
    expect(
      await auditLinesOf('product', product.id, ['product.update', 'product.gallery_add']),
    ).toEqual([]);
    expect(await updateLines(other.id)).toEqual([]);
  });

  it('answers with an empty change as NO_FIELDS_TO_UPDATE', async () => {
    const product = await newProduct();

    const res = await change(product.id, product.variantId, {});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NO_FIELDS_TO_UPDATE' });
  });

  it('refuses a stock: it changes only with a delivery or a write-off', async () => {
    const product = await newProduct();

    const res = await change(product.id, product.variantId, { stock: 3, weightGrams: 400 });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_STOCK_NOT_ALLOWED' });
    expect((await variantRowsOf(product.id))[0]).toMatchObject({ stock: 5, weightGrams: 350 });
  });

  describe('the article number and the barcode', () => {
    it('takes the codes away with null or an empty text', async () => {
      const product = await newProduct({ sku: `AWAY-${uniqueTag()}`, barcode: uniqueBarcode() });

      const res = await change(product.id, product.variantId, { sku: null, barcode: '' });

      expect(res.statusCode).toBe(200);
      expect(res.json().variant).toMatchObject({ sku: null, barcode: null });
    });

    it('answers 409 for a code a live variant has, whatever the case of its letters, and changes nothing', async () => {
      const sku = `Held-${uniqueTag()}`;
      const barcode = uniqueBarcode();
      await newProduct({ sku, barcode });
      const product = await newProduct();

      const bySku = await change(product.id, product.variantId, {
        sku: sku.toUpperCase(),
        weightGrams: 800,
      });
      const byBarcode = await change(product.id, product.variantId, { barcode });

      expect(bySku.statusCode).toBe(409);
      expect(bySku.json()).toMatchObject({
        errorCode: 'PRODUCT_SKU_TAKEN',
        details: { sku: sku.toUpperCase() },
      });
      expect(byBarcode.statusCode).toBe(409);
      expect(byBarcode.json()).toMatchObject({
        errorCode: 'VARIANT_BARCODE_TAKEN',
        details: { barcode },
      });
      expect((await variantRowsOf(product.id))[0]).toMatchObject({ sku: null, weightGrams: 350 });
    });

    it('lets a variant keep its own code and change the case of its letters', async () => {
      const sku = `Own-${uniqueTag()}`;
      const product = await newProduct({ sku });

      const res = await change(product.id, product.variantId, { sku: sku.toUpperCase() });

      expect(res.statusCode).toBe(200);
      expect(res.json().variant.sku).toBe(sku.toUpperCase());
    });

    it('lets a variant take a code that a variant taken out of sale let go', async () => {
      const sku = `Free-${uniqueTag()}`;
      const holder = await newProduct({ sku });
      await markVariantDeleted(holder.variantId);
      const product = await newProduct();

      const res = await change(product.id, product.variantId, { sku });

      expect(res.statusCode).toBe(200);
    });

    it('does not check the codes of a variant that is out of sale: it holds none', async () => {
      const sku = `Dead-${uniqueTag()}`;
      await newProduct({ sku });
      const product = await newProduct();
      await markVariantDeleted(product.variantId);

      const res = await change(product.id, product.variantId, { sku });

      expect(res.statusCode).toBe(200);
    });

    it.each([
      ['an article number over 64 signs', { sku: 'x'.repeat(65) }, 'VALIDATION_ERROR'],
      ['a barcode of the wrong length', { barcode: '12345' }, 'VARIANT_BARCODE_INVALID'],
      [
        'a barcode with a wrong check digit',
        { barcode: '4006381333930' },
        'VARIANT_BARCODE_INVALID',
      ],
      ['a barcode of letters', { barcode: 'abcdefghij' }, 'VARIANT_BARCODE_INVALID'],
    ])('refuses %s', async (_case, payload, errorCode) => {
      const product = await newProduct();

      const res = await change(product.id, product.variantId, payload);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode });
    });
  });

  describe('the weight and the sizes', () => {
    it('changes a size alone while the other two are there', async () => {
      const product = await newProduct();

      const res = await change(product.id, product.variantId, { heightMm: 60 });

      expect(res.statusCode).toBe(200);
      expect(res.json().variant).toMatchObject({ lengthMm: 200, widthMm: 100, heightMm: 60 });
    });

    it('refuses to clear what is known without withoutShippingData, and clears it with it', async () => {
      const product = await newProduct();

      const refused = await change(product.id, product.variantId, { weightGrams: null });
      const sizes = await change(product.id, product.variantId, {
        lengthMm: null,
        widthMm: null,
        heightMm: null,
      });
      const cleared = await change(product.id, product.variantId, {
        weightGrams: null,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        withoutShippingData: true,
      });

      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toMatchObject({
        errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
        details: { fields: ['weightGrams'] },
      });
      expect(sizes.json()).toMatchObject({
        errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
        details: { fields: ['sizesMm'] },
      });
      expect(cleared.statusCode).toBe(200);
      expect(cleared.json().variant).toMatchObject({
        weightGrams: null,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
      });
    });

    it('refuses one size cleared and the others kept (PRODUCT_SIZES_INCOMPLETE), even with the flag', async () => {
      const product = await newProduct();

      const res = await change(product.id, product.variantId, {
        lengthMm: null,
        withoutShippingData: true,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_SIZES_INCOMPLETE' });
    });

    it('sets the weight and the sizes of a variant that had none', async () => {
      const product = await newProduct();
      await change(product.id, product.variantId, {
        weightGrams: null,
        lengthMm: null,
        widthMm: null,
        heightMm: null,
        withoutShippingData: true,
      });

      const res = await change(product.id, product.variantId, {
        weightGrams: 120,
        lengthMm: 10,
        widthMm: 20,
        heightMm: 30,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().variant).toMatchObject({
        weightGrams: 120,
        lengthMm: 10,
        widthMm: 20,
        heightMm: 30,
      });
    });

    it.each([
      ['a weight of 0', { weightGrams: 0 }, 'PRODUCT_WEIGHT_INVALID'],
      ['a weight over the highest', { weightGrams: 1_000_001 }, 'PRODUCT_WEIGHT_INVALID'],
      ['a size of 0', { lengthMm: 0 }, 'PRODUCT_SIZES_INVALID'],
      ['a size over the highest', { widthMm: 10_001 }, 'PRODUCT_SIZES_INVALID'],
    ])('refuses %s', async (_case, payload, errorCode) => {
      const product = await newProduct();

      const res = await change(product.id, product.variantId, payload);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode });
    });
  });

  describe('the place among the variants', () => {
    // three variants A, B, C at the places 1, 2, 3
    async function three() {
      const product = await newProduct();
      const b = await createVariant(product.id);
      const c = await createVariant(product.id);
      return { product, a: product.variantId, b: b.id, c: c.id };
    }

    it('moves a variant up and the others move around it, each with a place of its own', async () => {
      const { product, a, b, c } = await three();

      const res = await change(product.id, c, { position: 1 });

      expect(res.statusCode).toBe(200);
      expect(res.json().variant).toMatchObject({ id: c, position: 1 });
      expect(await placesOf(product.id)).toEqual([
        [c, 1],
        [a, 2],
        [b, 3],
      ]);
    });

    it('moves a variant down', async () => {
      const { product, a, b, c } = await three();

      await change(product.id, a, { position: 3 });

      expect(await placesOf(product.id)).toEqual([
        [b, 1],
        [c, 2],
        [a, 3],
      ]);
    });

    it('moves a variant to the middle', async () => {
      const { product, a, b, c } = await three();

      await change(product.id, c, { position: 2 });

      expect(await placesOf(product.id)).toEqual([
        [a, 1],
        [c, 2],
        [b, 3],
      ]);
    });

    it('puts a variant moved past the last place at the last place', async () => {
      const { product, a, b, c } = await three();

      const res = await change(product.id, a, { position: 99 });

      expect(res.json().variant.position).toBe(3);
      expect(await placesOf(product.id)).toEqual([
        [b, 1],
        [c, 2],
        [a, 3],
      ]);
    });

    it('keeps the places of the variants taken out of sale: a moved variant goes around them', async () => {
      const { product, a, b, c } = await three();
      await markVariantDeleted(b);

      await change(product.id, c, { position: 2 });

      expect(await placesOf(product.id)).toEqual([
        [a, 1],
        [c, 2],
        [b, 3],
      ]);
    });

    it('writes the move of the variant to the admin log, and nothing for the same place', async () => {
      const { product, c } = await three();

      await change(product.id, c, { position: 3 });
      await change(product.id, c, { position: 1 });

      expect(await updateLines(c)).toEqual([
        expect.objectContaining({
          meta: [{ field: 'position', old: 3, new: 1 }],
        }),
      ]);
    });

    it('closes the gaps of the places when it moves a variant', async () => {
      const product = await newProduct();
      const b = await createVariant(product.id, { position: 5 });

      await change(product.id, b.id, { position: 1 });

      expect(await placesOf(product.id)).toEqual([
        [b.id, 1],
        [product.variantId, 2],
      ]);
    });

    it('lets requests that move variants of one product meet: every variant keeps a place of its own', async () => {
      const { product, a, b, c } = await three();
      const d = await createVariant(product.id);

      const results = await Promise.all([
        change(product.id, d.id, { position: 1 }),
        change(product.id, c, { position: 1 }),
        change(product.id, b, { position: 4 }),
        change(product.id, a, { position: 2 }),
      ]);

      expect(results.map((res) => res.statusCode)).toEqual([200, 200, 200, 200]);
      const places = (await placesOf(product.id)).map(([, position]) => position);
      expect(places).toEqual([1, 2, 3, 4]);
    });

    it.each([
      ['0', 0],
      ['a fraction', 1.5],
      ['negative', -1],
    ])('refuses a place that is %s', async (_case, position) => {
      const product = await newProduct();

      const res = await change(product.id, product.variantId, { position });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: expect.stringMatching(/VARIANT_POSITION_INVALID|VALIDATION_ERROR/),
      });
    });
  });

  describe('the pictures', () => {
    it('writes the list of the pictures whole, with the places it gives', async () => {
      const product = await newProduct();
      const [first] = await galleryIdsOf(product.id);
      const second = await addGalleryImage(product.id);
      const third = await addGalleryImage(product.id);

      const res = await change(product.id, product.variantId, {
        images: [
          { imageId: third, position: 1 },
          { imageId: second, position: 4 },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(
        (res.json().variant.images as { id: number; position: number }[]).map((image) => [
          image.id,
          image.position,
        ]),
      ).toEqual([
        [third, 1],
        [second, 4],
      ]);
      expect(await imagesOfVariant(product.variantId)).toEqual([
        [third, 1],
        [second, 4],
      ]);
      expect(await updateLines(product.variantId)).toEqual([
        expect.objectContaining({
          meta: [
            {
              field: 'images',
              old: [{ imageId: first, position: 1 }],
              new: [
                { imageId: third, position: 1 },
                { imageId: second, position: 4 },
              ],
            },
          ],
        }),
      ]);
    });

    it('swaps the places of two pictures', async () => {
      const product = await newProduct();
      const [first] = await galleryIdsOf(product.id);
      const second = await addGalleryImage(product.id);
      await change(product.id, product.variantId, {
        images: [
          { imageId: first, position: 1 },
          { imageId: second, position: 2 },
        ],
      });

      const res = await change(product.id, product.variantId, {
        images: [
          { imageId: first, position: 2 },
          { imageId: second, position: 1 },
        ],
      });

      expect(res.statusCode).toBe(200);
      expect(await imagesOfVariant(product.variantId)).toEqual([
        [second, 1],
        [first, 2],
      ]);
    });

    it('writes no line when the list is what the variant shows', async () => {
      const product = await newProduct();
      const [first] = await galleryIdsOf(product.id);

      const res = await change(product.id, product.variantId, {
        images: [{ imageId: first, position: 1 }],
      });

      expect(res.statusCode).toBe(200);
      expect(await updateLines(product.variantId)).toEqual([]);
    });

    it('hides the variant from buyers when it is left with no picture, and shows it to an admin', async () => {
      const product = await newProduct();

      const res = await change(product.id, product.variantId, { images: [] });

      expect(res.statusCode).toBe(200);
      expect(res.json().variant).toMatchObject({ visible: false, image: null, images: [] });
      const card = await app.inject({ method: 'GET', url: `/api/products/${product.id}` });
      expect(card.statusCode).toBe(404);
    });

    it('makes a variant that was hidden visible with a picture', async () => {
      const product = await newProduct();
      const bare = await createVariant(product.id, { imageIds: [] });
      const [first] = await galleryIdsOf(product.id);

      const res = await change(product.id, bare.id, { images: [{ imageId: first, position: 1 }] });

      expect(res.json().variant).toMatchObject({ visible: true, image: expect.any(Object) });
    });

    it('refuses a picture that is not in the gallery of this product, and keeps the pictures', async () => {
      const product = await newProduct();
      const other = await newProduct();
      const [foreign] = await galleryIdsOf(other.id);
      const before = await imagesOfVariant(product.variantId);

      for (const imageId of [foreign!, 2_000_000_000]) {
        const res = await change(product.id, product.variantId, {
          images: [{ imageId, position: 1 }],
        });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({
          errorCode: 'VARIANT_IMAGE_NOT_FOUND',
          details: { imageIds: [imageId] },
        });
      }
      expect(await imagesOfVariant(product.variantId)).toEqual(before);
    });

    // The list is written whole. A value that is no list is no list of pictures to write, and it is
    // not the way to take them all away (that is an empty list): the shape of the body is refused
    // before the service reads it, with the field named
    it.each([
      ['null', null],
      ['a number', 5],
      ['a text', 'first'],
      ['an object', { imageId: 1, position: 1 }],
    ])('refuses pictures that are %s, and keeps the pictures', async (_case, images) => {
      const product = await newProduct();
      const before = await imagesOfVariant(product.variantId);

      const res = await change(product.id, product.variantId, { images });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        errorCode: 'VALIDATION_ERROR',
        details: [{ in: 'body', field: 'images', message: 'must be array' }],
      });
      expect(await imagesOfVariant(product.variantId)).toEqual(before);
      expect(await updateLines(product.variantId)).toEqual([]);
    });

    it('refuses more pictures than a variant shows, a picture twice, a place twice', async () => {
      const product = await newProduct();
      const [first] = await galleryIdsOf(product.id);
      const second = await addGalleryImage(product.id);

      const cases: [Record<string, number>[], string][] = [
        [
          Array.from({ length: MAX_VARIANT_IMAGES + 1 }, (_, i) => ({
            imageId: first!,
            position: i + 1,
          })),
          'VARIANT_IMAGES_TOO_MANY',
        ],
        [
          [
            { imageId: first!, position: 1 },
            { imageId: first!, position: 2 },
          ],
          'VARIANT_IMAGES_REPEATED',
        ],
        [
          [
            { imageId: first!, position: 1 },
            { imageId: second, position: 1 },
          ],
          'VARIANT_IMAGE_POSITION_INVALID',
        ],
        [[{ imageId: first!, position: 0 }], 'VARIANT_IMAGE_POSITION_INVALID'],
      ];

      for (const [images, errorCode] of cases) {
        const res = await change(product.id, product.variantId, { images });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ errorCode });
      }
      expect(await imagesOfVariant(product.variantId)).toEqual([[first, 1]]);
    });
  });

  describe('which variant', () => {
    it('answers VARIANT_NOT_FOUND for a variant of another product or one that is not there', async () => {
      const product = await newProduct();
      const other = await newProduct();

      for (const variantId of [other.variantId, 2_000_000_000]) {
        const res = await change(product.id, variantId, { weightGrams: 400 });

        expect(res.statusCode).toBe(404);
        expect(res.json()).toMatchObject({ errorCode: 'VARIANT_NOT_FOUND' });
      }
    });

    it('answers PRODUCT_NOT_FOUND for a product that is not there', async () => {
      const res = await change(2_000_000_000, 1, { weightGrams: 400 });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
    });

    it('changes the variant of a product taken out of the catalog', async () => {
      const product = await newProduct();
      await deleteProductFromCatalog(product.id);

      const res = await change(product.id, product.variantId, { weightGrams: 410 });

      expect(res.statusCode).toBe(200);
      expect(res.json().variant).toMatchObject({ weightGrams: 410, visible: false });
    });

    it('changes the variant that is out of sale', async () => {
      const product = await newProduct();
      await markVariantDeleted(product.variantId);

      const res = await change(product.id, product.variantId, { weightGrams: 420 });

      expect(res.statusCode).toBe(200);
      expect(res.json().variant).toMatchObject({ weightGrams: 420, deletedAt: expect.any(String) });
    });
  });
});
