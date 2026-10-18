import { afterEach, describe, expect, it, jest } from '@jest/globals';

import cloudinary from '@config/cloudinary.js';
import {
  assertImageFile,
  buildImageUrls,
  deleteImage,
  isCloudinaryUrl,
  makePublicId,
} from '@utils/cloudinary.util.js';
import { BadRequestError } from '@utils/errors.js';

import { rejectedBy, thrownBy } from '../../helpers/errors.js';
import { importWithEnv } from '../../helpers/freshImport.js';

const base = 'https://res.cloudinary.com/demo/image/upload/v1712345678/products/7/1.jpg';

// the tests run with NODE_ENV=test, so their files go to the test folder
describe('makePublicId', () => {
  it('gives one avatar path per user, in the folder of the environment', () => {
    expect(makePublicId({ kind: 'avatar', userId: 42 })).toBe('test/users/42/avatar');
  });

  it('gives one path per product image, in the folder of the environment', () => {
    expect(makePublicId({ kind: 'product', productId: 7, imageKey: 2 })).toBe('test/products/7/2');
  });

  it('never lets an id add path segments or unsafe characters', () => {
    const id = makePublicId({ kind: 'product', productId: '../7', imageKey: 'a/b c?#' });

    expect(id.split('/')).toHaveLength(4);
    expect(id.startsWith('test/products/')).toBe(true);
    expect(id).not.toMatch(/\.\.\/|[?# ]/);
  });

  it('throws when the user id is blank', () => {
    expect(thrownBy(() => makePublicId({ kind: 'avatar', userId: '  ' }))).toMatchObject({
      errorCode: 'PUBLIC_ID_USER_REQUIRED',
    });
  });

  it('throws when the product id or the image key is blank', () => {
    expect(
      thrownBy(() => makePublicId({ kind: 'product', productId: '', imageKey: 1 })),
    ).toMatchObject({ errorCode: 'PUBLIC_ID_PRODUCT_REQUIRED' });
    expect(
      thrownBy(() => makePublicId({ kind: 'product', productId: 1, imageKey: '' })),
    ).toMatchObject({ errorCode: 'PUBLIC_ID_IMAGEKEY_REQUIRED' });
  });

  it('throws when an id has only unsafe characters', () => {
    expect(thrownBy(() => makePublicId({ kind: 'avatar', userId: '???' }))).toBeInstanceOf(
      BadRequestError,
    );
  });
});

// every environment numbers its users and products from 1: user 5 of dev and of prod must
// never share a file of the same account
describe('ENV_FOLDER', () => {
  it.each([
    ['production', 'prod'],
    ['development', 'dev'],
    ['test', 'test'],
  ])('puts the files of %s into %s', async (nodeEnv, folder) => {
    const util = await importWithEnv<typeof import('@utils/cloudinary.util.js')>(
      '@utils/cloudinary.util.js',
      { NODE_ENV: nodeEnv },
    );

    expect(util.ENV_FOLDER).toBe(folder);
    expect(util.makePublicId({ kind: 'avatar', userId: 5 })).toBe(`${folder}/users/5/avatar`);
  });
});

describe('assertImageFile', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', ' IMAGE/PNG '])('accepts %s', (mimetype) => {
    expect(() => assertImageFile({ mimetype })).not.toThrow();
  });

  it.each(['image/gif', 'image/svg+xml', 'application/pdf', '', null, undefined])(
    'rejects the type %p',
    (mimetype) => {
      const meta = mimetype === undefined ? {} : { mimetype };

      expect(thrownBy(() => assertImageFile(meta))).toMatchObject({
        errorCode: 'IMAGE_TYPE_NOT_ALLOWED',
      });
    },
  );

  it('respects a custom list of types', () => {
    expect(() =>
      assertImageFile({ mimetype: 'image/gif' }, { allowedMimeTypes: ['image/gif'] }),
    ).not.toThrow();
  });
});

describe('isCloudinaryUrl', () => {
  it.each([
    base,
    'http://res.cloudinary.com/x/image/upload/a.png',
    'https://eu.res.cloudinary.com/a',
  ])('accepts %s', (url) => {
    expect(isCloudinaryUrl(url)).toBe(true);
  });

  it.each([
    ['another host', 'https://example.com/image/upload/a.png'],
    ['a look-alike host', 'https://res.cloudinary.com.evil.io/a.png'],
    ['a look-alike suffix', 'https://fakeres.cloudinary.com/a.png'],
    ['another protocol', 'ftp://res.cloudinary.com/a.png'],
    ['not a url', 'res.cloudinary.com/a.png'],
    ['empty', ''],
    ['not a string', 42],
  ])('rejects %s', (_case, url) => {
    expect(isCloudinaryUrl(url)).toBe(false);
  });
});

describe('buildImageUrls', () => {
  it('builds three product sizes that keep the whole item visible', () => {
    const urls = buildImageUrls(base, 'product');

    expect(urls).toEqual({
      url200: base.replace('/upload/', '/upload/c_fit,w_200,h_200,f_auto,q_auto/'),
      url400: base.replace('/upload/', '/upload/c_fit,w_400,h_400,f_auto,q_auto/'),
      url800: base.replace('/upload/', '/upload/c_fit,w_800,h_800,f_auto,q_auto/'),
    });
  });

  it('builds four square avatar sizes cropped to the face', () => {
    const urls = buildImageUrls(base, 'avatar');

    expect(Object.keys(urls)).toEqual(['url32', 'url64', 'url128', 'url256']);
    expect(urls.url64).toBe(
      base.replace('/upload/', '/upload/c_fill,g_face,w_64,h_64,f_auto,q_auto/'),
    );
  });

  it('keeps the version segment right after the transforms', () => {
    expect(buildImageUrls(base, 'product').url200).toContain(',q_auto/v1712345678/products/');
  });

  it('leaves a url without /upload/ as it is', () => {
    const other = 'https://example.com/a.png';

    expect(buildImageUrls(other, 'product').url400).toBe(other);
  });
});

describe('deleteImage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('removes the image by its public id and drops the cached copies', async () => {
    const destroy = jest.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' });

    await deleteImage('users/42/avatar');

    expect(destroy).toHaveBeenCalledWith('users/42/avatar', {
      resource_type: 'image',
      invalidate: true,
    });
  });

  it.each(['', '   '])('refuses a blank public id before asking cloudinary', async (publicId) => {
    const destroy = jest.spyOn(cloudinary.uploader, 'destroy');

    expect(await rejectedBy(() => deleteImage(publicId))).toMatchObject({
      errorCode: 'PUBLIC_ID_REQUIRED',
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  it('wraps a cloudinary failure and keeps it as the cause', async () => {
    const failure = new Error('cloudinary is down');
    jest.spyOn(cloudinary.uploader, 'destroy').mockRejectedValue(failure);

    expect(await rejectedBy(() => deleteImage('users/42/avatar'))).toMatchObject({
      statusCode: 500,
      details: { reason: 'CLOUDINARY_DELETE_UNEXPECTED' },
      cause: failure,
    });
  });
});
