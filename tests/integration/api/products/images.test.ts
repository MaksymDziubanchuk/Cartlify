import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import cloudinary from '@config/cloudinary.js';
import { MAX_PRODUCT_IMAGES } from '@config/limits.js';
import { prisma } from '@db/client.js';
import { IMAGES_TX_BASE_MS, imagesTxTimeout } from '@routes/api/products/services/helpers/index.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import {
  bodyOf,
  brokenPng,
  deliveryUrl,
  gifImage,
  imageField,
  pngImage,
  removeUploads,
  storedImage,
  svgImage,
  moveCallsSince,
  movesSince,
  uploadMark,
  uploadsSince,
  waitingUploadsSince,
  withSilentCloudinaryMoves,
} from '../../../helpers/cloudinary.js';
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
import { hideSecrets } from '../../../helpers/hideSecrets.js';
import { takeLogs } from '../../../helpers/logs.js';
import { multipartBody, type FormPart } from '../../../helpers/multipart.js';
import { createProductForm, formVariant } from '../../../helpers/productForm.js';
import { manufacturerFormFields } from '../../../helpers/productSafety.js';
import {
  auditLinesOf,
  galleryIdsOf,
  imagesOfVariant,
  markVariantDeleted,
} from '../../../helpers/variants.js';

// The pictures of a product go to Cloudinary (its mock, or the real account with
// service:cloudinary, tests/helpers/cloudinary.ts): the gallery of POST /api/products and the
// pictures POST /api/products/:productId/images adds. Each waits at a waiting id until the rows are
// written and then moves to test/products/<id>/<a key of its own>, a new path for each upload: a
// file the product shows is never overwritten, the ones it no longer has go after the commit
// (DELETE /api/products/:productId/images/:imageId). A refused request moves nothing and leaves
// nothing waiting, which is what the refusals check: the id a refused form took is not in the
// answer, and other files make products at the same time. The gallery tests start from a product of
// the factory and give it its files through the route, so they do not depend on the create form

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let categoryId: number;
const userIds: number[] = [];
// products made by the factory; the ones made through the form are in the category of the file
const products: TestProduct[] = [];

// the path of an image of the product: a key of its own, never the path of an older image
const imagePath = (productId: number) => new RegExp(`^test/products/${productId}/[0-9a-f-]{36}$`);
const IMAGE_KEY = '[0-9a-f-]{36}';

const image = (data: Buffer, opts: Parameters<typeof imageField>[2] = {}) =>
  imageField('images', data, opts);

const createForm = (parts: FormPart[], actor: TestUser = admin) => {
  const { payload, headers } = multipartBody(parts);

  return app.inject({
    method: 'POST',
    url: '/api/products',
    headers: { ...withCsrf(csrf, accessCookie(actor)), ...headers },
    payload,
  });
};

// the fields of a form of a new product, with the variant that shows every file
const formFields = (files: number, over: Record<string, string> = {}): FormPart[] => {
  const form = [
    { name: 'name', value: `Image test product ${uniqueTag()}` },
    { name: 'categoryId', value: String(categoryId) },
    {
      name: 'variants',
      value: JSON.stringify([
        formVariant({
          images: Array.from({ length: files }, (_, i) => ({ file: i, position: i + 1 })),
        }),
      ]),
    },
  ];

  return [
    ...form.filter((part) => !(part.name in over)),
    ...Object.entries(over).map(([name, value]) => ({ name, value })),
  ];
};

const addImages = (productId: number | string, parts: FormPart[], actor: TestUser = admin) => {
  const { payload, headers } = multipartBody(parts);

  return app.inject({
    method: 'POST',
    url: `/api/products/${productId}/images`,
    headers: { ...withCsrf(csrf, accessCookie(actor)), ...headers },
    payload,
  });
};

const removeImage = (
  productId: number | string,
  imageId: number | string,
  actor: TestUser = admin,
) =>
  app.inject({
    method: 'DELETE',
    url: `/api/products/${productId}/images/${imageId}`,
    headers: withCsrf(csrf, accessCookie(actor)),
  });

const imagesOf = (productId: number) =>
  asAdmin((tx) =>
    tx.productImage.findMany({
      where: { productId },
      orderBy: [{ position: 'asc' }, { id: 'asc' }],
      select: { id: true, publicId: true, url: true, alt: true, position: true },
    }),
  );

// the rows without their urls, which carry the cloud name: a failed check prints what it compares
const withoutUrls = (rows: Awaited<ReturnType<typeof imagesOf>>) =>
  rows.map(({ id, publicId, alt, position }) => ({ id, publicId, alt, position }));

// a product of the catalog whose gallery got its files through the route
async function productWithImages(images: Buffer[]): Promise<TestProduct> {
  const product = await createProduct();
  products.push(product);

  const res = await addImages(
    product.id,
    images.map((data) => image(data)),
  );
  if (res.statusCode !== 201) throw new Error(`the image upload answered ${res.statusCode}`);

  return product;
}

// the files of the pictures the product has, in their order, to compare before and after a request
const filesOf = async (productId: number) =>
  Promise.all(
    (await imagesOf(productId))
      .filter((row) => row.publicId)
      .map((row) => storedImage(row.publicId!)),
  );

// an image url the app gives: the transforms, the version, the path of the file (a pattern)
const urlPattern = (transforms: string, path: string) =>
  new RegExp(
    `^${deliveryUrl(transforms).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}v\\d+/${path}\\.png$`,
  );
const pathOf = (productId: number) => `test/products/${productId}/${IMAGE_KEY}`;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('product images (Cloudinary)', () => {
  beforeAll(async () => {
    app = await startApp();
    csrf = await getCsrf(app);

    admin = await createUser({ role: 'ADMIN' });
    userIds.push(admin.id);

    const tag = uniqueTag();
    ({ id: categoryId } = await asAdmin((tx) =>
      tx.category.create({ data: { name: `Images ${tag}`, slug: `images-${tag}` } }),
    ));
  });

  // deletes every file the tests uploaded, a request to Cloudinary each: more time than a test
  afterAll(async () => {
    try {
      await removeUploads();
    } finally {
      try {
        // the products of the forms are in the category of the file, the others in their own
        await asAdmin(async (tx) => {
          await tx.product.deleteMany({ where: { categoryId } });
          await tx.category.deleteMany({ where: { id: categoryId } });
        });
        await removeProducts(products);
        await closeSessions(userIds);
      } finally {
        await stopApp();
      }
    }
  }, 120_000);

  describe('POST /api/products (the gallery of the form)', () => {
    it('uploads the images into the test folder in their order and gives their sizes', async () => {
      const mark = uploadMark();

      const res = await createForm([
        ...formFields(2),
        ...manufacturerFormFields(),
        image(pngImage(30, 20), { filename: 'front.png' }),
        image(pngImage(25, 25), { filename: 'back.png' }),
      ]);

      expect(res.statusCode).toBe(201);
      // the uploads moved to their places, nothing waits at a waiting id
      expect(uploadsSince(mark)).toHaveLength(2);
      expect(await waitingUploadsSince(mark)).toEqual([]);
      const body = bodyOf(res);
      const productId = body.product.id as number;
      expect(body.product.gallery).toHaveLength(2);
      for (const picture of body.product.gallery) {
        for (const size of [200, 400, 800]) {
          expect(picture[`url${size}`]).toMatch(
            urlPattern(`c_fit,w_${size},h_${size},f_auto,q_auto`, pathOf(productId)),
          );
        }
      }

      const rows = await imagesOf(productId);
      expect(withoutUrls(rows)).toEqual([
        {
          id: expect.any(Number),
          publicId: expect.stringMatching(imagePath(productId)),
          alt: 'front.png',
          position: 0,
        },
        {
          id: expect.any(Number),
          publicId: expect.stringMatching(imagePath(productId)),
          alt: 'back.png',
          position: 1,
        },
      ]);
      expect(rows[0]!.publicId).not.toBe(rows[1]!.publicId);
      expect(hideSecrets(rows[0]!.url)).toMatch(urlPattern('', rows[0]!.publicId!));

      expect(await filesOf(productId)).toEqual([
        expect.objectContaining({
          width: 30,
          height: 20,
          format: 'png',
          tags: expect.arrayContaining(['product', `product:${productId}`, 'pos:1']),
        }),
        expect.objectContaining({
          width: 25,
          height: 25,
          tags: expect.arrayContaining(['product', `product:${productId}`, 'pos:2']),
        }),
      ]);
    });

    it('shows the variant the first picture of its own list, in three sizes', async () => {
      const res = await createForm([
        ...formFields(2),
        ...manufacturerFormFields(),
        image(pngImage(30, 20)),
        image(pngImage(31, 20)),
      ]);

      const { variant, product } = bodyOf(res);
      expect(res.statusCode).toBe(201);
      expect(variant.image.url200).toBe(variant.images[0].url200);
      expect(variant.images[0].id).toBe(product.gallery[0].id);
    });

    it.each([
      ['no variants', { variants: '[]' }, 'VARIANTS_REQUIRED'],
      ['a stock', { stock: '5' }, 'PRODUCT_STOCK_NOT_ALLOWED'],
    ])('uploads nothing for a product with %s', async (_case, over, errorCode) => {
      const mark = uploadMark();

      const res = await createForm([
        ...formFields(1, over),
        ...manufacturerFormFields(),
        image(pngImage(30, 20)),
      ]);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
    });

    it('uploads nothing when one image of the form is refused', async () => {
      const mark = uploadMark();

      const res = await createForm([
        ...formFields(2),
        ...manufacturerFormFields(),
        image(Buffer.from('notes'), { contentType: 'text/plain', filename: 'notes.txt' }),
        image(pngImage(30, 20)),
      ]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
    });

    it('refuses an empty image and uploads nothing', async () => {
      const mark = uploadMark();

      const res = await createForm([
        ...formFields(1),
        ...manufacturerFormFields(),
        image(Buffer.alloc(0)),
      ]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'PRODUCT_IMAGE_STREAM_ERROR' });
      expect(uploadsSince(mark)).toEqual([]);
    });

    // the type a form names is the client's word; the file itself has to be a jpeg, png or webp
    it.each([
      ['text that says it is a png', Buffer.from('this is not an image')],
      ['a gif that says it is a png', gifImage()],
      ['an svg that says it is a png', svgImage()],
    ])('refuses %s and uploads nothing', async (_case, data) => {
      const mark = uploadMark();

      const res = await createForm([...formFields(1), ...manufacturerFormFields(), image(data)]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
      // the file is refused by its bytes, it never goes to Cloudinary
      expect(uploadsSince(mark)).toEqual([]);
    });

    it('refuses a png that Cloudinary cannot read and keeps no file', async () => {
      const mark = uploadMark();

      const res = await createForm([
        ...formFields(2),
        ...manufacturerFormFields(),
        image(pngImage(30, 20)),
        image(brokenPng()),
      ]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'IMAGE_INVALID' });
      // both went to Cloudinary: the one it took is deleted, the other it kept nothing of
      expect(uploadsSince(mark)).toHaveLength(2);
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
    });

    it('refuses a user before anything is uploaded', async () => {
      const user = await createUser();
      userIds.push(user.id);
      const mark = uploadMark();

      const res = await createForm(
        [...formFields(1), ...manufacturerFormFields(), image(pngImage(30, 20))],
        user,
      );

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
      expect(uploadsSince(mark)).toEqual([]);
    });

    it(`refuses more than ${MAX_PRODUCT_IMAGES} images and leaves nothing waiting`, async () => {
      const mark = uploadMark();
      const name = `Too many ${uniqueTag()}`;

      const res = await createForm([
        ...formFields(1, { name }),
        ...manufacturerFormFields(),
        ...Array.from({ length: MAX_PRODUCT_IMAGES + 1 }, (_, i) => image(pngImage(20 + i, 20))),
      ]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({
        errorCode: 'PRODUCT_IMAGES_TOO_MANY',
        details: { max: MAX_PRODUCT_IMAGES },
      });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
      expect(await asAdmin((tx) => tx.product.count({ where: { name } }))).toBe(0);
    });

    it('keeps nothing of a form whose variants are refused after the files were uploaded', async () => {
      const mark = uploadMark();

      const res = await createProductForm(app, csrf, admin, {
        categoryId,
        files: 2,
        variants: [formVariant({ price: -1 })],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VARIANTS_INVALID' });
      expect(uploadsSince(mark)).toHaveLength(2);
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
    });

    // a new place of an image never had a file, so there are no cached copies to drop; a move
    // runs inside the transaction and has 8 s at most
    it('moves each image to its new place without dropping cached copies, 8 s at most', async () => {
      const mark = uploadMark();

      const res = await createForm([
        ...formFields(2),
        ...manufacturerFormFields(),
        image(pngImage(30, 20)),
        image(pngImage(31, 20)),
      ]);

      expect(res.statusCode).toBe(201);
      const asked = moveCallsSince(mark);
      expect(asked).toHaveLength(2);
      for (const call of asked) {
        expect(call.to).toMatch(imagePath(res.json().product.id));
        expect(call.options).toMatchObject({ invalidate: false, timeout: 8_000 });
      }
    });

    // the moves run inside the transaction one after the other: it is given time for each file
    it('gives the transaction of the product time for every file', async () => {
      const transaction = jest.spyOn(prisma, '$transaction');

      const res = await createForm([
        ...formFields(3),
        ...manufacturerFormFields(),
        image(pngImage(30, 20)),
        image(pngImage(31, 20)),
        image(pngImage(32, 20)),
      ]);

      expect(res.statusCode).toBe(201);
      const timeouts = transaction.mock.calls.map(
        (call) => (call[1] as { timeout?: number } | undefined)?.timeout,
      );
      expect(timeouts).toContain(imagesTxTimeout(3));
    });

    // Cloudinary takes the move and never answers: the move gives up after its 8 s, well before
    // the transaction would run out, and the request is refused whole
    it('refuses the product when Cloudinary does not answer a move in 8 s, and keeps nothing', async () => {
      const name = `Silent move ${uniqueTag()}`;
      const mark = uploadMark();
      const startedAt = Date.now();

      const res = await withSilentCloudinaryMoves(async () =>
        createForm([
          ...formFields(1, { name }),
          ...manufacturerFormFields(),
          image(pngImage(32, 20)),
        ]),
      );
      const took = Date.now() - startedAt;

      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ errorCode: 'IMAGE_STORAGE_UNAVAILABLE' });
      expect(took).toBeGreaterThanOrEqual(8_000);
      expect(took).toBeLessThan(20_000);
      expect(await asAdmin((tx) => tx.product.count({ where: { name } }))).toBe(0);
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(
        takeLogs({ msg: 'request failed', errorCode: 'IMAGE_STORAGE_UNAVAILABLE' }),
      ).toHaveLength(1);
    });
  });

  describe('POST /api/products/:productId/images', () => {
    it('adds the pictures at the next places of the gallery, at paths of their own, and answers with the whole gallery', async () => {
      const product = await createProduct();
      products.push(product);
      const [first] = await galleryIdsOf(product.id);
      const mark = uploadMark();

      const res = await addImages(product.id, [
        image(pngImage(30, 20), { filename: 'side.png' }),
        image(pngImage(25, 25)),
      ]);

      expect(res.statusCode).toBe(201);
      expect(uploadsSince(mark)).toHaveLength(2);
      expect(await waitingUploadsSince(mark)).toEqual([]);
      const gallery = bodyOf(res).images as {
        id: number;
        position: number;
        url800: string;
        variantIds: number[];
      }[];
      // the picture the product had comes first, the new ones after it; no variant shows them yet
      expect(
        gallery.map((picture) => [picture.id === first, picture.position, picture.variantIds]),
      ).toEqual([
        [true, 0, [product.variantId]],
        [false, 1, []],
        [false, 2, []],
      ]);
      const rows = await imagesOf(product.id);
      expect(withoutUrls(rows.slice(1))).toEqual([
        {
          id: gallery[1]!.id,
          publicId: expect.stringMatching(imagePath(product.id)),
          alt: 'side.png',
          position: 1,
        },
        {
          id: gallery[2]!.id,
          publicId: expect.stringMatching(imagePath(product.id)),
          alt: 'image.png',
          position: 2,
        },
      ]);
      expect(gallery[1]!.url800).toMatch(
        urlPattern('c_fit,w_800,h_800,f_auto,q_auto', rows[1]!.publicId!),
      );
      expect(await storedImage(rows[1]!.publicId!)).toMatchObject({
        width: 30,
        height: 20,
        tags: expect.arrayContaining(['product', `product:${product.id}`]),
      });
    });

    it('goes on from the last place when more are added later', async () => {
      const product = await productWithImages([pngImage(30, 20)]);

      const res = await addImages(product.id, [image(pngImage(31, 21))]);

      expect(bodyOf(res).images.map((picture: { position: number }) => picture.position)).toEqual([
        0, 1, 2,
      ]);
    });

    it('keeps the pictures the product has, their files and their bindings', async () => {
      const product = await productWithImages([pngImage(30, 20)]);
      const before = await filesOf(product.id);
      const variantImages = await imagesOfVariant(product.variantId);

      await addImages(product.id, [image(pngImage(44, 22))]);

      expect((await filesOf(product.id)).slice(0, before.length)).toEqual(before);
      expect(await imagesOfVariant(product.variantId)).toEqual(variantImages);
    });

    it('shows the new picture to a variant only when the variant is told to', async () => {
      const product = await createProduct();
      products.push(product);
      const res = await addImages(product.id, [image(pngImage(30, 20))]);
      const added = bodyOf(res).images[1].id as number;
      const [first] = await galleryIdsOf(product.id);

      const change = await app.inject({
        method: 'PATCH',
        url: `/api/products/${product.id}/variants/${product.variantId}`,
        headers: withCsrf(csrf, accessCookie(admin)),
        payload: {
          images: [
            { imageId: first, position: 1 },
            { imageId: added, position: 2 },
          ],
        },
      });

      expect(change.statusCode).toBe(200);
      expect(change.json().variant.images.map((picture: { id: number }) => picture.id)).toEqual([
        first,
        added,
      ]);
    });

    it('writes the addition to the admin log and moves the last edit of the product', async () => {
      const product = await createProduct();
      products.push(product);
      const before = await asAdmin((tx) =>
        tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { updatedAt: true } }),
      );

      const res = await addImages(product.id, [image(pngImage(30, 20)), image(pngImage(31, 20))]);

      const added = bodyOf(res)
        .images.slice(1)
        .map((picture: { id: number }) => picture.id);
      expect(await auditLinesOf('product', product.id, ['product.gallery_add'])).toEqual([
        {
          actorId: admin.id,
          action: 'PRODUCT_UPDATE',
          event: 'product.gallery_add',
          meta: [{ field: 'images', old: null, new: added }],
        },
      ]);
      const after = await asAdmin((tx) =>
        tx.product.findUniqueOrThrow({ where: { id: product.id }, select: { updatedAt: true } }),
      );
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    });

    it('adds pictures to the gallery of a product taken out of the catalog', async () => {
      const product = await createProduct();
      products.push(product);
      await asAdmin((tx) =>
        tx.product.update({ where: { id: product.id }, data: { deletedAt: new Date() } }),
      );

      const res = await addImages(product.id, [image(pngImage(30, 20))]);

      expect(res.statusCode).toBe(201);
    });

    it('refuses a gallery with more pictures than the limit, counting the ones it has, and keeps nothing of the request', async () => {
      const product = await createProduct();
      products.push(product);
      // the gallery is one short of full
      await asAdmin((tx) =>
        tx.productImage.createMany({
          data: Array.from({ length: MAX_PRODUCT_IMAGES - 2 }, (_, i) => ({
            productId: product.id,
            url: `https://res.cloudinary.com/demo/image/upload/v1/products/test/fill-${i}.jpg`,
            position: i + 1,
          })),
        }),
      );
      const mark = uploadMark();

      const refused = await addImages(product.id, [
        image(pngImage(30, 20)),
        image(pngImage(31, 20)),
      ]);
      const taken = await addImages(product.id, [image(pngImage(32, 20))]);

      expect(refused.statusCode).toBe(400);
      expect(bodyOf(refused)).toMatchObject({
        errorCode: 'PRODUCT_IMAGES_TOO_MANY',
        details: { max: MAX_PRODUCT_IMAGES, have: MAX_PRODUCT_IMAGES - 1 },
      });
      expect(taken.statusCode).toBe(201);
      // the refused request left nothing waiting and moved nothing: only the one file moved
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toHaveLength(1);
      expect(await imagesOf(product.id)).toHaveLength(MAX_PRODUCT_IMAGES);
    });

    it(`refuses more than ${MAX_PRODUCT_IMAGES} files in a request`, async () => {
      const product = await createProduct();
      products.push(product);
      const mark = uploadMark();

      const res = await addImages(
        product.id,
        Array.from({ length: MAX_PRODUCT_IMAGES + 1 }, (_, i) => image(pngImage(20 + i, 20))),
      );

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({
        errorCode: 'PRODUCT_IMAGES_TOO_MANY',
        details: { max: MAX_PRODUCT_IMAGES },
      });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
    });

    // a refusal that the first look at the gallery knows costs no upload at all
    it('refuses a full gallery before a file is uploaded', async () => {
      const product = await createProduct();
      products.push(product);
      await asAdmin((tx) =>
        tx.productImage.createMany({
          data: Array.from({ length: MAX_PRODUCT_IMAGES - 1 }, (_, i) => ({
            productId: product.id,
            url: `https://res.cloudinary.com/demo/image/upload/v1/products/test/full-${i}.jpg`,
            position: i + 1,
          })),
        }),
      );
      const mark = uploadMark();

      const res = await addImages(product.id, [image(pngImage(30, 20)), image(pngImage(31, 20))]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({
        errorCode: 'PRODUCT_IMAGES_TOO_MANY',
        details: { max: MAX_PRODUCT_IMAGES, have: MAX_PRODUCT_IMAGES },
      });
      expect(uploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
      expect(await imagesOf(product.id)).toHaveLength(MAX_PRODUCT_IMAGES);
    });

    it('stops at the file the gallery has no room for: the files after it are not uploaded', async () => {
      const product = await createProduct();
      products.push(product);
      // the gallery has room for one picture more
      await asAdmin((tx) =>
        tx.productImage.createMany({
          data: Array.from({ length: MAX_PRODUCT_IMAGES - 2 }, (_, i) => ({
            productId: product.id,
            url: `https://res.cloudinary.com/demo/image/upload/v1/products/test/room-${i}.jpg`,
            position: i + 1,
          })),
        }),
      );
      const mark = uploadMark();

      const res = await addImages(product.id, [
        image(pngImage(30, 20)),
        image(pngImage(31, 20)),
        image(pngImage(32, 20)),
      ]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({
        errorCode: 'PRODUCT_IMAGES_TOO_MANY',
        details: { max: MAX_PRODUCT_IMAGES, have: MAX_PRODUCT_IMAGES - 1 },
      });
      // the first file began its upload before the second was seen; the others never did
      expect(uploadsSince(mark)).toHaveLength(1);
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
      expect(await imagesOf(product.id)).toHaveLength(MAX_PRODUCT_IMAGES - 1);
    });

    // the moves at Cloudinary run inside the transaction one after the other, so it is given time
    // for each file, not one limit for any number
    it('gives the transaction time for every file', async () => {
      const product = await createProduct();
      products.push(product);
      const transaction = jest.spyOn(prisma, '$transaction');

      const res = await addImages(product.id, [
        image(pngImage(30, 20)),
        image(pngImage(31, 20)),
        image(pngImage(32, 20)),
      ]);

      expect(res.statusCode).toBe(201);
      const timeouts = transaction.mock.calls.map(
        (call) => (call[1] as { timeout?: number } | undefined)?.timeout,
      );
      expect(timeouts).toContain(imagesTxTimeout(3));
      expect(imagesTxTimeout(3)).toBeGreaterThan(IMAGES_TX_BASE_MS);
    });

    // the moves ran one by one: the third move failed, the transaction went back
    it('keeps the gallery as it was when a move fails in the middle', async () => {
      const product = await productWithImages([pngImage(30, 20), pngImage(25, 25)]);
      const rowsBefore = await imagesOf(product.id);
      const filesBefore = await filesOf(product.id);
      const mark = uploadMark();
      const rename = cloudinary.uploader.rename;
      let calls = 0;
      jest
        .spyOn(cloudinary.uploader, 'rename')
        .mockImplementation(((...args: Parameters<typeof rename>) =>
          (calls += 1) === 3
            ? Promise.reject(new Error('cloudinary is down'))
            : rename(...args)) as typeof rename);

      const res = await addImages(product.id, [
        image(pngImage(41, 21)),
        image(pngImage(42, 22)),
        image(pngImage(43, 23)),
      ]);

      expect(res.statusCode).toBe(500);
      expect(takeLogs({ msg: 'request failed' })).toHaveLength(1);
      expect(hideSecrets(JSON.stringify(await imagesOf(product.id)))).toBe(
        hideSecrets(JSON.stringify(rowsBefore)),
      );
      expect(await filesOf(product.id)).toEqual(filesBefore);
      // the files that moved before the failure and the uploads that waited are gone too
      const moved = movesSince(mark);
      expect(moved).toHaveLength(2);
      expect(await Promise.all(moved.map((publicId) => storedImage(publicId)))).toEqual([
        null,
        null,
      ]);
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(await auditLinesOf('product', product.id, ['product.gallery_add'])).toHaveLength(1);
    });

    it('wants a file (PRODUCT_IMAGES_REQUIRED) and a form (MULTIPART_REQUIRED)', async () => {
      const product = await createProduct();
      products.push(product);

      const noFile = await addImages(product.id, [{ name: 'note', value: 'text' }]);
      const json = await app.inject({
        method: 'POST',
        url: `/api/products/${product.id}/images`,
        headers: withCsrf(csrf, accessCookie(admin)),
        payload: {},
      });

      expect(noFile.statusCode).toBe(400);
      expect(noFile.json()).toMatchObject({ errorCode: 'PRODUCT_IMAGES_REQUIRED' });
      expect(json.statusCode).toBe(400);
      expect(json.json()).toMatchObject({ errorCode: 'MULTIPART_REQUIRED' });
    });

    it('refuses a file that is no image and keeps the gallery', async () => {
      const product = await productWithImages([pngImage(30, 20)]);
      const rowsBefore = await imagesOf(product.id);
      const mark = uploadMark();

      const res = await addImages(product.id, [
        image(pngImage(44, 22)),
        image(Buffer.from('notes'), { contentType: 'text/plain', filename: 'notes.txt' }),
      ]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(hideSecrets(JSON.stringify(await imagesOf(product.id)))).toBe(
        hideSecrets(JSON.stringify(rowsBefore)),
      );
    });

    it('uploads nothing for a product that does not exist', async () => {
      const mark = uploadMark();

      const res = await addImages(2_000_000_000, [image(pngImage(44, 22))]);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
      // the product is looked for before the files are read: none began its upload
      expect(uploadsSince(mark)).toEqual([]);
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
    });

    it('refuses a user before anything is uploaded', async () => {
      const user = await createUser();
      userIds.push(user.id);
      const product = await productWithImages([pngImage(30, 20)]);
      const before = await filesOf(product.id);
      const mark = uploadMark();

      const res = await addImages(product.id, [image(pngImage(44, 22))], user);

      expect(res.statusCode).toBe(403);
      expect(uploadsSince(mark)).toEqual([]);
      expect(await filesOf(product.id)).toEqual(before);
    });
  });

  describe('DELETE /api/products/:productId/images/:imageId', () => {
    it('takes the picture out of the gallery, deletes its file, and writes the admin log', async () => {
      const product = await productWithImages([pngImage(30, 20), pngImage(25, 25)]);
      const [, second] = await imagesOf(product.id);

      const res = await removeImage(product.id, second!.id);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: second!.id, variantsWithoutImages: [] });
      expect((await imagesOf(product.id)).map((row) => row.id)).not.toContain(second!.id);
      expect(await storedImage(second!.publicId!)).toBeNull();
      expect(await auditLinesOf('product', product.id, ['product.gallery_remove'])).toEqual([
        {
          actorId: admin.id,
          action: 'PRODUCT_UPDATE',
          event: 'product.gallery_remove',
          meta: [{ field: 'images', old: [second!.id], new: null }],
        },
      ]);
    });

    it('takes the picture from the variants that showed it and names the ones it leaves with no picture', async () => {
      const product = await productWithImages([pngImage(30, 20)]);
      const [first, added] = await imagesOf(product.id);
      // one variant shows only the picture, another shows it and the first one
      const only = await createVariant(product.id, { imageIds: [added!.id] });
      const both = await createVariant(product.id, { imageIds: [first!.id, added!.id] });
      const gone = await createVariant(product.id, { imageIds: [added!.id] });
      await markVariantDeleted(gone.id);

      const res = await removeImage(product.id, added!.id);

      expect(res.statusCode).toBe(200);
      // only the variants for sale are named, the one taken out of sale is not
      expect(res.json()).toEqual({ id: added!.id, variantsWithoutImages: [only.id] });
      expect(await imagesOfVariant(only.id)).toEqual([]);
      expect(await imagesOfVariant(both.id)).toEqual([[first!.id, 1]]);
      expect(await imagesOfVariant(gone.id)).toEqual([]);
      // the variant that is left with no picture is hidden from a buyer
      const card = await app.inject({ method: 'GET', url: `/api/products/${product.id}` });
      expect(card.json().variants.map((v: { id: number }) => v.id)).toEqual([
        product.variantId,
        both.id,
      ]);
    });

    it('hides the whole product from a buyer when its last picture goes', async () => {
      const product = await createProduct();
      products.push(product);
      const [only] = await galleryIdsOf(product.id);

      const res = await removeImage(product.id, only!);

      expect(res.json()).toEqual({ id: only, variantsWithoutImages: [product.variantId] });
      const card = await app.inject({ method: 'GET', url: `/api/products/${product.id}` });
      expect(card.statusCode).toBe(404);
    });

    it('answers 404 for a picture of another product, a picture that is not there, a product that is not there', async () => {
      const product = await createProduct();
      const other = await createProduct();
      products.push(product, other);
      const [foreign] = await galleryIdsOf(other.id);

      const wrongProduct = await removeImage(product.id, foreign!);
      const missing = await removeImage(product.id, 2_000_000_000);
      const noProduct = await removeImage(2_000_000_000, 1);

      expect(wrongProduct.statusCode).toBe(404);
      expect(wrongProduct.json()).toMatchObject({ errorCode: 'PRODUCT_IMAGE_NOT_FOUND' });
      expect(missing.json()).toMatchObject({ errorCode: 'PRODUCT_IMAGE_NOT_FOUND' });
      expect(noProduct.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
      expect(await galleryIdsOf(other.id)).toEqual([foreign]);
    });

    it('refuses a user and keeps the picture', async () => {
      const user = await createUser();
      userIds.push(user.id);
      const product = await createProduct();
      products.push(product);
      const [only] = await galleryIdsOf(product.id);

      const res = await removeImage(product.id, only!, user);

      expect(res.statusCode).toBe(403);
      expect(await galleryIdsOf(product.id)).toEqual([only]);
    });
  });

  describe('PATCH /api/products/:productId', () => {
    it('refuses a file of a form: the pictures of a product are its gallery', async () => {
      const product = await productWithImages([pngImage(30, 20)]);
      const rowsBefore = await imagesOf(product.id);
      const mark = uploadMark();
      const { payload, headers } = multipartBody([
        { name: 'name', value: 'Renamed with a file' },
        image(pngImage(44, 22)),
      ]);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/products/${product.id}`,
        headers: { ...withCsrf(csrf, accessCookie(admin)), ...headers },
        payload,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_IMAGES_NOT_ALLOWED' });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(hideSecrets(JSON.stringify(await imagesOf(product.id)))).toBe(
        hideSecrets(JSON.stringify(rowsBefore)),
      );
    });

    // a picture of a product is a file the app uploaded; a json body could point it anywhere
    it('refuses pictures sent in a json body and keeps the gallery', async () => {
      const product = await productWithImages([pngImage(30, 20)]);
      const rowsBefore = await imagesOf(product.id);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/products/${product.id}`,
        headers: withCsrf(csrf, accessCookie(admin)),
        payload: {
          images: [
            { publicId: 'elsewhere/1', urlBase: 'https://images.example.com/1.png', position: 0 },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(hideSecrets(JSON.stringify(await imagesOf(product.id)))).toBe(
        hideSecrets(JSON.stringify(rowsBefore)),
      );
    });
  });
});
