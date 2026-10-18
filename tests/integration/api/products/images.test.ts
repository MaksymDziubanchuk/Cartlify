import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import {
  bodyOf,
  deliveryUrl,
  describeWithCloudinary,
  gifImage,
  imageField,
  pngImage,
  removeUploads,
  storedImage,
  svgImage,
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
  uniqueTag,
  type TestProduct,
  type TestUser,
} from '../../../helpers/factories.js';
import { hideSecrets } from '../../../helpers/hideSecrets.js';
import { multipartBody, type FormPart } from '../../../helpers/multipart.js';

// the images of POST /api/products and PATCH /api/products/:productId go to Cloudinary for real,
// into test/products/<id>/<position from 1>. A new product gets its id before its first image
// is read, from the products sequence: the test database serves only this run, so the id a form
// takes is the one after the last product created. The PATCH tests start from a product of the
// factory and give it its files through PATCH, so they do not depend on the create form

let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
let categoryId: number;
const userIds: number[] = [];
// products made by the factory; the ones made through the form are in the category of the file
const products: TestProduct[] = [];

const imagePath = (productId: number, n: number) => `test/products/${productId}/${n}`;

const fields = (values: Record<string, string | undefined>): FormPart[] =>
  Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => ({ name, value }));

const productFields = (overrides: Record<string, string | undefined> = {}) =>
  fields({
    name: `Image test product ${uniqueTag()}`,
    price: '10',
    stock: '5',
    categoryId: String(categoryId),
    ...overrides,
  });

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

// the id the next product form takes: one after a product made now
async function nextProductId(): Promise<number> {
  const product = await createProduct();
  products.push(product);
  return product.id + 1;
}

// the files at the paths of a product, to compare before and after a request
const filesAt = (productId: number, count: number) =>
  Promise.all(Array.from({ length: count }, (_, i) => storedImage(imagePath(productId, i + 1))));

// an image url the app gives: the transforms, the version, the path of the file
const urlPattern = (transforms: string, path: string) =>
  new RegExp(
    `^${deliveryUrl(transforms).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}v\\d+/${path}\\.png$`,
  );

describeWithCloudinary('product images (Cloudinary)', () => {
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
        stock: 5,
        categoryId,
        images: [expect.any(Object)],
      });
      const row = await asAdmin((tx) =>
        tx.product.findUniqueOrThrow({
          where: { id: res.json().id },
          select: { name: true, description: true, stock: true, categoryId: true },
        }),
      );
      expect(row).toEqual({
        name: 'Form headphones',
        description: 'Over-ear.',
        stock: 5,
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
      body.images.forEach((urls: Record<string, string>, i: number) => {
        for (const size of [200, 400, 800]) {
          expect(urls[`url${size}`]).toMatch(
            urlPattern(`c_fit,w_${size},h_${size},f_auto,q_auto`, imagePath(body.id, i + 1)),
          );
        }
      });

      const rows = await imagesOf(body.id);
      expect(withoutUrls(rows)).toEqual([
        { publicId: imagePath(body.id, 1), alt: 'front.png', position: 0, isPrimary: true },
        { publicId: imagePath(body.id, 2), alt: 'back.png', position: 1, isPrimary: false },
      ]);
      expect(hideSecrets(rows[0]!.url)).toMatch(urlPattern('', imagePath(body.id, 1)));

      expect(await filesAt(body.id, 2)).toEqual([
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
      ['a negative stock', { stock: '-1' }, 'PRODUCT_STOCK_INVALID'],
    ])('uploads nothing for a product with %s', async (_case, overrides, errorCode) => {
      const productId = await nextProductId();
      const before = await filesAt(productId, 1);
      const mark = uploadMark();

      const res = await createForm([...productFields(overrides), image(pngImage(30, 20))]);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(await filesAt(productId, 1)).toEqual(before);
    });

    it('uploads nothing when one image of the form is refused', async () => {
      const productId = await nextProductId();
      const before = await filesAt(productId, 2);
      const mark = uploadMark();

      const res = await createForm([
        ...productFields(),
        image(Buffer.from('notes'), { contentType: 'text/plain', filename: 'notes.txt' }),
        image(pngImage(30, 20)),
      ]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(await filesAt(productId, 2)).toEqual(before);
    });

    // the type a form names is the client's word; the file itself has to be a jpeg, png or webp
    it.each([
      ['text that says it is a png', Buffer.from('this is not an image')],
      ['a gif that says it is a png', gifImage()],
      ['an svg that says it is a png', svgImage()],
    ])('refuses %s and uploads nothing', async (_case, data) => {
      const productId = await nextProductId();
      const before = await filesAt(productId, 1);
      const mark = uploadMark();

      const res = await createForm([...productFields(), image(data)]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
      // the file is refused by its bytes, it never goes to Cloudinary
      expect(uploadsSince(mark)).toEqual([]);
      expect(await filesAt(productId, 1)).toEqual(before);
    });

    it('refuses a user before anything is uploaded', async () => {
      const user = await createUser();
      userIds.push(user.id);
      const productId = await nextProductId();
      const before = await filesAt(productId, 1);
      const mark = uploadMark();

      const res = await createForm([...productFields(), image(pngImage(30, 20))], user);

      expect(res.statusCode).toBe(403);
      expect(uploadsSince(mark)).toEqual([]);
      expect(res.json()).toMatchObject({ errorCode: 'INSUFFICIENT_ROLE' });
      expect(await filesAt(productId, 1)).toEqual(before);
    });
  });

  describe('PATCH /api/products/:productId', () => {
    it('changes the fields and the images of the product in one form', async () => {
      // a price change writes the price log, and a product with a log cannot be cleaned up
      const productId = await productWithImages([pngImage(30, 20)]);

      const res = await patchForm(productId, [
        ...fields({ name: 'Renamed in a form', description: 'New text.', stock: '3' }),
        image(pngImage(44, 22)),
      ]);

      expect(res.statusCode).toBe(200);
      // the stock of a form is a delta too: 5 of the factory and 3 more
      expect(bodyOf(res)).toMatchObject({
        name: 'Renamed in a form',
        description: 'New text.',
        stock: 8,
      });
      expect(await storedImage(imagePath(productId, 1))).toMatchObject({ width: 44, height: 22 });
    });

    it('replaces the images of the product', async () => {
      const productId = await productWithImages([pngImage(30, 20), pngImage(25, 25)]);

      const res = await patchForm(productId, [image(pngImage(44, 22), { filename: 'new.png' })]);

      expect(res.statusCode).toBe(200);
      const body = bodyOf(res);
      expect(body.images).toHaveLength(1);
      expect(body.images[0].url200).toMatch(
        urlPattern('c_fit,w_200,h_200,f_auto,q_auto', imagePath(productId, 1)),
      );
      expect(withoutUrls(await imagesOf(productId))).toEqual([
        { publicId: imagePath(productId, 1), alt: 'new.png', position: 0, isPrimary: true },
      ]);
      expect(await storedImage(imagePath(productId, 1))).toMatchObject({ width: 44, height: 22 });
    });

    // nothing points to the second file any more, it would only take space in the account
    it('removes the files of the images the product no longer has', async () => {
      const productId = await productWithImages([pngImage(30, 20), pngImage(25, 25)]);

      const res = await patchForm(productId, [image(pngImage(44, 22))]);

      expect(res.statusCode).toBe(200);
      expect(await storedImage(imagePath(productId, 2))).toBeNull();
    });

    it('keeps the images when the rest of the form is refused', async () => {
      const productId = await productWithImages([pngImage(30, 20)]);
      const [before] = await filesAt(productId, 1);
      const rowsBefore = await imagesOf(productId);
      const mark = uploadMark();

      const res = await patchForm(productId, [
        ...fields({ price: 'abc' }),
        image(pngImage(44, 22)),
      ]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'PRODUCT_PRICE_INVALID' });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(await storedImage(imagePath(productId, 1))).toMatchObject({
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
      const before = await filesAt(productId, 1);
      const mark = uploadMark();

      const res = await patchForm(productId, [image(pngImage(44, 22))]);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ errorCode: 'PRODUCT_NOT_FOUND' });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(await filesAt(productId, 1)).toEqual(before);
    });

    it('refuses a user before anything is uploaded', async () => {
      const user = await createUser();
      userIds.push(user.id);
      const productId = await productWithImages([pngImage(30, 20)]);
      const [before] = await filesAt(productId, 1);

      const res = await patchForm(productId, [image(pngImage(44, 22))], user);

      expect(res.statusCode).toBe(403);
      expect(await storedImage(imagePath(productId, 1))).toEqual(before);
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
