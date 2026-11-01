import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { MAX_PRODUCT_IMAGES } from '@config/limits.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { imageField, pngImage, removeUploads } from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  createVariant,
  removeProducts,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { multipartBody } from '../../../helpers/multipart.js';
import {
  addGalleryImage,
  auditLinesOf,
  galleryIdsOf,
  imagesOfVariant,
  lockImageRow,
  lockProductRow,
  lockVariantRow,
  markVariantDeleted,
  tellingAttribute,
  variantRowsOf,
  whileLocked,
} from '../../../helpers/variants.js';

// Requests that meet over one product: a write reads, then writes, so two of them (or one and a
// delete of the row it reads) must not both act on what they read. The tests hold the row the
// requests lock in a transaction of their own (tests/helpers/variants.ts, whileLocked): the
// requests run into it, and what one of them would have changed meanwhile is written before the lock
// goes, so the race is lost the same way on every run. The tests that fire real requests at each
// other (Promise.all) check what must hold whichever of them comes first

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
    await removeUploads();
  } finally {
    try {
      await removeProducts(products);
      await closeSessions([admin.id]);
    } finally {
      await stopApp();
    }
  }
}, 120_000);

const newProduct = async (opts: Parameters<typeof createProduct>[0] = {}) => {
  const product = await createProduct(opts);
  products.push(product);
  return product;
};

const headers = () => withCsrf(csrf, accessCookie(admin));

const addVariants = (productId: number, variants: unknown[]) =>
  app.inject({
    method: 'POST',
    url: `/api/products/${productId}/variants`,
    headers: headers(),
    payload: { variants },
  });

const changeVariant = (productId: number, variantId: number, payload: unknown) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/variants/${variantId}`,
    headers: headers(),
    payload: payload as Record<string, unknown>,
  });

const removeVariant = (productId: number, variantId: number) =>
  app.inject({
    method: 'DELETE',
    url: `/api/products/${productId}/variants/${variantId}`,
    headers: headers(),
  });

const restoreVariant = (productId: number, variantId: number) =>
  app.inject({
    method: 'POST',
    url: `/api/products/${productId}/variants/${variantId}/restore`,
    headers: headers(),
  });

const removeProduct = (productId: number) =>
  app.inject({ method: 'DELETE', url: `/api/products/${productId}`, headers: headers() });

const removeImage = (productId: number, imageId: number) =>
  app.inject({
    method: 'DELETE',
    url: `/api/products/${productId}/images/${imageId}`,
    headers: headers(),
  });

// a form with `files` different pictures
const uploadImages = (productId: number, files: number, seed: number) => {
  const { payload, headers: form } = multipartBody(
    Array.from({ length: files }, (_, i) =>
      imageField('images', pngImage(20 + seed * 10 + i, 20 + seed)),
    ),
  );

  return app.inject({
    method: 'POST',
    url: `/api/products/${productId}/images`,
    headers: { ...headers(), ...form },
    payload,
  });
};

// every variant a test makes has a value of its own, or it would repeat the one before (no two
// variants of a product have the same values: VARIANT_DUPLICATE)
let kinds = 0;

const newVariant = (imageId: number, over: Record<string, unknown> = {}) => ({
  price: 15,
  weightGrams: 300,
  lengthMm: 100,
  widthMm: 80,
  heightMm: 40,
  images: [{ imageId, position: 1 }],
  attributes: [{ attributeId: telling.id, value: `Kind ${(kinds += 1)}` }],
  ...over,
});

const statusesOf = (results: { statusCode: number }[]) =>
  results.map((res) => res.statusCode).sort((a, b) => a - b);

const liveVariants = (productId: number) =>
  asAdmin((tx) => tx.productVariant.count({ where: { productId, deletedAt: null } }));

const galleryOf = (productId: number) =>
  asAdmin((tx) =>
    tx.productImage.findMany({
      where: { productId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, position: true },
    }),
  );

describe('adding variants while the product is deleted', () => {
  // the request read the product as it is for sale, then the delete came before the request got to
  // the row: a variant under a product that is out of the catalog must not be left for sale
  it('does not add a variant for sale to a product that is deleted meanwhile', async () => {
    const product = await newProduct();
    const [image] = await galleryIdsOf(product.id);

    const res = await whileLocked(
      (tx) => lockProductRow(tx, product.id),
      () => addVariants(product.id, [newVariant(image!)]),
      {
        waiters: 1,
        beforeRelease: async (tx) => {
          await tx.product.update({ where: { id: product.id }, data: { deletedAt: new Date() } });
        },
      },
    );

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_DELETED' });
    expect(await variantRowsOf(product.id)).toHaveLength(1);
    expect(await liveVariants(product.id)).toBe(0);
  });

  it('leaves no variant for sale under a product that was deleted, whichever request comes first', async () => {
    for (let round = 0; round < 5; round += 1) {
      const product = await newProduct();
      const [image] = await galleryIdsOf(product.id);

      const [added, removed] = await Promise.all([
        addVariants(product.id, [newVariant(image!), newVariant(image!, { price: 16 })]),
        removeProduct(product.id),
      ]);

      expect(removed.statusCode).toBe(200);
      expect([201, 409]).toContain(added.statusCode);
      if (added.statusCode === 409) {
        expect(added.json()).toMatchObject({ errorCode: 'PRODUCT_DELETED' });
      }
      expect(await liveVariants(product.id)).toBe(0);
    }
  });
});

describe('two uploads to one gallery', () => {
  // both requests count the pictures the gallery has and take the places after its last one
  it('keeps the limit: the upload that finds the gallery full is refused', async () => {
    const product = await newProduct();
    // the gallery is one short of full
    await asAdmin((tx) =>
      tx.productImage.createMany({
        data: Array.from({ length: MAX_PRODUCT_IMAGES - 2 }, (_, i) => ({
          productId: product.id,
          url: `https://res.cloudinary.com/demo/image/upload/v1/products/test/race-${i}.jpg`,
          position: i + 1,
        })),
      }),
    );

    const results = await whileLocked(
      (tx) => lockProductRow(tx, product.id),
      () => Promise.all([uploadImages(product.id, 1, 1), uploadImages(product.id, 1, 2)]),
      { waiters: 2 },
    );

    expect(statusesOf(results)).toEqual([201, 400]);
    const refused = results.find((res) => res.statusCode === 400)!;
    expect(refused.json()).toMatchObject({
      errorCode: 'PRODUCT_IMAGES_TOO_MANY',
      details: { max: MAX_PRODUCT_IMAGES, have: MAX_PRODUCT_IMAGES },
    });
    expect(await galleryOf(product.id)).toHaveLength(MAX_PRODUCT_IMAGES);
  });

  it('gives the pictures of both places of their own', async () => {
    const product = await newProduct();

    const results = await whileLocked(
      (tx) => lockProductRow(tx, product.id),
      () => Promise.all([uploadImages(product.id, 2, 3), uploadImages(product.id, 2, 4)]),
      { waiters: 2 },
    );

    expect(statusesOf(results)).toEqual([201, 201]);
    // the factory made the first picture at 0
    expect((await galleryOf(product.id)).map((image) => image.position)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('two deletes or two restores of one variant', () => {
  it('takes the variant out of sale once: the other request is VARIANT_ALREADY_DELETED', async () => {
    const product = await newProduct();

    const results = await whileLocked(
      (tx) => lockVariantRow(tx, product.variantId),
      () =>
        Promise.all([
          removeVariant(product.id, product.variantId),
          removeVariant(product.id, product.variantId),
        ]),
      { waiters: 2 },
    );

    expect(statusesOf(results)).toEqual([200, 409]);
    expect(results.find((res) => res.statusCode === 409)!.json()).toMatchObject({
      errorCode: 'VARIANT_ALREADY_DELETED',
    });
    // one line in the admin log for the one delete
    expect(await auditLinesOf('variant', product.variantId, ['variant.delete'])).toHaveLength(1);
    expect((await variantRowsOf(product.id))[0]!.deletedAt).not.toBeNull();
  });

  it('puts the variant back once: the other request is VARIANT_NOT_DELETED', async () => {
    const product = await newProduct();
    await markVariantDeleted(product.variantId);

    const results = await whileLocked(
      (tx) => lockVariantRow(tx, product.variantId),
      () =>
        Promise.all([
          restoreVariant(product.id, product.variantId),
          restoreVariant(product.id, product.variantId),
        ]),
      { waiters: 2 },
    );

    expect(statusesOf(results)).toEqual([200, 409]);
    expect(results.find((res) => res.statusCode === 409)!.json()).toMatchObject({
      errorCode: 'VARIANT_NOT_DELETED',
    });
    expect(await auditLinesOf('variant', product.variantId, ['variant.restore'])).toHaveLength(1);
    expect((await variantRowsOf(product.id))[0]!.deletedAt).toBeNull();
  });

  it('answers one 200 and one 409 for two deletes fired together', async () => {
    const product = await newProduct();

    const results = await Promise.all([
      removeVariant(product.id, product.variantId),
      removeVariant(product.id, product.variantId),
    ]);

    expect(statusesOf(results)).toEqual([200, 409]);
    expect(await auditLinesOf('variant', product.variantId, ['variant.delete'])).toHaveLength(1);
  });

  // the delete of the product is in flight: it took the variants that are for sale and has not
  // committed. A variant put back now would be missed by it and stay for sale under a deleted product
  it('does not put a variant back under a product whose delete is in flight', async () => {
    const product = await newProduct();
    await markVariantDeleted(product.variantId);

    const res = await whileLocked(
      async (tx) => {
        await tx.product.update({ where: { id: product.id }, data: { deletedAt: new Date() } });
      },
      () => restoreVariant(product.id, product.variantId),
      { waiters: 1 },
    );

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_DELETED' });
    expect(await liveVariants(product.id)).toBe(0);
  });
});

describe('a picture deleted from the gallery while a variant is given it', () => {
  // the variant is changed to show a picture that another request takes out of the gallery after
  // the change read it: the binding to a picture that is gone is refused, no 500
  it('refuses the change of a variant with VARIANT_IMAGE_NOT_FOUND and keeps its pictures', async () => {
    const product = await newProduct();
    const picture = await addGalleryImage(product.id);
    const before = await imagesOfVariant(product.variantId);

    const res = await whileLocked(
      (tx) => lockImageRow(tx, picture),
      () =>
        changeVariant(product.id, product.variantId, {
          images: [{ imageId: picture, position: 1 }],
        }),
      {
        waiters: 1,
        beforeRelease: async (tx) => {
          await tx.productImage.delete({ where: { id: picture } });
        },
      },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANT_IMAGE_NOT_FOUND',
      details: { imageIds: [picture] },
    });
    expect(await imagesOfVariant(product.variantId)).toEqual(before);
  });

  it('names the variant of a request that adds variants, among the others', async () => {
    const product = await newProduct();
    const [kept] = await galleryIdsOf(product.id);
    const picture = await addGalleryImage(product.id);

    const res = await whileLocked(
      (tx) => lockImageRow(tx, picture),
      () => addVariants(product.id, [newVariant(kept!), newVariant(picture, { price: 17 })]),
      {
        waiters: 1,
        beforeRelease: async (tx) => {
          await tx.productImage.delete({ where: { id: picture } });
        },
      },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANTS_INVALID',
      details: {
        variants: [
          { index: 1, errorCode: 'VARIANT_IMAGE_NOT_FOUND', details: { imageIds: [picture] } },
        ],
      },
    });
    expect(await variantRowsOf(product.id)).toHaveLength(1);
  });

  it('never fails with a 500 when the picture goes while a variant changes to show it', async () => {
    for (let round = 0; round < 6; round += 1) {
      const product = await newProduct();
      const picture = await addGalleryImage(product.id);

      const [changed, removed] = await Promise.all([
        changeVariant(product.id, product.variantId, {
          images: [{ imageId: picture, position: 1 }],
        }),
        removeImage(product.id, picture),
      ]);

      expect(removed.statusCode).toBe(200);
      expect([200, 400]).toContain(changed.statusCode);
      if (changed.statusCode === 400) {
        expect(changed.json()).toMatchObject({ errorCode: 'VARIANT_IMAGE_NOT_FOUND' });
      }
      // the picture is gone, so is every binding to it
      expect(await asAdmin((tx) => tx.variantImage.count({ where: { imageId: picture } }))).toBe(0);
    }
  });

  it('never fails with a 500 when the picture goes while a variant is added with it', async () => {
    for (let round = 0; round < 6; round += 1) {
      const product = await newProduct();
      const picture = await addGalleryImage(product.id);

      const [added, removed] = await Promise.all([
        addVariants(product.id, [newVariant(picture)]),
        removeImage(product.id, picture),
      ]);

      expect(removed.statusCode).toBe(200);
      expect([201, 400]).toContain(added.statusCode);
      if (added.statusCode === 400) {
        expect(added.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
      }
      expect(await asAdmin((tx) => tx.variantImage.count({ where: { imageId: picture } }))).toBe(0);
    }
  });
});

const changeVariants = (productId: number, payload: unknown) =>
  app.inject({
    method: 'PATCH',
    url: `/api/products/${productId}/variants`,
    headers: headers(),
    payload: payload as Record<string, unknown>,
  });

const changeBatch = (items: unknown[]) =>
  app.inject({
    method: 'PATCH',
    url: '/api/products/variants/batch',
    headers: headers(),
    payload: { items },
  });

// the same race for the forms that change many variants: the pictures are checked and locked once
// the rows of the variants are, and a picture that goes meanwhile is a wrong picture, no 500
describe('a picture deleted from the gallery while many variants are given it', () => {
  it('refuses the change of several variants with VARIANT_IMAGE_NOT_FOUND and keeps their pictures', async () => {
    const product = await newProduct();
    const second = await createVariant(product.id);
    const picture = await addGalleryImage(product.id);
    const before = [await imagesOfVariant(product.variantId), await imagesOfVariant(second.id)];

    const res = await whileLocked(
      (tx) => lockImageRow(tx, picture),
      () => changeVariants(product.id, { images: [{ imageId: picture, position: 1 }] }),
      {
        waiters: 1,
        beforeRelease: async (tx) => {
          await tx.productImage.delete({ where: { id: picture } });
        },
      },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANT_IMAGE_NOT_FOUND',
      details: { imageIds: [picture] },
    });
    expect([await imagesOfVariant(product.variantId), await imagesOfVariant(second.id)]).toEqual(
      before,
    );
  });

  it('names the item of a batch whose picture goes, among the others', async () => {
    const product = await newProduct();
    const other = await newProduct();
    const picture = await addGalleryImage(product.id);
    const before = await imagesOfVariant(product.variantId);

    const res = await whileLocked(
      (tx) => lockImageRow(tx, picture),
      () =>
        changeBatch([
          { variantId: other.variantId, images: [] },
          { variantId: product.variantId, images: [{ imageId: picture, position: 1 }] },
        ]),
      {
        waiters: 1,
        beforeRelease: async (tx) => {
          await tx.productImage.delete({ where: { id: picture } });
        },
      },
    );

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'VARIANTS_INVALID',
      details: {
        variants: [
          {
            variantId: product.variantId,
            errorCode: 'VARIANT_IMAGE_NOT_FOUND',
            details: { imageIds: [picture] },
          },
        ],
      },
    });
    expect(await imagesOfVariant(product.variantId)).toEqual(before);
    expect(await imagesOfVariant(other.variantId)).not.toEqual([]);
  });

  it('never fails with a 500 when the picture goes while several variants or a batch change to show it', async () => {
    for (let round = 0; round < 4; round += 1) {
      const product = await newProduct();
      await createVariant(product.id);
      const picture = await addGalleryImage(product.id);
      const other = await newProduct();
      const otherPicture = await addGalleryImage(other.id);

      const [many, batch, removed, removedOther] = await Promise.all([
        changeVariants(product.id, { images: [{ imageId: picture, position: 1 }] }),
        changeBatch([
          { variantId: other.variantId, images: [{ imageId: otherPicture, position: 1 }] },
        ]),
        removeImage(product.id, picture),
        removeImage(other.id, otherPicture),
      ]);

      expect(removed.statusCode).toBe(200);
      expect(removedOther.statusCode).toBe(200);
      expect([200, 400]).toContain(many.statusCode);
      if (many.statusCode === 400) {
        expect(many.json()).toMatchObject({ errorCode: 'VARIANT_IMAGE_NOT_FOUND' });
      }
      expect([200, 400]).toContain(batch.statusCode);
      if (batch.statusCode === 400) {
        expect(batch.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
      }
      // the pictures are gone, so is every binding to them
      expect(
        await asAdmin((tx) =>
          tx.variantImage.count({ where: { imageId: { in: [picture, otherPicture] } } }),
        ),
      ).toBe(0);
    }
  });
});
