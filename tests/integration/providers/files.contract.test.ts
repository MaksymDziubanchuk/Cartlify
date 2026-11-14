import { randomUUID } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import { fileStorage } from '@providers/files/index.js';
import { isAppError } from '@utils/errors.js';

import { rejectedBy } from '../../helpers/errors.js';
import { fileStorageHarness } from '../../helpers/providers.js';

// The contract of a storage of files: what the rest of the app counts on, whoever keeps the pictures
// and the documents (src/providers/files/types.ts). The storage of the server goes through these
// tests, made to answer by its entry in tests/helpers/providers.ts (its mock, or the real account
// when the run takes it); another storage passes them without tests of its own.

const harness = fileStorageHarness[fileStorage.name];

// an id of its own for each file, in the folder of the tests
const newId = (what: string) => `${harness.folder}contract/${what}-${randomUUID()}`;

const codeOf = (err: unknown) => (isAppError(err) ? err.errorCode : String(err));

describe(`the file storage ${fileStorage.name}`, () => {
  it('keeps a picture under the id it is given, serves it and gives it in the sizes of a page', async () => {
    const publicId = newId('image');

    const kept = await fileStorage.uploadImage({
      file: harness.image(),
      mimetype: 'image/png',
      publicId,
    });

    expect(kept).toEqual({ publicId, urlBase: expect.stringMatching(/^https:\/\//) });
    expect(await harness.keeps(publicId)).toBe(true);
    expect(fileStorage.isOwnUrl(kept.urlBase)).toBe(true);

    const avatar = fileStorage.imageUrls(kept.urlBase, 'avatar');
    const product = fileStorage.imageUrls(kept.urlBase, 'product');
    expect(Object.keys(avatar).sort()).toEqual(['url128', 'url256', 'url32', 'url64']);
    expect(Object.keys(product).sort()).toEqual(['url200', 'url400', 'url800']);
    for (const url of [...Object.values(avatar), ...Object.values(product)]) {
      expect(fileStorage.isOwnUrl(url)).toBe(true);
    }

    await fileStorage.deleteImage(publicId);
    expect(await harness.keeps(publicId)).toBe(false);
  });

  it('moves a picture to its place, replacing one there, and deletes a gone one without an error', async () => {
    const waiting = await fileStorage.uploadImage({
      file: harness.image(),
      mimetype: 'image/png',
      publicId: newId('waiting'),
    });
    const place = newId('place');
    await fileStorage.uploadImage({
      file: harness.image(),
      mimetype: 'image/png',
      publicId: place,
    });

    const moved = await fileStorage.moveImage(waiting.publicId, place, { invalidate: true });

    expect(moved.publicId).toBe(place);
    expect(await harness.keeps(waiting.publicId)).toBe(false);
    expect(await harness.keeps(place)).toBe(true);

    await fileStorage.deleteImage(place);
    await expect(fileStorage.deleteImage(place)).resolves.toBeUndefined();
  });

  it('refuses a picture it cannot read as the file of the client, and one of another type', async () => {
    const broken = await rejectedBy(() =>
      fileStorage.uploadImage({
        file: harness.brokenImage(),
        mimetype: 'image/png',
        publicId: newId('broken'),
      }),
    );
    const other = await rejectedBy(() =>
      fileStorage.uploadImage({ file: harness.image(), mimetype: 'image/gif' }),
    );

    expect(broken).toMatchObject({ statusCode: 400, errorCode: 'IMAGE_INVALID' });
    expect(other).toMatchObject({ statusCode: 400, errorCode: 'IMAGE_TYPE_NOT_ALLOWED' });
  });

  it('says it cannot be reached when a move gets no answer', async () => {
    const waiting = await fileStorage.uploadImage({
      file: harness.image(),
      mimetype: 'image/png',
      publicId: newId('silent'),
    });

    const err = await harness.silentMoves(() =>
      rejectedBy(() =>
        fileStorage.moveImage(waiting.publicId, newId('nowhere'), { invalidate: false }),
      ),
    );

    expect(codeOf(err)).toBe('IMAGE_STORAGE_UNAVAILABLE');
    await fileStorage.deleteImage(waiting.publicId);
  });

  it('keeps the pdf of a document under the id it is given, and deletes it once', async () => {
    const publicId = newId('document');

    const kept = await fileStorage.uploadDocument({ file: harness.pdf(), publicId });

    expect(kept).toEqual({
      publicId: expect.stringContaining(publicId),
      url: expect.stringMatching(/^https:\/\//),
      sizeBytes: expect.any(Number),
    });
    expect(kept.sizeBytes).toBeGreaterThan(0);

    await fileStorage.deleteDocument(kept.publicId);
    await expect(fileStorage.deleteDocument(kept.publicId)).resolves.toBeUndefined();
  });

  it('refuses a pdf it cannot read as the file of the client', async () => {
    const err = await rejectedBy(() =>
      fileStorage.uploadDocument({ file: harness.brokenPdf(), publicId: newId('broken-pdf') }),
    );

    expect(err).toMatchObject({ statusCode: 400, errorCode: 'DOCUMENT_INVALID' });
  });

  it('draws the avatar of a letter in the sizes of an avatar', () => {
    const urls = fileStorage.letterAvatarUrls('A', 'E53935');

    expect(Object.keys(urls).sort()).toEqual(['url128', 'url256', 'url32', 'url64']);
    expect(new Set(Object.values(urls)).size).toBe(4);
  });

  it('tells an address of somebody else as not its own', () => {
    expect(fileStorage.isOwnUrl('https://example.com/a.png')).toBe(false);
    expect(fileStorage.isOwnUrl('not a url')).toBe(false);
    expect(fileStorage.isOwnUrl(undefined)).toBe(false);
  });
});
