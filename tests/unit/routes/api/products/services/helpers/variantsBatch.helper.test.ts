import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import {
  orderAfterMoves,
  refuseWrite,
  repeatedVariantIds,
  takenAsks,
} from '@routes/api/products/services/helpers/variantsBatch.helper.js';
import { ConflictError } from '@utils/errors.js';

describe('repeatedVariantIds', () => {
  it('names each variant given more than once, once, in the order they come back', () => {
    expect(repeatedVariantIds([4, 2, 4, 9, 2, 4])).toEqual([4, 2]);
  });

  it('is empty when each variant comes once', () => {
    expect(repeatedVariantIds([1, 2, 3])).toEqual([]);
  });
});

// a write the database refused names its variant
describe('refuseWrite', () => {
  it('names the variant an error of the app came from', async () => {
    expect(await refuseWrite(7, new ConflictError('PRODUCT_SKU_TAKEN'))).toMatchObject({
      statusCode: 409,
      errorCode: 'VARIANTS_INVALID',
      details: { variants: [{ variantId: 7, errorCode: 'PRODUCT_SKU_TAKEN' }] },
    });
  });

  it('lets a failure it does not know go on as it is', async () => {
    const err = new Error('boom');

    expect(await refuseWrite(7, err)).toBe(err);
  });

  it('names the variant a new sale with an end already behind was refused for', async () => {
    // the trigger of db/05 refuses it; the message reaches the app inside the error of prisma
    const err = new Prisma.PrismaClientKnownRequestError('refused', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { driverAdapterError: { cause: { originalMessage: 'VARIANT_SALE_ENDS_AT_INVALID' } } },
    });

    expect(await refuseWrite(3, err)).toMatchObject({
      statusCode: 400,
      errorCode: 'VARIANTS_INVALID',
      details: { variants: [{ variantId: 3, errorCode: 'PRODUCT_SALE_ENDS_AT_INVALID' }] },
    });
  });
});

// which asks for a code are taken: held now by another live variant, or asked by two items
describe('takenAsks', () => {
  const same = (code: string) => code;
  const held = (entries: Array<[string, number[]]>) =>
    new Map(entries.map(([code, ids]) => [code, new Set(ids)]));

  it('names the asks whose code a live variant other than theirs holds', () => {
    const asks = [
      { variantId: 1, code: 'a' },
      { variantId: 2, code: 'b' },
      { variantId: 3, code: 'c' },
    ];

    expect(takenAsks(asks, held([['b', [9]]]), same)).toEqual([1]);
    expect(
      takenAsks(
        asks,
        held([
          ['a', [9]],
          ['c', [8]],
        ]),
        same,
      ),
    ).toEqual([0, 2]);
  });

  it('does not count the variant that holds the code itself', () => {
    // its own code in other letters: the holder is the variant that asks
    expect(
      takenAsks([{ variantId: 1, code: 'ABC' }], held([['abc', [1]]]), (c) => c.toLowerCase()),
    ).toEqual([]);
  });

  it('counts a code a variant of the batch holds now, even one that gives it up in the batch', () => {
    // variant 5 holds "x" (and asks for another code, which is no ask here), variant 6 asks for "x"
    expect(takenAsks([{ variantId: 6, code: 'x' }], held([['x', [5]]]), same)).toEqual([0]);
  });

  it('names both asks that want the same new code, in their order, whatever the case of the letters', () => {
    const asks = [
      { variantId: 1, code: 'New-1' },
      { variantId: 2, code: 'other' },
      { variantId: 3, code: 'NEW-1' },
    ];

    expect(takenAsks(asks, held([]), (c) => c.toLowerCase())).toEqual([0, 2]);
    // the barcodes are folded by nothing: the same text is the same code
    expect(takenAsks(asks, held([]), same)).toEqual([]);
  });

  it('is empty when no code is held or asked twice', () => {
    expect(
      takenAsks(
        [
          { variantId: 1, code: 'a' },
          { variantId: 2, code: 'b' },
        ],
        held([]),
        same,
      ),
    ).toEqual([]);
    expect(takenAsks([], held([['a', [1]]]), same)).toEqual([]);
  });
});

// the order of the variants of each product after the moves of a batch
describe('orderAfterMoves', () => {
  const orders = new Map([
    [1, [10, 20, 30]],
    [2, [40, 50]],
  ]);

  it('takes the moves one after the other in the order given', () => {
    // C to the front, then B in front of it: B C A (the other order gives C B A)
    expect(
      orderAfterMoves(orders, [
        { productId: 1, variantId: 30, position: 1 },
        { productId: 1, variantId: 20, position: 1 },
      ]).get(1),
    ).toEqual([20, 30, 10]);
    expect(
      orderAfterMoves(orders, [
        { productId: 1, variantId: 20, position: 1 },
        { productId: 1, variantId: 30, position: 1 },
      ]).get(1),
    ).toEqual([30, 20, 10]);
  });

  it('moves the variants of each product among their own, and gives only the products moved', () => {
    const result = orderAfterMoves(orders, [
      { productId: 2, variantId: 50, position: 1 },
      { productId: 1, variantId: 10, position: 3 },
    ]);

    expect([...result.keys()].sort()).toEqual([1, 2]);
    expect(result.get(1)).toEqual([20, 30, 10]);
    expect(result.get(2)).toEqual([50, 40]);
    expect([...orderAfterMoves(orders, []).keys()]).toEqual([]);
  });

  it('puts a variant moved again at its new place, and one moved past the last place at the last', () => {
    const result = orderAfterMoves(orders, [
      { productId: 1, variantId: 10, position: 99 },
      { productId: 1, variantId: 10, position: 1 },
    ]);

    expect(result.get(1)).toEqual([10, 20, 30]);
    expect(orderAfterMoves(orders, [{ productId: 1, variantId: 10, position: 99 }]).get(1)).toEqual(
      [20, 30, 10],
    );
  });

  it('does not change the orders it is given', () => {
    orderAfterMoves(orders, [{ productId: 1, variantId: 30, position: 1 }]);

    expect(orders.get(1)).toEqual([10, 20, 30]);
  });
});
