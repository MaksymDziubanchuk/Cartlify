import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';

import { accessCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import { imageField, pngImage } from '../../../helpers/cloudinary.js';
import { closeSessions, createUser } from '../../../helpers/factories.js';
import { multipartBody, type FormPart } from '../../../helpers/multipart.js';

// PATCH /api/users/me sent as a multipart form, the way a page sends an avatar with the fields.
// A form skips the request schema, so the service holds the rules for it. Uploads of an avatar
// go to Cloudinary (into the test/ folder) and the test environment has only made-up Cloudinary
// keys, so only the avatars the app refuses before the upload are tried here

let app: FastifyInstance;
let csrf: Csrf;
const userIds: number[] = [];

const newUser = async (opts: Parameters<typeof createUser>[0] = {}) => {
  const user = await createUser(opts);
  userIds.push(user.id);
  return user;
};

const rowOf = (id: number) => asAdmin((tx) => tx.user.findUniqueOrThrow({ where: { id } }));

const patchForm = (cookie: string, parts: FormPart[]) => {
  const { payload, headers } = multipartBody(parts);

  return app.inject({
    method: 'PATCH',
    url: '/api/users/me',
    headers: { ...withCsrf(csrf, cookie), ...headers },
    payload,
  });
};

const fields = (values: Record<string, string>): FormPart[] =>
  Object.entries(values).map(([name, value]) => ({ name, value }));

// an avatar the row points to; the file is not at Cloudinary, the tests here look at the row
const ownAvatar = () => ({
  avatarUrl: 'https://res.cloudinary.com/demo/image/upload/v1/test/users/form/avatar.png',
  publicId: 'test/users/form/avatar',
});

const textFile = (data: string | Buffer): FormPart => ({
  name: 'avatar',
  filename: 'avatar.txt',
  contentType: 'text/plain',
  data: Buffer.from(data),
});

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  try {
    await closeSessions(userIds);
  } finally {
    await stopApp();
  }
});

describe('PATCH /api/users/me with a form', () => {
  it('changes the fields of the form', async () => {
    const user = await newUser();

    const res = await patchForm(
      accessCookie(user),
      fields({ name: 'Anna', locale: 'uk', phone: '+380501234567' }),
    );

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Anna', locale: 'uk', phone: '+380501234567' });
    expect(await rowOf(user.id)).toMatchObject({
      name: 'Anna',
      locale: 'uk',
      phone: '+380501234567',
    });
  });

  it.each(['+12345678', '+123456789012345'])(
    'takes the phone %s at the length limits',
    async (phone) => {
      const user = await newUser();

      const res = await patchForm(accessCookie(user), fields({ phone }));

      expect(res.statusCode).toBe(200);
      expect(res.json().phone).toBe(phone);
    },
  );

  // only +380501234567 goes through, a number is never cleaned for the form
  it.each([
    ['letters', 'abc'],
    ['no plus sign', '380501234567'],
    ['a zero right after the plus', '+0123456789'],
    ['too few digits', '+1234567'],
    ['too many digits', '+1234567890123456'],
    ['spaces, brackets and dashes', '+38 (050) 123-45-67'],
    ['a space before the number', ' +380501234567'],
    ['a space after the number', '+380501234567 '],
    ['only spaces', '   '],
  ])('refuses a phone with %s and changes nothing', async (_case, phone) => {
    const user = await newUser({ name: 'Anna', phone: '+380501234567' });

    const res = await patchForm(accessCookie(user), fields({ name: 'Hanna', phone }));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'PHONE_INVALID' });
    expect(await rowOf(user.id)).toMatchObject({ name: 'Anna', phone: '+380501234567' });
  });

  it('clears the phone when the field is empty', async () => {
    const user = await newUser({ phone: '+380501234567' });

    const res = await patchForm(accessCookie(user), fields({ phone: '' }));

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('phone');
    expect((await rowOf(user.id)).phone).toBeNull();
  });

  // a form skips the schema, the service holds the same limit for it
  describe.each([
    ['name', 'NAME_TOO_LONG'],
    ['locale', 'LOCALE_TOO_LONG'],
  ] as const)('the %s length limit', (field, errorCode) => {
    it('takes 100 characters', async () => {
      const user = await newUser();

      const res = await patchForm(accessCookie(user), fields({ [field]: 'x'.repeat(100) }));

      expect(res.statusCode).toBe(200);
      expect(res.json()[field]).toBe('x'.repeat(100));
    });

    it('counts characters, not UTF-16 units', async () => {
      const user = await newUser();

      const res = await patchForm(accessCookie(user), fields({ [field]: '😀'.repeat(100) }));

      expect(res.statusCode).toBe(200);
    });

    it('refuses 101 characters and changes nothing', async () => {
      const user = await newUser({ name: 'Anna', locale: 'uk' });

      const res = await patchForm(accessCookie(user), fields({ [field]: 'x'.repeat(101) }));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode });
      expect(await rowOf(user.id)).toMatchObject({ name: 'Anna', locale: 'uk' });
    });
  });

  it('ignores fields the profile does not have', async () => {
    const user = await newUser();

    const res = await patchForm(accessCookie(user), fields({ name: 'Anna', role: 'ROOT' }));

    expect(res.statusCode).toBe(200);
    expect((await rowOf(user.id)).role).toBe('USER');
  });

  it('refuses a form with nothing to change', async () => {
    const user = await newUser();

    const res = await patchForm(accessCookie(user), fields({ role: 'ROOT' }));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'NO_FIELDS_TO_UPDATE' });
  });

  describe('avatar', () => {
    it('refuses an empty file and changes nothing', async () => {
      const user = await newUser({ name: 'Anna' });

      const res = await patchForm(accessCookie(user), [
        ...fields({ name: 'Hanna' }),
        textFile(Buffer.alloc(0)),
      ]);

      expect(res.statusCode).toBe(400);
      expect(res.json().errorCode).toMatch(/^AVATAR_/);
      expect((await rowOf(user.id)).name).toBe('Anna');
    });

    it('refuses a file that is not a jpeg, png or webp image and changes nothing', async () => {
      const user = await newUser({ name: 'Anna' });

      const res = await patchForm(accessCookie(user), [
        ...fields({ name: 'Hanna' }),
        textFile('this is not an image'),
      ]);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
      expect(await rowOf(user.id)).toMatchObject({ name: 'Anna', avatarUrl: null });
    });

    it('refuses two avatar files in one request', async () => {
      const user = await newUser();

      const res = await patchForm(accessCookie(user), [textFile('first'), textFile('second')]);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'AVATAR_MULTIPLE' });
    });

    // the limit cuts the file while it is read; the answer is the one the swagger describes
    it('answers 413 PAYLOAD_TOO_LARGE for a file over the limit and changes nothing', async () => {
      const user = await newUser({ name: 'Anna' });

      const res = await patchForm(accessCookie(user), [
        ...fields({ name: 'Hanna' }),
        textFile(Buffer.alloc(MAX_UPLOAD_SIZE_BYTES + 1, 65)),
      ]);

      expect(res.statusCode).toBe(413);
      expect(res.json()).toEqual({
        code: 413,
        errorCode: 'PAYLOAD_TOO_LARGE',
        message: 'Payload Too Large',
        reqId: expect.any(String),
      });
      expect((await rowOf(user.id)).name).toBe('Anna');
    });

    it('skips a file in a field that is not the avatar', async () => {
      const user = await newUser();

      const res = await patchForm(accessCookie(user), [
        ...fields({ name: 'Anna' }),
        { name: 'photo', filename: 'photo.png', contentType: 'image/png', data: Buffer.from('x') },
      ]);

      expect(res.statusCode).toBe(200);
      // no picture was taken: the avatar is the letter of the name
      expect(res.json()).toMatchObject({ name: 'Anna', avatarIsDefault: true });
    });

    // an empty value removes a field of the profile, the avatar too
    it('removes the picture with an empty avatar field', async () => {
      const user = await newUser({ name: 'Anna', ...ownAvatar() });

      const res = await patchForm(accessCookie(user), fields({ name: 'Hanna', avatar: '' }));

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: 'Hanna', avatarIsDefault: true });
      expect(await rowOf(user.id)).toMatchObject({ avatarUrl: null, publicId: null });
    });

    it('refuses an avatar field of text that is not empty and changes nothing', async () => {
      const user = await newUser({ name: 'Anna', ...ownAvatar() });

      const res = await patchForm(
        accessCookie(user),
        fields({ name: 'Hanna', avatar: 'https://images.example.com/me.png' }),
      );

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'AVATAR_NOT_A_FILE' });
      expect(await rowOf(user.id)).toMatchObject({
        name: 'Anna',
        avatarUrl: ownAvatar().avatarUrl,
      });
    });

    it('refuses an empty avatar field next to an avatar file', async () => {
      const user = await newUser({ name: 'Anna', ...ownAvatar() });

      const res = await patchForm(accessCookie(user), [
        ...fields({ avatar: '' }),
        imageField('avatar', pngImage(20, 20)),
      ]);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'AVATAR_MULTIPLE' });
      expect(await rowOf(user.id)).toMatchObject({ avatarUrl: ownAvatar().avatarUrl });
    });
  });
});
