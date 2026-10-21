import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import cloudinary from '@config/cloudinary.js';
import {
  assertImageFile,
  buildImageUrls,
  deleteImage,
  detectImageType,
  discardUploads,
  isCloudinaryUrl,
  isOwnFile,
  makePublicId,
  makeUploadPublicId,
  moveImage,
  requireImageStream,
  uploadImage,
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

const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP_HEAD = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x24, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);
const GIF_HEAD = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00', 'latin1');

// a file part of a form: the bytes come in the given chunks
const fileStream = (...chunks: Buffer[]) => Readable.from(chunks, { objectMode: false });

const readAll = async (stream: NodeJS.ReadableStream) => {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(parts);
};

describe('detectImageType', () => {
  it.each([
    ['a jpeg', JPEG_HEAD, 'image/jpeg'],
    ['a png', PNG_HEAD, 'image/png'],
    ['a webp', WEBP_HEAD, 'image/webp'],
  ])('tells %s by its first bytes', (_case, head, type) => {
    expect(detectImageType(head)).toBe(type);
  });

  it.each([
    ['a gif', GIF_HEAD],
    ['an svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['text', Buffer.from('this is not an image')],
    ['a riff file that is not a webp', Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt ', 'latin1')],
    ['the start of a png that is too short', PNG_HEAD.subarray(0, 4)],
    ['nothing', Buffer.alloc(0)],
  ])('finds no image in %s', (_case, head) => {
    expect(detectImageType(head)).toBeNull();
  });
});

describe('requireImageStream', () => {
  const opts = { mimetype: 'image/png', emptyCode: 'AVATAR_STREAM_ERROR' };

  it('gives back every byte of an image, the start it read included', async () => {
    const rest = Buffer.alloc(5000, 7);

    const out = await requireImageStream(fileStream(PNG_HEAD, rest), opts);

    expect(await readAll(out)).toEqual(Buffer.concat([PNG_HEAD, rest]));
  });

  // a slow client sends a few bytes at a time; the type is told once enough came
  it('waits for enough bytes when the start comes in small pieces', async () => {
    const pieces = [...WEBP_HEAD].map((byte) => Buffer.from([byte]));

    const out = await requireImageStream(fileStream(...pieces, Buffer.from('rest')), {
      ...opts,
      mimetype: 'image/webp',
    });

    expect(await readAll(out)).toEqual(Buffer.concat([WEBP_HEAD, Buffer.from('rest')]));
  });

  it('takes a jpeg shorter than the start it reads', async () => {
    const tiny = JPEG_HEAD.subarray(0, 6);

    const out = await requireImageStream(fileStream(tiny), { ...opts, mimetype: 'image/jpeg' });

    expect(await readAll(out)).toEqual(tiny);
  });

  it('refuses an empty file with the code it is given', async () => {
    expect(await rejectedBy(() => requireImageStream(fileStream(), opts))).toMatchObject({
      statusCode: 400,
      errorCode: 'AVATAR_STREAM_ERROR',
    });
  });

  it('refuses a stream that ended already', async () => {
    const stream = fileStream(PNG_HEAD);
    await readAll(stream);

    expect(await rejectedBy(() => requireImageStream(stream, opts))).toMatchObject({
      errorCode: 'AVATAR_STREAM_ERROR',
    });
  });

  // the type a form names is the word of the client, the bytes decide
  it.each([
    ['a gif', GIF_HEAD],
    ['text', Buffer.from('this is not an image at all')],
  ])('refuses %s that says it is a png', async (_case, data) => {
    expect(await rejectedBy(() => requireImageStream(fileStream(data), opts))).toMatchObject({
      statusCode: 400,
      errorCode: 'IMAGE_TYPE_NOT_ALLOWED',
    });
  });

  it('refuses a type outside the list even when the bytes are an image', async () => {
    const res = await rejectedBy(() =>
      requireImageStream(fileStream(PNG_HEAD), { ...opts, mimetype: 'image/gif' }),
    );

    expect(res).toMatchObject({ errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
  });

  // the parser of the form goes on to the next part only once this file is read to its end
  it('reads a refused file to its end', async () => {
    const stream = fileStream(Buffer.from('this is not an image at all'), Buffer.alloc(50_000, 1));
    const ended = new Promise((resolve) => stream.once('end', resolve));

    await rejectedBy(() => requireImageStream(stream, opts));

    await expect(ended).resolves.toBeUndefined();
  });

  it('passes a failure of the file on to the stream it gave', async () => {
    const source = new PassThrough();
    const pending = requireImageStream(source, opts);
    source.write(PNG_HEAD);
    const out = await pending;
    const failed = new Promise((resolve) => out.once('error', resolve));

    source.destroy(new Error('file too large'));

    expect(await failed).toMatchObject({ message: 'file too large' });
  });
});

describe('makeUploadPublicId', () => {
  it('gives a new waiting id in the folder of the environment each time', () => {
    const first = makeUploadPublicId();

    expect(first).toMatch(/^test\/uploads\/[0-9a-f-]{36}$/);
    expect(makeUploadPublicId()).not.toBe(first);
  });
});

describe('isOwnFile', () => {
  it('takes a file of the folder of the environment', () => {
    expect(isOwnFile('test/products/7/2')).toBe(true);
  });

  // dev is restored from a copy of prod, so its rows can point to the files of prod
  it.each(['prod/products/7/2', 'dev/users/5/avatar', 'products/7/2', 'testing/x', '', null])(
    'leaves %p alone',
    (publicId) => {
      expect(isOwnFile(publicId)).toBe(false);
    },
  );
});

describe('uploadImage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // the upload stream of the sdk, answering when the file has been written into it
  const uploadAnswers = (err: unknown, result?: unknown) =>
    jest.spyOn(cloudinary.uploader, 'upload_stream').mockImplementation(((
      _options: unknown,
      callback: (err: unknown, result?: unknown) => void,
    ) => {
      const sink = new Writable({
        write(_chunk, _encoding, next) {
          next();
        },
      });
      sink.on('finish', () => callback(err, result));
      return sink;
    }) as never);

  it('asks cloudinary to keep only jpeg, png and webp files', async () => {
    const upload = uploadAnswers(undefined, {
      public_id: 'test/uploads/x',
      secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/test/uploads/x.png',
    });

    const res = await uploadImage({
      file: PNG_HEAD,
      mimetype: 'image/png',
      publicId: 'test/uploads/x',
    });

    expect(res).toEqual({
      publicId: 'test/uploads/x',
      urlBase: 'https://res.cloudinary.com/demo/image/upload/v1/test/uploads/x.png',
    });
    expect(upload.mock.calls[0]![0]).toMatchObject({
      public_id: 'test/uploads/x',
      allowed_formats: ['jpg', 'png', 'webp'],
    });
  });

  // a file cloudinary cannot read is the file of the client: 400, not 500
  it.each([
    ['Invalid image file', 'IMAGE_INVALID'],
    // the answer of cloudinary to a webp it cannot read
    ['Invalid webp file', 'IMAGE_INVALID'],
    ['Image file format gif not allowed', 'IMAGE_TYPE_NOT_ALLOWED'],
  ])('answers 400 when cloudinary says %p', async (message, errorCode) => {
    const failure = { http_code: 400, message };
    uploadAnswers(failure);

    const err = await rejectedBy(() => uploadImage({ file: PNG_HEAD, mimetype: 'image/png' }));

    expect(err).toMatchObject({ statusCode: 400, errorCode, cause: failure });
  });

  it('keeps any other refusal of cloudinary a server failure', async () => {
    uploadAnswers({ http_code: 400, message: 'Invalid public_id' });

    const err = await rejectedBy(() => uploadImage({ file: PNG_HEAD, mimetype: 'image/png' }));

    expect(err).toMatchObject({
      statusCode: 500,
      details: { reason: 'CLOUDINARY_UPLOAD_UNEXPECTED' },
    });
  });
});

describe('moveImage', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('moves the upload over the file at its place and drops the cached copies', async () => {
    const rename = jest.spyOn(cloudinary.uploader, 'rename').mockResolvedValue({
      public_id: 'test/users/5/avatar',
      secure_url: 'https://res.cloudinary.com/demo/image/upload/v2/test/users/5/avatar.png',
    } as never);

    const res = await moveImage('test/uploads/x', 'test/users/5/avatar');

    expect(rename).toHaveBeenCalledWith('test/uploads/x', 'test/users/5/avatar', {
      resource_type: 'image',
      overwrite: true,
      invalidate: true,
    });
    expect(res).toEqual({
      publicId: 'test/users/5/avatar',
      urlBase: 'https://res.cloudinary.com/demo/image/upload/v2/test/users/5/avatar.png',
    });
  });

  it.each([
    ['', 'test/users/5/avatar'],
    ['test/uploads/x', ' '],
  ])('refuses a blank id before asking cloudinary', async (from, to) => {
    const rename = jest.spyOn(cloudinary.uploader, 'rename');

    expect(await rejectedBy(() => moveImage(from, to))).toMatchObject({
      errorCode: 'PUBLIC_ID_REQUIRED',
    });
    expect(rename).not.toHaveBeenCalled();
  });

  it('wraps a cloudinary failure and keeps it as the cause', async () => {
    const failure = new Error('cloudinary is down');
    jest.spyOn(cloudinary.uploader, 'rename').mockRejectedValue(failure);

    expect(
      await rejectedBy(() => moveImage('test/uploads/x', 'test/users/5/avatar')),
    ).toMatchObject({
      statusCode: 500,
      details: { reason: 'CLOUDINARY_MOVE_UNEXPECTED' },
      cause: failure,
    });
  });
});

describe('discardUploads', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const log = () => ({ warn: jest.fn() });

  it('deletes every upload that finished and skips the ones that failed', async () => {
    const destroy = jest.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' });
    const failed = Promise.reject(new Error('upload failed'));
    failed.catch(() => undefined);

    await discardUploads(
      [
        Promise.resolve({ publicId: 'test/uploads/a' }),
        failed,
        Promise.resolve({ publicId: 'test/uploads/b' }),
      ],
      log(),
    );

    expect(destroy.mock.calls.map((call) => call[0]).sort()).toEqual([
      'test/uploads/a',
      'test/uploads/b',
    ]);
  });

  it('logs a file it cannot delete and never throws', async () => {
    jest.spyOn(cloudinary.uploader, 'destroy').mockRejectedValue(new Error('cloudinary is down'));
    const logger = log();

    await expect(
      discardUploads([Promise.resolve({ publicId: 'test/uploads/a' })], logger),
    ).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ publicId: 'test/uploads/a' }),
      'upload of a refused request was not deleted',
    );
  });

  it('waits for an upload that is still going before it deletes it', async () => {
    const destroy = jest.spyOn(cloudinary.uploader, 'destroy').mockResolvedValue({ result: 'ok' });
    let finish!: (value: { publicId: string }) => void;
    const going = new Promise<{ publicId: string }>((resolve) => (finish = resolve));

    const done = discardUploads([going], log());
    expect(destroy).not.toHaveBeenCalled();
    finish({ publicId: 'test/uploads/late' });
    await done;

    expect(destroy).toHaveBeenCalledWith('test/uploads/late', expect.anything());
  });
});
