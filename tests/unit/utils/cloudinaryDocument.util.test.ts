import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import cloudinary from '@config/cloudinary.js';
import {
  deleteDocument,
  isPdf,
  makeDocumentPublicId,
  requirePdfStream,
  uploadDocument,
} from '@utils/cloudinary.util.js';

import { rejectedBy } from '../../helpers/errors.js';

// the PDF files of the documents of products: told by their first bytes, not by the type a form
// names, and kept on Cloudinary as pdf files

const PDF_HEAD = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');

const fileStream = (...chunks: Buffer[]) => Readable.from(chunks, { objectMode: false });

const readAll = async (stream: NodeJS.ReadableStream) => {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(parts);
};

describe('isPdf', () => {
  it.each([
    ['a pdf', PDF_HEAD, true],
    ['a pdf of the shortest start', Buffer.from('%PDF-'), true],
    ['a start that is too short', Buffer.from('%PDF'), false],
    ['a zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), false],
    ['a png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), false],
    ['text that names a pdf later', Buffer.from(' %PDF-1.4'), false],
    ['nothing', Buffer.alloc(0), false],
  ])('knows %s', (_what, head, expected) => {
    expect(isPdf(head)).toBe(expected);
  });
});

describe('requirePdfStream', () => {
  const opts = { mimetype: 'application/pdf', emptyCode: 'DOCUMENT_STREAM_ERROR' };

  it('gives back every byte of a pdf, the start it read included', async () => {
    const rest = Buffer.alloc(5000, 7);

    const out = await requirePdfStream(fileStream(PDF_HEAD, rest), opts);

    expect(await readAll(out)).toEqual(Buffer.concat([PDF_HEAD, rest]));
  });

  it('waits for enough bytes when the start comes in small pieces', async () => {
    const pieces = [...PDF_HEAD].map((byte) => Buffer.from([byte]));

    const out = await requirePdfStream(fileStream(...pieces, Buffer.from('rest')), opts);

    expect(await readAll(out)).toEqual(Buffer.concat([PDF_HEAD, Buffer.from('rest')]));
  });

  it('takes a pdf shorter than the start it reads', async () => {
    const tiny = Buffer.from('%PDF-1.4');

    const out = await requirePdfStream(fileStream(tiny), opts);

    expect(await readAll(out)).toEqual(tiny);
  });

  it('refuses a type the form names that is not a pdf, whatever the bytes are', async () => {
    const err = await rejectedBy(() =>
      requirePdfStream(fileStream(PDF_HEAD), { ...opts, mimetype: 'image/png' }),
    );

    expect(err).toMatchObject({ statusCode: 400, errorCode: 'DOCUMENT_TYPE_NOT_ALLOWED' });
  });

  it('refuses bytes that are not a pdf, whatever type the form names', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);

    const err = await rejectedBy(() => requirePdfStream(fileStream(png), opts));

    expect(err).toMatchObject({ statusCode: 400, errorCode: 'DOCUMENT_TYPE_NOT_ALLOWED' });
  });

  it('refuses an empty file with the code it is given', async () => {
    const err = await rejectedBy(() => requirePdfStream(fileStream(), opts));

    expect(err).toMatchObject({ statusCode: 400, errorCode: 'DOCUMENT_STREAM_ERROR' });
  });

  it('refuses a stream that ended already', async () => {
    const stream = fileStream(PDF_HEAD);
    await readAll(stream);

    const err = await rejectedBy(() => requirePdfStream(stream, opts));

    expect(err).toMatchObject({ errorCode: 'DOCUMENT_STREAM_ERROR' });
  });
});

describe('makeDocumentPublicId', () => {
  it('names a file of its own in the documents folder of the environment', () => {
    const first = makeDocumentPublicId();
    const second = makeDocumentPublicId();

    expect(first).toMatch(/^test\/documents\/[0-9a-f-]{36}$/);
    expect(second).not.toBe(first);
  });
});

describe('uploadDocument', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

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

  it('keeps the file as a pdf under a public id of its own, within a time', async () => {
    const upload = uploadAnswers(undefined, {
      public_id: 'test/documents/x.pdf',
      secure_url: 'https://res.cloudinary.com/demo/image/upload/v1/test/documents/x.pdf',
      bytes: 4321,
    });

    const res = await uploadDocument({ file: PDF_HEAD });

    expect(res).toEqual({
      publicId: 'test/documents/x.pdf',
      url: 'https://res.cloudinary.com/demo/image/upload/v1/test/documents/x.pdf',
      sizeBytes: 4321,
    });
    const options = upload.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(options).toMatchObject({ resource_type: 'image', allowed_formats: ['pdf'] });
    expect(options.public_id).toMatch(/^test\/documents\/[0-9a-f-]{36}$/);
    expect(options.timeout).toBeGreaterThan(8_000);
  });

  it('is 503 when Cloudinary is out of reach and 500 for any other failure', async () => {
    uploadAnswers({ error: { name: 'TimeoutError', http_code: 499 } });
    const out = await rejectedBy(() => uploadDocument({ file: PDF_HEAD }));
    jest.restoreAllMocks();

    uploadAnswers(Object.assign(new Error('boom'), { http_code: 400 }));
    const other = await rejectedBy(() => uploadDocument({ file: PDF_HEAD }));

    expect(out).toMatchObject({ statusCode: 503, errorCode: 'IMAGE_STORAGE_UNAVAILABLE' });
    expect(other).toMatchObject({ statusCode: 500 });
  });

  it('is 400 DOCUMENT_INVALID when Cloudinary cannot read the file as a pdf', async () => {
    uploadAnswers(Object.assign(new Error('Invalid PDF file'), { http_code: 400 }));

    const err = await rejectedBy(() => uploadDocument({ file: PDF_HEAD }));

    expect(err).toMatchObject({ statusCode: 400, errorCode: 'DOCUMENT_INVALID' });
  });
});

describe('deleteDocument', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deletes a pdf file within a time and drops its cached copies', async () => {
    const destroy = jest
      .spyOn(cloudinary.uploader, 'destroy')
      .mockResolvedValue({ result: 'ok' } as never);

    await deleteDocument('test/documents/x.pdf');

    expect(destroy).toHaveBeenCalledWith(
      'test/documents/x.pdf',
      expect.objectContaining({ resource_type: 'image', invalidate: true, timeout: 8_000 }),
    );
  });

  it('refuses an empty public id', async () => {
    const err = await rejectedBy(() => deleteDocument('  '));

    expect(err).toMatchObject({ statusCode: 400, errorCode: 'PUBLIC_ID_REQUIRED' });
  });
});
