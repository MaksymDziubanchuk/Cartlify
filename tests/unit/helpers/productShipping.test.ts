import { describe, expect, it } from '@jest/globals';

import {
  PRODUCT_SIZE_MAX_MM,
  PRODUCT_WEIGHT_MAX_GRAMS,
  readShippingChanges,
  resolveShippingData,
  type ProductShippingData,
} from '../../../src/helpers/productShipping.js';

const FULL: ProductShippingData = { weightGrams: 350, lengthMm: 200, widthMm: 100, heightMm: 50 };
const BARE: ProductShippingData = {
  weightGrams: null,
  lengthMm: null,
  widthMm: null,
  heightMm: null,
};

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return {
      code: (err as { errorCode?: string }).errorCode,
      details: (err as { details?: unknown }).details,
    };
  }
  return null;
};

describe('readShippingChanges', () => {
  it('reads nothing from nothing', () => {
    expect(readShippingChanges({})).toEqual({ changes: {}, without: false });
  });

  it('reads numbers of a json body and the text of a form the same way', () => {
    const fromJson = readShippingChanges({
      weightGrams: 350,
      lengthMm: 200,
      widthMm: 100,
      heightMm: 50,
    });
    const fromForm = readShippingChanges({
      weightGrams: '350',
      lengthMm: ' 200 ',
      widthMm: '100',
      heightMm: '50',
    });

    expect(fromJson.changes).toEqual(FULL);
    expect(fromForm.changes).toEqual(FULL);
  });

  it('reads null and the word null as a clearing', () => {
    expect(readShippingChanges({ weightGrams: null, lengthMm: 'null' }).changes).toEqual({
      weightGrams: null,
      lengthMm: null,
    });
  });

  it('takes the limits themselves and refuses what is beyond them', () => {
    expect(readShippingChanges({ weightGrams: PRODUCT_WEIGHT_MAX_GRAMS }).changes.weightGrams).toBe(
      PRODUCT_WEIGHT_MAX_GRAMS,
    );
    expect(readShippingChanges({ lengthMm: PRODUCT_SIZE_MAX_MM }).changes.lengthMm).toBe(
      PRODUCT_SIZE_MAX_MM,
    );
    expect(
      codeOf(() => readShippingChanges({ weightGrams: PRODUCT_WEIGHT_MAX_GRAMS + 1 }))?.code,
    ).toBe('PRODUCT_WEIGHT_INVALID');
    expect(codeOf(() => readShippingChanges({ heightMm: PRODUCT_SIZE_MAX_MM + 1 }))?.code).toBe(
      'PRODUCT_SIZES_INVALID',
    );
  });

  it.each([0, -1, 1.5, NaN, Infinity, '0', '-5', '1.5', '1e3', 'abc', ' ', '', '01', {}, [], true])(
    'refuses the weight %p',
    (value) => {
      expect(codeOf(() => readShippingChanges({ weightGrams: value }))?.code).toBe(
        'PRODUCT_WEIGHT_INVALID',
      );
    },
  );

  it.each([0, -1, 1.5, '0', 'x', ' '])(
    'refuses the size %p, whichever of the three it is',
    (value) => {
      for (const field of ['lengthMm', 'widthMm', 'heightMm']) {
        expect(codeOf(() => readShippingChanges({ [field]: value }))?.code).toBe(
          'PRODUCT_SIZES_INVALID',
        );
      }
    },
  );

  it.each([
    [true, true],
    ['true', true],
    [' true ', true],
    [false, false],
    ['false', false],
    [undefined, false],
  ])('reads the flag %p as %p', (value, expected) => {
    expect(readShippingChanges({ withoutShippingData: value }).without).toBe(expected);
  });

  it.each(['yes', 'TRUE', '1', 1, null, {}])('refuses the flag %p', (value) => {
    expect(codeOf(() => readShippingChanges({ withoutShippingData: value }))?.code).toBe(
      'PRODUCT_WITHOUT_SHIPPING_DATA_INVALID',
    );
  });
});

describe('resolveShippingData', () => {
  it('gives a new product with the weight and the three sizes what it was given', () => {
    expect(resolveShippingData(null, FULL, false)).toEqual(FULL);
  });

  it('names what a new product lacks', () => {
    expect(codeOf(() => resolveShippingData(null, {}, false))).toEqual({
      code: 'PRODUCT_SHIPPING_DATA_REQUIRED',
      details: { fields: ['weightGrams', 'sizesMm'] },
    });
    expect(codeOf(() => resolveShippingData(null, { weightGrams: 1 }, false))).toEqual({
      code: 'PRODUCT_SHIPPING_DATA_REQUIRED',
      details: { fields: ['sizesMm'] },
    });
    expect(
      codeOf(() => resolveShippingData(null, { lengthMm: 1, widthMm: 1, heightMm: 1 }, false)),
    ).toEqual({ code: 'PRODUCT_SHIPPING_DATA_REQUIRED', details: { fields: ['weightGrams'] } });
  });

  it('lets a new product come without them when the admin says so', () => {
    expect(resolveShippingData(null, {}, true)).toEqual(BARE);
    expect(resolveShippingData(null, { weightGrams: 5 }, true)).toEqual({
      ...BARE,
      weightGrams: 5,
    });
  });

  it('refuses one or two sizes, the flag or not, before it asks for what is missing', () => {
    for (const without of [false, true]) {
      expect(codeOf(() => resolveShippingData(null, { lengthMm: 1 }, without))?.code).toBe(
        'PRODUCT_SIZES_INCOMPLETE',
      );
      expect(
        codeOf(() => resolveShippingData(null, { lengthMm: 1, widthMm: 2 }, without))?.code,
      ).toBe('PRODUCT_SIZES_INCOMPLETE');
    }
  });

  it('changes one size of a product that has all three', () => {
    expect(resolveShippingData(FULL, { widthMm: 120 }, false)).toEqual({ ...FULL, widthMm: 120 });
  });

  it('refuses to clear one size of three, the flag or not', () => {
    for (const without of [false, true]) {
      expect(codeOf(() => resolveShippingData(FULL, { heightMm: null }, without))?.code).toBe(
        'PRODUCT_SIZES_INCOMPLETE',
      );
    }
  });

  it('writes the sizes of a product that has none, the three at once', () => {
    expect(resolveShippingData(BARE, { lengthMm: 1, widthMm: 2, heightMm: 3 }, false)).toEqual({
      ...BARE,
      lengthMm: 1,
      widthMm: 2,
      heightMm: 3,
    });
    expect(codeOf(() => resolveShippingData(BARE, { lengthMm: 1 }, false))?.code).toBe(
      'PRODUCT_SIZES_INCOMPLETE',
    );
  });

  it('asks the flag for clearing what is known, and names what is cleared', () => {
    const clearedWeight = codeOf(() => resolveShippingData(FULL, { weightGrams: null }, false));
    const clearedSizes = codeOf(() =>
      resolveShippingData(FULL, { lengthMm: null, widthMm: null, heightMm: null }, false),
    );

    expect(clearedWeight).toEqual({
      code: 'PRODUCT_SHIPPING_DATA_REQUIRED',
      details: { fields: ['weightGrams'] },
    });
    expect(clearedSizes).toEqual({
      code: 'PRODUCT_SHIPPING_DATA_REQUIRED',
      details: { fields: ['sizesMm'] },
    });
    expect(resolveShippingData(FULL, { weightGrams: null }, true)).toEqual({
      ...FULL,
      weightGrams: null,
    });
    expect(
      resolveShippingData(FULL, { lengthMm: null, widthMm: null, heightMm: null }, true),
    ).toEqual({
      ...BARE,
      weightGrams: 350,
    });
  });

  it('asks for nothing of a product that lacks the data and is changed in another way', () => {
    expect(resolveShippingData(BARE, {}, false)).toEqual(BARE);
    expect(resolveShippingData(BARE, { weightGrams: null }, false)).toEqual(BARE);
    expect(resolveShippingData({ ...BARE, weightGrams: 5 }, { weightGrams: 6 }, false)).toEqual({
      ...BARE,
      weightGrams: 6,
    });
  });
});
