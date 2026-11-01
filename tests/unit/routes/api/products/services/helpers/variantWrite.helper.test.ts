import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  codeWritesOf,
  imagesChangeOf,
  imagesOf,
  knownVariantDbError,
  movedOrder,
} from '@routes/api/products/services/helpers/variantWrite.helper.js';

const foreignKey = (constraint: string) =>
  new Prisma.PrismaClientKnownRequestError(
    `Foreign key constraint violated on the constraint: \`${constraint}\``,
    { code: 'P2003', clientVersion: 'test', meta: { constraint } },
  );

describe('knownVariantDbError', () => {
  // the routes lock the pictures they check; this is the net under that lock: a picture of the
  // gallery that went between the check and the write is a wrong picture, not a failure of the server
  it('takes a picture that went from the gallery meanwhile (the key of variant_images) as VARIANT_IMAGE_NOT_FOUND', async () => {
    const known = await knownVariantDbError(foreignKey('variant_images_imageId_fkey'));

    expect(known).toMatchObject({ statusCode: 400, errorCode: 'VARIANT_IMAGE_NOT_FOUND' });
  });

  it('does not take another foreign key for a picture that is gone', async () => {
    expect(await knownVariantDbError(foreignKey('variant_images_variantId_fkey'))).toBeNull();
    expect(await knownVariantDbError(foreignKey('favorites_variantId_productId_fkey'))).toBeNull();
  });

  it('takes the message of the guard of the database for a picture of another gallery', async () => {
    const err = new Prisma.PrismaClientKnownRequestError('refused', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { driverAdapterError: { cause: { originalMessage: 'VARIANT_IMAGE_NOT_FOUND' } } },
    });

    expect(await knownVariantDbError(err)).toMatchObject({
      statusCode: 400,
      errorCode: 'VARIANT_IMAGE_NOT_FOUND',
    });
  });

  it('lets a failure it does not know go', async () => {
    expect(await knownVariantDbError(new Error('boom'))).toBeNull();
  });
});

// the order of the variants of a product after one is put at a place
describe('movedOrder', () => {
  it('puts the variant at the place and the others move around it', () => {
    expect(movedOrder([10, 20, 30], 30, 1)).toEqual([30, 10, 20]);
    expect(movedOrder([10, 20, 30], 10, 3)).toEqual([20, 30, 10]);
    expect(movedOrder([10, 20, 30], 10, 2)).toEqual([20, 10, 30]);
  });

  it('puts a variant moved past the last place at the last place', () => {
    expect(movedOrder([10, 20, 30], 10, 99)).toEqual([20, 30, 10]);
  });

  it('keeps the order when the variant is put where it is', () => {
    expect(movedOrder([10, 20, 30], 20, 2)).toEqual([10, 20, 30]);
  });

  it('does not change the list it is given', () => {
    const order = [10, 20, 30];

    movedOrder(order, 30, 1);

    expect(order).toEqual([10, 20, 30]);
  });
});

// a row of a variant that shows the pictures given, as the database read has it
const showing = (...shown: Array<[imageId: number, position: number]>) => ({
  images: shown.map(([imageId, position]) => ({
    position,
    image: { id: imageId, url: `https://example.com/${imageId}.jpg` },
  })),
});

describe('imagesOf', () => {
  it('gives the pictures a variant shows with their places', () => {
    expect(imagesOf(showing([5, 1], [7, 4]))).toEqual([
      { imageId: 5, position: 1 },
      { imageId: 7, position: 4 },
    ]);
  });
});

// the list of pictures of a change is written whole: it is a change only when it differs
describe('imagesChangeOf', () => {
  it('is null when the variant shows these pictures at these places', () => {
    expect(
      imagesChangeOf(showing([5, 1], [7, 2]), [
        { key: 5, position: 1 },
        { key: 7, position: 2 },
      ]),
    ).toBeNull();
    expect(imagesChangeOf(showing(), [])).toBeNull();
  });

  it('gives what is shown and what will be shown when the list differs', () => {
    expect(imagesChangeOf(showing([5, 1]), [{ key: 7, position: 1 }])).toEqual({
      old: [{ imageId: 5, position: 1 }],
      next: [{ imageId: 7, position: 1 }],
    });
  });

  it('counts a place that differs, or the order, as a change', () => {
    expect(imagesChangeOf(showing([5, 1]), [{ key: 5, position: 2 }])).not.toBeNull();
    expect(
      imagesChangeOf(showing([5, 1], [7, 2]), [
        { key: 7, position: 1 },
        { key: 5, position: 2 },
      ]),
    ).not.toBeNull();
  });

  it('counts an empty list as taking all the pictures away', () => {
    expect(imagesChangeOf(showing([5, 1]), [])).toEqual({
      old: [{ imageId: 5, position: 1 }],
      next: [],
    });
  });

  it('counts the pictures of a list that is longer or shorter as a change', () => {
    expect(
      imagesChangeOf(showing([5, 1]), [
        { key: 5, position: 1 },
        { key: 7, position: 2 },
      ]),
    ).not.toBeNull();
    expect(imagesChangeOf(showing([5, 1], [7, 2]), [{ key: 5, position: 1 }])).not.toBeNull();
  });
});

// the article number and the barcode a change really changes
describe('codeWritesOf', () => {
  const before = { sku: 'Abc-1', barcode: '4006381333931' };

  it('leaves out what is not sent and what the variant has already', () => {
    expect(codeWritesOf(before, {})).toEqual({
      sku: undefined,
      barcode: undefined,
      data: {},
      changes: [],
    });
    expect(codeWritesOf(before, { sku: 'Abc-1', barcode: '4006381333931' })).toMatchObject({
      sku: undefined,
      barcode: undefined,
      changes: [],
    });
  });

  it('counts the same code in other letters as a change', () => {
    expect(codeWritesOf(before, { sku: 'ABC-1' })).toEqual({
      sku: 'ABC-1',
      barcode: undefined,
      data: { sku: 'ABC-1' },
      changes: [{ field: 'sku', old: 'Abc-1', new: 'ABC-1' }],
    });
  });

  it('writes a new code with a line for each, the article number first', () => {
    expect(codeWritesOf({ sku: null, barcode: null }, { barcode: '96385074', sku: 'N-2' })).toEqual(
      {
        sku: 'N-2',
        barcode: '96385074',
        data: { sku: 'N-2', barcode: '96385074' },
        changes: [
          { field: 'sku', old: null, new: 'N-2' },
          { field: 'barcode', old: null, new: '96385074' },
        ],
      },
    );
  });

  it('writes a code taken away (null) and leaves the other alone', () => {
    expect(codeWritesOf(before, { sku: null })).toEqual({
      sku: null,
      barcode: undefined,
      data: { sku: null },
      changes: [{ field: 'sku', old: 'Abc-1', new: null }],
    });
    // there was no code to take away
    expect(codeWritesOf({ sku: null, barcode: null }, { sku: null }).changes).toEqual([]);
  });
});
