import { describe, expect, it } from '@jest/globals';

import {
  assertImageFile,
  buildImageUrls,
  isCloudinaryUrl,
  makePublicId,
} from '@utils/cloudinary.util.js';
import { BadRequestError } from '@utils/errors.js';

import { thrownBy } from '../../helpers/errors.js';

const base = 'https://res.cloudinary.com/demo/image/upload/v1712345678/products/7/1.jpg';

describe('makePublicId', () => {
  it('gives one avatar path per user', () => {
    expect(makePublicId({ kind: 'avatar', userId: 42 })).toBe('users/42/avatar');
  });

  it('gives one path per product image', () => {
    expect(makePublicId({ kind: 'product', productId: 7, imageKey: 2 })).toBe('products/7/2');
  });

  it('never lets an id add path segments or unsafe characters', () => {
    const id = makePublicId({ kind: 'product', productId: '../7', imageKey: 'a/b c?#' });

    expect(id.split('/')).toHaveLength(3);
    expect(id.startsWith('products/')).toBe(true);
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

describe('assertImageFile', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp', ' IMAGE/PNG '])('accepts %s', (mimetype) => {
    expect(() => assertImageFile({ mimetype, bytes: 1000 })).not.toThrow();
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

  it('accepts a file of exactly 5 MB and rejects one byte more', () => {
    const limit = 5 * 1024 * 1024;

    expect(() => assertImageFile({ mimetype: 'image/png', bytes: limit })).not.toThrow();
    expect(
      thrownBy(() => assertImageFile({ mimetype: 'image/png', bytes: limit + 1 })),
    ).toMatchObject({
      errorCode: 'IMAGE_TOO_LARGE',
    });
  });

  it('reads the size from size when bytes is not given', () => {
    expect(
      thrownBy(() => assertImageFile({ mimetype: 'image/png', size: 6 * 1024 * 1024 })),
    ).toMatchObject({ errorCode: 'IMAGE_TOO_LARGE' });
  });

  it('respects custom limits', () => {
    expect(
      thrownBy(() => assertImageFile({ mimetype: 'image/png', bytes: 11 }, { maxBytes: 10 })),
    ).toMatchObject({ errorCode: 'IMAGE_TOO_LARGE' });
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
