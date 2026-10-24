import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import cloudinary from '@config/cloudinary.js';

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
  movesSince,
  uploadMark,
  uploadsSince,
  waitingUploadsSince,
} from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  stockOf,
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { hideSecrets } from '../../../helpers/hideSecrets.js';
import { takeLogs } from '../../../helpers/logs.js';
import { multipartBody, type FormPart } from '../../../helpers/multipart.js';
import { safetyFormFields } from '../../../helpers/productSafety.js';

// the images of POST /api/products and PATCH /api/products/:productId go to Cloudinary (its mock,
// or the real account with service:cloudinary, tests/helpers/cloudinary.ts): each waits at a waiting id until the product is written and then moves to
// test/products/<id>/<a key of its own>, a new path for each upload: a file the product shows is
// never overwritten, the ones it no longer has go after the commit. A refused request moves nothing and leaves nothing
// waiting, which is what the refusals check: the id a refused form took is not in the answer,
// and other files make products at the same time. The PATCH tests start from a product of the
// factory and give it its files through PATCH, so they do not depend on the create form

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

const fields = (values: Record<string, string | undefined>): FormPart[] =>
  Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => ({ name, value }));

// a new product needs the safety data of its manufacturer
const productFields = (overrides: Record<string, string | undefined> = {}) => [
  ...fields({
    name: `Image test product ${uniqueTag()}`,
    price: '10',
    categoryId: String(categoryId),
    ...overrides,
  }),
  ...safetyFormFields(),
];

const image = (data: Buffer, opts: Parameters<typeof imageField>[2] = {}) =>
  imageField('images', data, opts);

const sendForm = (
  method: 'POST' | 'PATCH',
  url: string,
  parts: FormPart[],
  actor: TestUser = admin,
) => {
  const { payload, headers } = multipartBody(parts);

  return app.inject({
    method,
    url,
    headers: { ...withCsrf(csrf, accessCookie(actor)), ...headers },
    payload,
  });
};

const createForm = (parts: FormPart[], actor?: TestUser) =>
  sendForm('POST', '/api/products', parts, actor);

const patchForm = (productId: number, parts: FormPart[], actor?: TestUser) =>
  sendForm('PATCH', `/api/products/${productId}`, parts, actor);

const imagesOf = (productId: number) =>
  asAdmin((tx) =>
    tx.productImage.findMany({
      where: { productId },
      orderBy: { position: 'asc' },
      select: { publicId: true, url: true, alt: true, position: true, isPrimary: true },
    }),
  );

// the rows without their urls, which carry the cloud name: a failed check prints what it compares
const withoutUrls = (rows: Awaited<ReturnType<typeof imagesOf>>) =>
  rows.map(({ publicId, alt, position, isPrimary }) => ({ publicId, alt, position, isPrimary }));

// a product of the catalog whose images were uploaded through the form
async function productWithImages(images: Buffer[]): Promise<number> {
  const product = await createProduct();
  products.push(product);

  const res = await patchForm(
    product.id,
    images.map((data) => image(data)),
  );
  if (res.statusCode !== 200) throw new Error(`the image upload answered ${res.statusCode}`);

  return product.id;
}

// the files of the images the product has, in their order, to compare before and after a request
const filesOf = async (productId: number) =>
  Promise.all((await imagesOf(productId)).map((row) => storedImage(row.publicId!)));

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

  describe('POST /api/products', () => {
    it('creates the product with its fields and its images from one form', async () => {
      const res = await createForm([
        ...productFields({ name: 'Form headphones', description: 'Over-ear.', price: '49.99' }),
        image(pngImage(30, 20)),
      ]);

      expect(res.statusCode).toBe(201);
      expect(bodyOf(res)).toMatchObject({
        name: 'Form headphones',
        description: 'Over-ear.',
        price: 49.99,
        // a new product has no stock, it comes with a delivery
        stock: 0,
        category: expect.objectContaining({ id: categoryId }),
        images: [expect.any(Object)],
      });
      const row = await asAdmin((tx) =>
        tx.product.findUniqueOrThrow({
          where: { id: res.json().id },
          select: { name: true, description: true, stock: true, categoryId: true },
        }),
      );
      // the description keeps the text with the safety data
      expect({ ...row, description: JSON.parse(row.description!).text }).toEqual({
        name: 'Form headphones',
        description: 'Over-ear.',
        stock: 0,
        categoryId,
      });
    });

    it('uploads the images into the test folder in their order and gives their sizes', async () => {
      const mark = uploadMark();

      const res = await createForm([
        ...productFields(),
        image(pngImage(30, 20), { filename: 'front.png' }),
        image(pngImage(25, 25), { filename: 'back.png' }),
      ]);

      expect(res.statusCode).toBe(201);
      // the uploads moved to their places, nothing waits at a waiting id
      expect(uploadsSince(mark)).toHaveLength(2);
      expect(await waitingUploadsSince(mark)).toEqual([]);
      const body = bodyOf(res);
      expect(body.images).toHaveLength(2);
      body.images.forEach((urls: Record<string, string>) => {
        for (const size of [200, 400, 800]) {
          expect(urls[`url${size}`]).toMatch(
            urlPattern(`c_fit,w_${size},h_${size},f_auto,q_auto`, pathOf(body.id)),
          );
        }
      });

      const rows = await imagesOf(body.id);
      expect(withoutUrls(rows)).toEqual([
        {
          publicId: expect.stringMatching(imagePath(body.id)),
          alt: 'front.png',
          position: 0,
          isPrimary: true,
        },
        {
          publicId: expect.stringMatching(imagePath(body.id)),
          alt: 'back.png',
          position: 1,
          isPrimary: false,
        },
      ]);
      expect(rows[0]!.publicId).not.toBe(rows[1]!.publicId);
      expect(hideSecrets(rows[0]!.url)).toMatch(urlPattern('', rows[0]!.publicId!));

      expect(await filesOf(body.id)).toEqual([
        expect.objectContaining({
          width: 30,
          height: 20,
          format: 'png',
          tags: expect.arrayContaining(['product', `product:${body.id}`, 'pos:1']),
        }),
        expect.objectContaining({
          width: 25,
          height: 25,
          tags: expect.arrayContaining(['product', `product:${body.id}`, 'pos:2']),
        }),
      ]);
    });

    it('refuses a product without images', async () => {
      const res = await createForm(productFields());

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_IMAGES_REQUIRED' });
    });

    it.each([
      ['no name', { name: undefined }, 'BODY_NOT_FULL'],
      ['a price that is not a number', { price: 'abc' }, 'PRODUCT_PRICE_INVALID'],
      // the stock comes only with a delivery
      ['a stock', { stock: '5' }, 'PRODUCT_STOCK_NOT_ALLOWED'],
    ])('uploads nothing for a product with %s', async (_case, overrides, errorCode) => {
      const mark = uploadMark();

      const res = await createForm([...productFields(overrides), image(pngImage(30, 20))]);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
    });

    it('uploads nothing when one image of the form is refused', async () => {
      const mark = uploadMark();

      const res = await createForm([
        ...productFields(),
        image(Buffer.from('notes'), { contentType: 'text/plain', filename: 'notes.txt' }),
        image(pngImage(30, 20)),
      ]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
    });

    // the type a form names is the client's word; the file itself has to be a jpeg, png or webp
    it.each([
      ['text that says it is a png', Buffer.from('this is not an image')],
      ['a gif that says it is a png', gifImage()],
      ['an svg that says it is a png', svgImage()],
    ])('refuses %s and uploads nothing', async (_case, data) => {
      const mark = uploadMark();

      const res = await createForm([...productFields(), image(data)]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
      // the file is refused by its bytes, it never goes to Cloudinary
      expect(uploadsSince(mark)).toEqual([]);
    });

    it('refuses a png that Cloudinary cannot read and keeps no file', async () => {
      const mark = uploadMark();

      const res = await createForm([
        ...productFields(),
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

      const res = await createForm([...productFields(), image(pngImage(30, 20))], user);

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
      expect(uploadsSince(mark)).toEqual([]);
    });
  });

  describe('PATCH /api/products/:productId', () => {
    it('changes the fields and the images of the product in one form', async () => {
      // a price change writes the price log, and a product with a log cannot be cleaned up
      const productId = await productWithImages([pngImage(30, 20)]);

      const res = await patchForm(productId, [
        ...fields({ name: 'Renamed in a form', description: 'New text.' }),
        image(pngImage(44, 22)),
      ]);

      expect(res.statusCode).toBe(200);
      expect(bodyOf(res)).toMatchObject({
        name: 'Renamed in a form',
        description: 'New text.',
        stock: 5,
      });
      expect(await filesOf(productId)).toEqual([
        expect.objectContaining({ width: 44, height: 22 }),
      ]);
    });

    // the stock changes only with a delivery or a write-off
    it('refuses a stock in the form and keeps the images and the stock', async () => {
      const productId = await productWithImages([pngImage(30, 20)]);
      const before = await filesOf(productId);
      const mark = uploadMark();

      const res = await patchForm(productId, [...fields({ stock: '3' }), image(pngImage(44, 22))]);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_STOCK_NOT_ALLOWED' });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(await filesOf(productId)).toEqual(before);
      expect(await stockOf(productId)).toMatchObject({ stock: 5 });
    });

    it('replaces the images of the product with files at new paths', async () => {
      const productId = await productWithImages([pngImage(30, 20), pngImage(25, 25)]);
      const old = (await imagesOf(productId)).map((row) => row.publicId);

      const res = await patchForm(productId, [image(pngImage(44, 22), { filename: 'new.png' })]);

      expect(res.statusCode).toBe(200);
      const body = bodyOf(res);
      expect(body.images).toHaveLength(1);
      const rows = await imagesOf(productId);
      expect(body.images[0].url200).toMatch(
        urlPattern('c_fit,w_200,h_200,f_auto,q_auto', rows[0]!.publicId!),
      );
      expect(withoutUrls(rows)).toEqual([
        {
          publicId: expect.stringMatching(imagePath(productId)),
          alt: 'new.png',
          position: 0,
          isPrimary: true,
        },
      ]);
      expect(old).not.toContain(rows[0]!.publicId);
      expect(await storedImage(rows[0]!.publicId!)).toMatchObject({ width: 44, height: 22 });
    });

    // nothing points to the second file any more, it would only take space in the account
    it('removes the files of the images the product no longer has', async () => {
      const productId = await productWithImages([pngImage(30, 20), pngImage(25, 25)]);
      const old = (await imagesOf(productId)).map((row) => row.publicId!);

      const res = await patchForm(productId, [image(pngImage(44, 22))]);

      expect(res.statusCode).toBe(200);
      expect(await Promise.all(old.map((publicId) => storedImage(publicId)))).toEqual([null, null]);
    });

    // the moves ran one by one with overwriting the paths the product showed: the third move
    // failed, the transaction went back, and two files of the product were already replaced
    it('keeps every file the product shows when a move fails in the middle', async () => {
      const productId = await productWithImages([pngImage(30, 20), pngImage(25, 25)]);
      const rowsBefore = await imagesOf(productId);
      const filesBefore = await filesOf(productId);
      const mark = uploadMark();
      const rename = cloudinary.uploader.rename;
      let calls = 0;
      jest
        .spyOn(cloudinary.uploader, 'rename')
        .mockImplementation(((...args: Parameters<typeof rename>) =>
          (calls += 1) === 3
            ? Promise.reject(new Error('cloudinary is down'))
            : rename(...args)) as typeof rename);

      const res = await patchForm(productId, [
        image(pngImage(41, 21)),
        image(pngImage(42, 22)),
        image(pngImage(43, 23)),
      ]);

      expect(res.statusCode).toBe(500);
      expect(takeLogs({ msg: 'request failed' })).toHaveLength(1);
      expect(hideSecrets(JSON.stringify(await imagesOf(productId)))).toBe(
        hideSecrets(JSON.stringify(rowsBefore)),
      );
      expect(await filesOf(productId)).toEqual(filesBefore);
      // the files that moved before the failure and the uploads that waited are gone too
      const moved = movesSince(mark);
      expect(moved).toHaveLength(2);
      expect(await Promise.all(moved.map((publicId) => storedImage(publicId)))).toEqual([
        null,
        null,
      ]);
      expect(await waitingUploadsSince(mark)).toEqual([]);
    });

    it('refuses more than 10 images and keeps the images of the product', async () => {
      const productId = await productWithImages([pngImage(30, 20)]);
      const rowsBefore = await imagesOf(productId);
      const mark = uploadMark();

      const res = await patchForm(
        productId,
        Array.from({ length: 11 }, (_, i) => image(pngImage(20 + i, 20))),
      );

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({
        errorCode: 'PRODUCT_IMAGES_TOO_MANY',
        details: { max: 10 },
      });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
      expect(hideSecrets(JSON.stringify(await imagesOf(productId)))).toBe(
        hideSecrets(JSON.stringify(rowsBefore)),
      );
    });

    it('keeps the images when the rest of the form is refused', async () => {
      const productId = await productWithImages([pngImage(30, 20)]);
      const [before] = await filesOf(productId);
      const rowsBefore = await imagesOf(productId);
      const mark = uploadMark();

      const res = await patchForm(productId, [
        ...fields({ price: 'abc' }),
        image(pngImage(44, 22)),
      ]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'PRODUCT_PRICE_INVALID' });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(await storedImage(rowsBefore[0]!.publicId!)).toMatchObject({
        version: before!.version,
        width: 30,
        height: 20,
      });
      expect(hideSecrets(JSON.stringify(await imagesOf(productId)))).toBe(
        hideSecrets(JSON.stringify(rowsBefore)),
      );
    });

    it('uploads nothing for a product that does not exist', async () => {
      const productId = 2_000_000_000;
      const mark = uploadMark();

      const res = await patchForm(productId, [image(pngImage(44, 22))]);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(movesSince(mark)).toEqual([]);
    });

    it('refuses a user before anything is uploaded', async () => {
      const user = await createUser();
      userIds.push(user.id);
      const productId = await productWithImages([pngImage(30, 20)]);
      const before = await filesOf(productId);

      const res = await patchForm(productId, [image(pngImage(44, 22))], user);

      expect(res.statusCode).toBe(403);
      expect(await filesOf(productId)).toEqual(before);
    });

    // an image of a product is a file the app uploaded; a json body could point it anywhere
    it('refuses images sent in a json body and keeps the images', async () => {
      const productId = await productWithImages([pngImage(30, 20)]);
      const rowsBefore = await imagesOf(productId);

      const res = await app.inject({
        method: 'PATCH',
        url: `/api/products/${productId}`,
        headers: withCsrf(csrf, accessCookie(admin)),
        payload: {
          images: [
            { publicId: 'elsewhere/1', urlBase: 'https://images.example.com/1.png', position: 0 },
          ],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(hideSecrets(JSON.stringify(await imagesOf(productId)))).toBe(
        hideSecrets(JSON.stringify(rowsBefore)),
      );
    });
  });
});
