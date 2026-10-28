import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import {
  bodyOf,
  brokenPng,
  gifImage,
  imageField,
  moveCallsSince,
  movesSince,
  pngImage,
  removeUploads,
  storedImage,
  uploadMark,
  uploadsSince,
  waitingUploadsSince,
  withSilentCloudinaryMoves,
} from '../../../helpers/cloudinary.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createCategory,
  createUser,
  type TestUser,
} from '../../../helpers/factories.js';
import { takeLogs } from '../../../helpers/logs.js';
import { multipartBody, type FormPart } from '../../../helpers/multipart.js';

// the picture of a category, optional: PUT /api/categories/:categoryId/image puts one on (a form
// with one file, image), DELETE takes it off. The file waits on Cloudinary at a waiting id until the
// category is written, then it moves to test/categories/<id>/<key>; the one it had is deleted
let app: FastifyInstance;
let csrf: Csrf;
let admin: TestUser;
const userIds: number[] = [];
const categoryIds: number[] = [];

async function newUser(role: TestUser['role'] = 'USER') {
  const user = await createUser({ role });
  userIds.push(user.id);
  return user;
}

async function newCategory() {
  const category = await createCategory();
  categoryIds.push(category.id);
  return category;
}

const image = (data: Buffer, opts: Parameters<typeof imageField>[2] = {}) =>
  imageField('image', data, { filename: 'category.png', ...opts });

const putImage = (categoryId: number, parts: FormPart[], actor: TestUser | null = admin) => {
  const { payload, headers } = multipartBody(parts);
  return app.inject({
    method: 'PUT',
    url: `/api/categories/${categoryId}/image`,
    headers: { ...(actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf)), ...headers },
    payload,
  });
};

const deleteImage = (categoryId: number, actor: TestUser | null = admin) =>
  app.inject({
    method: 'DELETE',
    url: `/api/categories/${categoryId}/image`,
    headers: actor ? withCsrf(csrf, accessCookie(actor)) : withCsrf(csrf),
  });

const rowOf = (id: number) =>
  asAdmin((tx) =>
    tx.category.findUniqueOrThrow({
      where: { id },
      select: { imageUrl: true, imagePublicId: true },
    }),
  );

const auditEvents = (categoryId: number) =>
  asAdmin((tx) =>
    tx.adminAuditLog.findMany({
      where: { entityType: 'category', entityId: categoryId },
      orderBy: { id: 'asc' },
      select: { event: true, meta: true },
    }),
  );

const pathPattern = (categoryId: number) =>
  new RegExp(`^test/categories/${categoryId}/[0-9a-f-]+$`);

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
  admin = await newUser('ADMIN');
});

afterAll(async () => {
  try {
    await removeUploads();
    await asAdmin((tx) => tx.category.deleteMany({ where: { id: { in: categoryIds } } }));
  } finally {
    try {
      await closeSessions(userIds);
    } finally {
      await stopApp();
    }
  }
}, 120_000);

describe('PUT /api/categories/:categoryId/image', () => {
  it('puts the picture on the category, in the folder of the test, and gives its sizes', async () => {
    const category = await newCategory();
    const mark = uploadMark();

    const res = await putImage(category.id, [image(pngImage(40, 30))]);

    expect(res.statusCode).toBe(200);
    const body = bodyOf(res);
    for (const size of [200, 400, 800]) {
      expect(body.imageUrls[`url${size}`]).toContain(`c_fit,w_${size},h_${size},f_auto,q_auto`);
      expect(body.imageUrls[`url${size}`]).toContain(`/test/categories/${category.id}/`);
    }

    // the upload moved to its place and nothing waits at its waiting id
    expect(uploadsSince(mark)).toHaveLength(1);
    expect(movesSince(mark)).toHaveLength(1);
    expect(await waitingUploadsSince(mark)).toEqual([]);

    const row = await rowOf(category.id);
    expect(row.imagePublicId).toMatch(pathPattern(category.id));
    expect(await storedImage(row.imagePublicId!)).toMatchObject({
      width: 40,
      height: 30,
      format: 'png',
      tags: expect.arrayContaining(['category', `category:${category.id}`]),
    });
  });

  it('shows the picture in the list and the tree of the categories, and none for the others', async () => {
    const withImage = await newCategory();
    const without = await newCategory();
    await putImage(withImage.id, [image(pngImage(20, 20))]);

    const list = await app.inject({
      method: 'GET',
      url: `/api/categories?search=${encodeURIComponent(withImage.name)}`,
    });
    const tree = await app.inject({ method: 'GET', url: '/api/categories/tree' });
    const plain = await app.inject({
      method: 'GET',
      url: `/api/categories?search=${encodeURIComponent(without.name)}`,
    });

    expect(list.json().items[0].imageUrls.url400).toContain(`/test/categories/${withImage.id}/`);
    const nodes: Array<{ id: number; imageUrls: unknown }> = tree.json().items;
    expect(nodes.find((node) => node.id === withImage.id)?.imageUrls).toMatchObject({
      url200: expect.any(String),
    });
    expect(nodes.find((node) => node.id === without.id)?.imageUrls).toBeNull();
    expect(plain.json().items[0].imageUrls).toBeNull();
  });

  it('replaces the picture the category has and deletes the old file', async () => {
    const category = await newCategory();
    await putImage(category.id, [image(pngImage(10, 10))]);
    const first = (await rowOf(category.id)).imagePublicId!;

    const res = await putImage(category.id, [image(pngImage(24, 12))]);

    expect(res.statusCode).toBe(200);
    const second = (await rowOf(category.id)).imagePublicId!;
    expect(second).not.toBe(first);
    expect(await storedImage(first)).toBeNull();
    expect(await storedImage(second)).toMatchObject({ width: 24, height: 12 });
  });

  // a new place never had a file, so there are no cached copies to drop; the move runs inside the
  // transaction and has 8 s at most
  it('moves the picture to its new place without dropping cached copies, 8 s at most', async () => {
    const category = await newCategory();
    const mark = uploadMark();

    const res = await putImage(category.id, [image(pngImage(13, 13))]);

    expect(res.statusCode).toBe(200);
    expect(moveCallsSince(mark)).toEqual([
      expect.objectContaining({
        to: expect.stringMatching(new RegExp(`^test/categories/${category.id}/[0-9a-f-]{36}$`)),
        options: expect.objectContaining({ invalidate: false, timeout: 8_000 }),
      }),
    ]);
  });

  // Cloudinary takes the move and never answers: the move gives up after its 8 s, and the
  // category keeps the picture it had
  it('keeps the picture of the category when Cloudinary does not answer the move in 8 s', async () => {
    const category = await newCategory();
    await putImage(category.id, [image(pngImage(10, 10))]);
    const before = await rowOf(category.id);
    const mark = uploadMark();
    const startedAt = Date.now();

    const res = await withSilentCloudinaryMoves(() =>
      putImage(category.id, [image(pngImage(14, 14))]),
    );
    const took = Date.now() - startedAt;

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ errorCode: 'IMAGE_STORAGE_UNAVAILABLE' });
    expect(took).toBeGreaterThanOrEqual(8_000);
    expect(took).toBeLessThan(20_000);
    expect(await rowOf(category.id)).toEqual(before);
    expect(await storedImage(before.imagePublicId!)).not.toBeNull();
    expect(await waitingUploadsSince(mark)).toEqual([]);
    expect(
      takeLogs({ msg: 'request failed', errorCode: 'IMAGE_STORAGE_UNAVAILABLE' }),
    ).toHaveLength(1);
  });

  it('writes the picture to the journal of the admins', async () => {
    const category = await newCategory();
    await putImage(category.id, [image(pngImage(10, 10))]);
    await deleteImage(category.id);

    const lines = await auditEvents(category.id);

    expect(lines.map((line) => line.event)).toEqual([
      'category.image_set',
      'category.image_remove',
    ]);
  });

  it('answers 404 for a category that is not there and leaves nothing on Cloudinary', async () => {
    const mark = uploadMark();

    const res = await putImage(2_000_000_000, [image(pngImage(10, 10))]);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_NOT_FOUND' });
    expect(movesSince(mark)).toEqual([]);
    expect(await waitingUploadsSince(mark)).toEqual([]);
  });

  it.each([
    [
      'a form with no file',
      (): FormPart[] => [{ name: 'note', value: 'x' }],
      'CATEGORY_IMAGE_REQUIRED',
    ],
    [
      'a file under another name',
      (): FormPart[] => [imageField('picture', pngImage(10, 10))],
      'CATEGORY_IMAGE_REQUIRED',
    ],
  ])('refuses %s', async (_case, parts, errorCode) => {
    const category = await newCategory();

    const res = await putImage(category.id, parts());

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode });
    expect((await rowOf(category.id)).imageUrl).toBeNull();
  });

  it('refuses two pictures, keeps the one the category has and leaves nothing waiting', async () => {
    const category = await newCategory();
    await putImage(category.id, [image(pngImage(10, 10))]);
    const before = await rowOf(category.id);
    const mark = uploadMark();

    const res = await putImage(category.id, [image(pngImage(11, 11)), image(pngImage(12, 12))]);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_IMAGE_MULTIPLE' });
    expect(await rowOf(category.id)).toEqual(before);
    expect(movesSince(mark)).toEqual([]);
    expect(await waitingUploadsSince(mark)).toEqual([]);
  });

  it('refuses a file that is not a jpeg, png or webp, and a png that cannot be read', async () => {
    const category = await newCategory();

    const gif = await putImage(category.id, [
      image(gifImage(), { contentType: 'image/gif', filename: 'a.gif' }),
    ]);
    const broken = await putImage(category.id, [image(brokenPng())]);

    expect(gif.statusCode).toBe(400);
    expect(gif.json()).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
    expect(broken.statusCode).toBe(400);
    expect(broken.json()).toMatchObject({ errorCode: 'IMAGE_INVALID' });
    expect((await rowOf(category.id)).imageUrl).toBeNull();
  });

  it('refuses a body that is not a form', async () => {
    const category = await newCategory();

    const res = await app.inject({
      method: 'PUT',
      url: `/api/categories/${category.id}/image`,
      headers: withCsrf(csrf, accessCookie(admin)),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'MULTIPART_REQUIRED' });
  });

  it('is for admin and root: a buyer is refused and a visitor has to sign in', async () => {
    const category = await newCategory();
    const buyer = await newUser();

    const refused: LightMyRequestResponse = await putImage(
      category.id,
      [image(pngImage(10, 10))],
      buyer,
    );
    const visitor = await putImage(category.id, [image(pngImage(10, 10))], null);

    expect(refused.statusCode).toBe(403);
    expect([401, 403]).toContain(visitor.statusCode);
    expect((await rowOf(category.id)).imageUrl).toBeNull();
  });
});

describe('DELETE /api/categories/:categoryId/image', () => {
  it('takes the picture off the category and deletes its file', async () => {
    const category = await newCategory();
    await putImage(category.id, [image(pngImage(10, 10))]);
    const publicId = (await rowOf(category.id)).imagePublicId!;

    const res = await deleteImage(category.id);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: category.id, imageUrls: null });
    expect(await rowOf(category.id)).toEqual({ imageUrl: null, imagePublicId: null });
    expect(await storedImage(publicId)).toBeNull();
  });

  it('answers 409 for a category without a picture', async () => {
    const category = await newCategory();

    const res = await deleteImage(category.id);

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_IMAGE_NOT_SET' });
  });

  it('answers 404 for a category that is not there', async () => {
    const res = await deleteImage(2_000_000_000);

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ errorCode: 'CATEGORY_NOT_FOUND' });
  });

  it('is for admin and root', async () => {
    const category = await newCategory();
    const buyer = await newUser();

    const res = await deleteImage(category.id, buyer);

    expect(res.statusCode).toBe(403);
  });
});

describe('DELETE /api/categories/:categoryId', () => {
  it('deletes the picture of the category with it', async () => {
    const category = await newCategory();
    await putImage(category.id, [image(pngImage(10, 10))]);
    const publicId = (await rowOf(category.id)).imagePublicId!;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/categories/${category.id}`,
      headers: withCsrf(csrf, accessCookie(admin)),
    });

    expect(res.statusCode).toBe(200);
    expect(await storedImage(publicId)).toBeNull();
  });
});
