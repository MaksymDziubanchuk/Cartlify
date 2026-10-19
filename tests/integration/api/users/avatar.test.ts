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
import { closeSessions, createUser, uniqueTag, type TestUser } from '../../../helpers/factories.js';
import { hideSecrets } from '../../../helpers/hideSecrets.js';
import { allowLogs, takeLogs } from '../../../helpers/logs.js';
import { multipartBody, type FormPart } from '../../../helpers/multipart.js';

// the avatar of PATCH /api/users/me goes to Cloudinary for real: it waits at a waiting id until the
// profile is written and then moves to test/users/<id>/avatar; a refused request deletes it.
// What the app refuses before any upload (an empty file, a declared type that is not an image,
// a file over the size limit) is in meForm.test.ts

let app: FastifyInstance;
let csrf: Csrf;
let rootCookie: string;
const userIds: number[] = [];

const newUser = async () => {
  const user = await createUser();
  userIds.push(user.id);
  return user;
};

const avatarPath = (user: TestUser) => `test/users/${user.id}/avatar`;

const rowOf = (id: number) =>
  asAdmin((tx) =>
    tx.user.findUniqueOrThrow({
      where: { id },
      select: { name: true, phone: true, avatarUrl: true, publicId: true },
    }),
  );

const fields = (values: Record<string, string>): FormPart[] =>
  Object.entries(values).map(([name, value]) => ({ name, value }));

const avatar = (data: Buffer, opts: Parameters<typeof imageField>[2] = {}) =>
  imageField('avatar', data, { filename: 'avatar.png', ...opts });

const patchForm = (user: TestUser, parts: FormPart[]) => {
  const { payload, headers } = multipartBody(parts);

  return app.inject({
    method: 'PATCH',
    url: '/api/users/me',
    headers: { ...withCsrf(csrf, accessCookie(user)), ...headers },
    payload,
  });
};

// an avatar the account already has, uploaded the way the page uploads one
async function giveAvatar(user: TestUser, data: Buffer) {
  const res = await patchForm(user, [avatar(data)]);
  if (res.statusCode !== 200) throw new Error(`the avatar upload answered ${res.statusCode}`);

  const stored = await storedImage(avatarPath(user));
  if (!stored) throw new Error('the uploaded avatar is not at Cloudinary');

  return { stored, row: await rowOf(user.id) };
}

const deleteAsRoot = (user: TestUser) =>
  app.inject({
    method: 'DELETE',
    url: `/api/users/${user.id}`,
    headers: withCsrf(csrf, rootCookie),
  });

// an image url the app gives: the transforms, the version, the path of the file
const urlPattern = (transforms: string, path: string) =>
  new RegExp(
    `^${deliveryUrl(transforms).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}v\\d+/${path}\\.png$`,
  );

const versionOf = (url: string) => /\/v(\d+)\//.exec(url)?.[1];

describeWithCloudinary('PATCH /api/users/me with an avatar (Cloudinary)', () => {
  beforeAll(async () => {
    app = await startApp();
    csrf = await getCsrf(app);

    const root = await createUser({ role: 'ROOT', password: `root-${uniqueTag()}` });
    userIds.push(root.id);
    rootCookie = accessCookie(root);

    // the test environment has no SendGrid key: every deletion logs that its mail was not sent;
    // 'removes the avatar at Cloudinary when the account is deleted' checks that line
    allowLogs({ msg: 'account deleted mail was not sent', reason: 'SENDGRID_API_KEY_REQUIRED' });
  });

  // deletes every file the tests uploaded, a request to Cloudinary each: more time than a test
  afterAll(async () => {
    try {
      await removeUploads();
    } finally {
      try {
        await closeSessions(userIds);
      } finally {
        await stopApp();
      }
    }
  }, 120_000);

  it('uploads the avatar into the test folder and gives its sizes', async () => {
    const user = await newUser();
    const mark = uploadMark();

    const res = await patchForm(user, [...fields({ name: 'Anna' }), avatar(pngImage(40, 30))]);

    expect(res.statusCode).toBe(200);
    // the upload moved to its place, nothing waits at its waiting id
    expect(uploadsSince(mark)).toHaveLength(1);
    expect(await waitingUploadsSince(mark)).toEqual([]);
    const body = bodyOf(res);
    expect(body.name).toBe('Anna');
    for (const size of [32, 64, 128, 256]) {
      expect(body.avatarUrls[`url${size}`]).toMatch(
        urlPattern(`c_fill,g_face,w_${size},h_${size},f_auto,q_auto`, avatarPath(user)),
      );
    }

    const row = await rowOf(user.id);
    expect(row.publicId).toBe(avatarPath(user));
    expect(hideSecrets(row.avatarUrl ?? '')).toMatch(urlPattern('', avatarPath(user)));
    expect(await storedImage(avatarPath(user))).toMatchObject({
      width: 40,
      height: 30,
      format: 'png',
      tags: expect.arrayContaining(['avatar', `user:${user.id}`]),
    });
  });

  it('serves the avatar at the urls it gives', async () => {
    const user = await newUser();

    const res = await patchForm(user, [avatar(pngImage(40, 30))]);
    expect(res.statusCode).toBe(200);
    const image = await fetch(res.json().avatarUrls.url64);

    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toMatch(/^image\//);
  });

  it('replaces the avatar at the same path with a new version', async () => {
    const user = await newUser();
    const first = await giveAvatar(user, pngImage(40, 30));

    const res = await patchForm(user, [avatar(pngImage(50, 20))]);

    expect(res.statusCode).toBe(200);
    const row = await rowOf(user.id);
    expect(row.publicId).toBe(avatarPath(user));
    // the version in the url is new, so no browser or cdn keeps showing the old picture
    expect(versionOf(row.avatarUrl ?? '')).not.toBe(versionOf(first.row.avatarUrl ?? ''));
    expect(await storedImage(avatarPath(user))).toMatchObject({ width: 50, height: 20 });
  });

  describe('a form the app refuses', () => {
    it.each([
      ['a phone that is not a phone', { phone: 'abc' }, 'PHONE_INVALID'],
      ['a name over 100 characters', { name: 'x'.repeat(101) }, 'NAME_TOO_LONG'],
    ])('keeps the avatar the account has when the form has %s', async (_case, values, code) => {
      const user = await newUser();
      const before = await giveAvatar(user, pngImage(40, 30));
      const mark = uploadMark();

      const res = await patchForm(user, [...fields(values), avatar(pngImage(50, 20))]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: code });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(await storedImage(avatarPath(user))).toMatchObject({
        version: before.stored.version,
        width: 40,
        height: 30,
      });
      expect(hideSecrets((await rowOf(user.id)).avatarUrl ?? '')).toBe(
        hideSecrets(before.row.avatarUrl ?? ''),
      );
    });

    it('uploads nothing for an account without an avatar', async () => {
      const user = await newUser();
      // a file of an earlier run may sit at this path, the request must not change it
      const before = await storedImage(avatarPath(user));
      const mark = uploadMark();

      const res = await patchForm(user, [...fields({ phone: 'abc' }), avatar(pngImage(50, 20))]);

      expect(res.statusCode).toBe(400);
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(await storedImage(avatarPath(user))).toEqual(before);
      expect((await rowOf(user.id)).avatarUrl).toBeNull();
    });

    it('keeps the avatar the account has when the form has two avatars', async () => {
      const user = await newUser();
      const before = await giveAvatar(user, pngImage(40, 30));
      const mark = uploadMark();

      const res = await patchForm(user, [avatar(pngImage(50, 20)), avatar(pngImage(60, 10))]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'AVATAR_MULTIPLE' });
      // the upload of the first file had started; the answer comes after it is deleted
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(await storedImage(avatarPath(user))).toMatchObject({
        version: before.stored.version,
        width: 40,
      });
    });
  });

  // the type a form names is the client's word; the file itself has to be a jpeg, png or webp
  describe('a file that is not a jpeg, png or webp image', () => {
    it.each([
      ['text that says it is a png', Buffer.from('this is not an image')],
      ['a gif that says it is a png', gifImage()],
      ['an svg that says it is a png', svgImage()],
    ])('refuses %s and keeps the avatar the account has', async (_case, data) => {
      const user = await newUser();
      const before = await giveAvatar(user, pngImage(40, 30));
      const mark = uploadMark();

      const res = await patchForm(user, [avatar(data)]);

      expect(res.statusCode).toBe(400);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
      // the file is refused by its bytes, it never goes to Cloudinary
      expect(uploadsSince(mark)).toEqual([]);
      expect(await storedImage(avatarPath(user))).toMatchObject({
        version: before.stored.version,
        width: 40,
        height: 30,
        format: 'png',
      });
    });
  });

  describe('a deleted account', () => {
    it('removes the avatar at Cloudinary when the account is deleted', async () => {
      const user = await newUser();
      await giveAvatar(user, pngImage(40, 30));

      const res = await deleteAsRoot(user);

      expect(res.statusCode).toBe(200);
      expect(await storedImage(avatarPath(user))).toBeNull();
      // the deletion went on to its last step, the mail, after the avatar
      expect(
        takeLogs({ msg: 'account deleted mail was not sent', reason: 'SENDGRID_API_KEY_REQUIRED' }),
      ).toHaveLength(1);
    });

    // its access token still works for a few minutes after the deletion
    it('keeps a deleted account from putting an avatar back', async () => {
      const user = await newUser();
      await giveAvatar(user, pngImage(40, 30));
      await deleteAsRoot(user);
      const mark = uploadMark();

      const res = await patchForm(user, [avatar(pngImage(50, 20))]);

      expect(res.statusCode).toBe(404);
      expect(bodyOf(res)).toMatchObject({ errorCode: 'USER_NOT_FOUND' });
      expect(await waitingUploadsSince(mark)).toEqual([]);
      expect(await storedImage(avatarPath(user))).toBeNull();
    });
  });
});
