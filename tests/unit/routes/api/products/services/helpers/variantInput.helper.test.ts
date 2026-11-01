import { describe, expect, it } from '@jest/globals';

import { MAX_PRODUCT_VARIANTS, MAX_VARIANT_IMAGES } from '@config/limits.js';
import {
  parseVariantsText,
  planNewVariant,
  planNewVariants,
  planVariantImages,
  planVariantUpdate,
  planVariantsChange,
  readVariantPrice,
  readVariantSale,
  repeatedCodes,
  type ImageSource,
} from '@routes/api/products/services/helpers/variantInput.helper.js';
import { BadRequestError } from '@utils/errors.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

const EAN13 = '4006381333931';

const FILES: ImageSource = { kind: 'files', count: 3 };
const GALLERY: ImageSource = { kind: 'gallery' };

const failure = (fn: () => unknown) => {
  const err = thrownBy(fn);

  expect(err).toBeInstanceOf(BadRequestError);
  const { errorCode, details } = err as BadRequestError;
  return { errorCode, details };
};

const codeOf = (fn: () => unknown) => failure(fn).errorCode;

// a variant that is right, with the weight and the sizes a new variant needs
const valid = {
  price: 12.5,
  weightGrams: 300,
  lengthMm: 200,
  widthMm: 100,
  heightMm: 50,
  images: [{ file: 0, position: 1 }],
};

describe('planVariantImages', () => {
  it('reads the pictures with their places, by the number of a file or by the id of a picture', () => {
    expect(
      planVariantImages(
        [
          { file: 2, position: 1 },
          { file: 0, position: 4 },
        ],
        FILES,
        { required: true },
      ),
    ).toEqual([
      { key: 2, position: 1 },
      { key: 0, position: 4 },
    ]);
    expect(planVariantImages([{ imageId: 9, position: 1 }], GALLERY, { required: true })).toEqual([
      { key: 9, position: 1 },
    ]);
  });

  it.each([[undefined], [null], [[]]])('wants a picture of a new variant: %p', (raw) => {
    expect(codeOf(() => planVariantImages(raw, FILES, { required: true }))).toBe(
      'VARIANT_IMAGE_REQUIRED',
    );
  });

  it('lets a change leave the variant with no picture', () => {
    expect(planVariantImages([], GALLERY, { required: false })).toEqual([]);
    expect(planVariantImages(undefined, GALLERY, { required: false })).toEqual([]);
  });

  it('refuses more pictures than a variant may show', () => {
    const many = Array.from({ length: MAX_VARIANT_IMAGES + 1 }, (_, index) => ({
      imageId: index + 1,
      position: index + 1,
    }));

    expect(failure(() => planVariantImages(many, GALLERY, { required: true }))).toEqual({
      errorCode: 'VARIANT_IMAGES_TOO_MANY',
      details: { max: MAX_VARIANT_IMAGES },
    });
  });

  it('refuses a picture twice and a place twice', () => {
    expect(
      codeOf(() =>
        planVariantImages(
          [
            { file: 1, position: 1 },
            { file: 1, position: 2 },
          ],
          FILES,
          { required: true },
        ),
      ),
    ).toBe('VARIANT_IMAGES_REPEATED');
    expect(
      codeOf(() =>
        planVariantImages(
          [
            { file: 0, position: 1 },
            { file: 1, position: 1 },
          ],
          FILES,
          { required: true },
        ),
      ),
    ).toBe('VARIANT_IMAGE_POSITION_INVALID');
  });

  it.each([
    ['a place of 0', { file: 0, position: 0 }],
    ['a negative place', { file: 0, position: -1 }],
    ['a fraction', { file: 0, position: 1.5 }],
    ['a place that is a word', { file: 0, position: 'first' }],
    ['no place', { file: 0 }],
  ])('refuses %s', (_case, item) => {
    expect(codeOf(() => planVariantImages([item], FILES, { required: true }))).toBe(
      'VARIANT_IMAGE_POSITION_INVALID',
    );
  });

  it.each([
    ['a file the form does not have', FILES, { file: 3, position: 1 }],
    ['a negative file', FILES, { file: -1, position: 1 }],
    ['a file that is a word', FILES, { file: 'a', position: 1 }],
    ['an id of 0', GALLERY, { imageId: 0, position: 1 }],
    ['an item that is no object', GALLERY, 7],
  ])('refuses %s as a picture that is not there', (_case, source, item) => {
    expect(codeOf(() => planVariantImages([item], source, { required: true }))).toBe(
      'VARIANT_IMAGE_NOT_FOUND',
    );
  });

  // a value that is no list is not about a place: VARIANT_IMAGES_INVALID
  it.each([
    ['a text', 'x'],
    ['a number', 5],
    ['an object', { imageId: 1, position: 1 }],
  ])('refuses pictures that are %s as VARIANT_IMAGES_INVALID', (_case, raw) => {
    for (const required of [true, false]) {
      expect(codeOf(() => planVariantImages(raw, GALLERY, { required }))).toBe(
        'VARIANT_IMAGES_INVALID',
      );
    }
  });

  // null is no way to say "none": a new variant lacks its picture, a change is not told to clear them
  it('takes null as no picture for a new variant, and refuses it in a change', () => {
    expect(codeOf(() => planVariantImages(null, GALLERY, { required: true }))).toBe(
      'VARIANT_IMAGE_REQUIRED',
    );
    expect(codeOf(() => planVariantImages(null, GALLERY, { required: false }))).toBe(
      'VARIANT_IMAGES_INVALID',
    );
  });

  it('takes an empty list as none in a change, and as a lack in a new variant', () => {
    expect(planVariantImages([], GALLERY, { required: false })).toEqual([]);
    expect(codeOf(() => planVariantImages([], GALLERY, { required: true }))).toBe(
      'VARIANT_IMAGE_REQUIRED',
    );
  });
});

describe('planNewVariant', () => {
  it('reads the price, the codes, the weight and the sizes, and the pictures', () => {
    expect(planNewVariant({ ...valid, sku: '  WH-1 ', barcode: ` ${EAN13} ` }, FILES)).toEqual({
      price: 12.5,
      sku: 'WH-1',
      barcode: EAN13,
      shipping: { weightGrams: 300, lengthMm: 200, widthMm: 100, heightMm: 50 },
      images: [{ key: 0, position: 1 }],
      attributes: [],
    });
  });

  it('reads the values of the characteristics a variant names', () => {
    const attributes = [
      { attributeId: 4, value: 'black' },
      { attributeId: 9, value: 12.5 },
      { attributeId: 12, value: null },
    ];

    expect(planNewVariant({ ...valid, attributes }, FILES).attributes).toEqual(attributes);
  });

  it('takes a variant without codes as one with none', () => {
    expect(planNewVariant({ ...valid, sku: '', barcode: null }, FILES)).toMatchObject({
      sku: null,
      barcode: null,
    });
  });

  it('takes a free variant and a price given as a word of digits', () => {
    expect(planNewVariant({ ...valid, price: 0 }, FILES).price).toBe(0);
    expect(planNewVariant({ ...valid, price: '4.99' }, FILES).price).toBe(4.99);
  });

  it('lets the weight and the sizes come later when it says so', () => {
    const { weightGrams, lengthMm, widthMm, heightMm, ...bare } = valid;
    void [weightGrams, lengthMm, widthMm, heightMm];

    expect(planNewVariant({ ...bare, withoutShippingData: true }, FILES).shipping).toEqual({
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
  });

  it.each([
    ['no price', { price: undefined }, 'PRODUCT_PRICE_INVALID'],
    ['a negative price', { price: -1 }, 'PRODUCT_PRICE_INVALID'],
    ['a price of a word', { price: 'free' }, 'PRODUCT_PRICE_INVALID'],
    ['a blank price', { price: '  ' }, 'PRODUCT_PRICE_INVALID'],
    ['a part of a cent', { price: 10.004 }, 'PRODUCT_PRICE_INVALID'],
    ['an article number over 64 signs', { sku: 'x'.repeat(65) }, 'PRODUCT_SKU_TOO_LONG'],
    ['a barcode with a wrong check digit', { barcode: '4006381333930' }, 'VARIANT_BARCODE_INVALID'],
    ['no weight', { weightGrams: undefined }, 'PRODUCT_SHIPPING_DATA_REQUIRED'],
    ['one size', { lengthMm: undefined, widthMm: undefined }, 'PRODUCT_SIZES_INCOMPLETE'],
    ['a weight of 0', { weightGrams: 0 }, 'PRODUCT_WEIGHT_INVALID'],
    ['a size of 0', { lengthMm: 0 }, 'PRODUCT_SIZES_INVALID'],
    [
      'a flag that is a word',
      { withoutShippingData: 'maybe' },
      'PRODUCT_WITHOUT_SHIPPING_DATA_INVALID',
    ],
    ['a stock', { stock: 5 }, 'PRODUCT_STOCK_NOT_ALLOWED'],
    ['no picture', { images: undefined }, 'VARIANT_IMAGE_REQUIRED'],
    ['null for the pictures', { images: null }, 'VARIANT_IMAGE_REQUIRED'],
    ['pictures that are a text', { images: 'front' }, 'VARIANT_IMAGES_INVALID'],
    ['pictures that are a number', { images: 3 }, 'VARIANT_IMAGES_INVALID'],
    ['pictures that are an object', { images: { file: 0, position: 1 } }, 'VARIANT_IMAGES_INVALID'],
  ])('refuses %s', (_case, patch, code) => {
    expect(codeOf(() => planNewVariant({ ...valid, ...patch }, FILES))).toBe(code);
  });

  it('names the fields a variant lacks when the weight and the sizes are required', () => {
    const { weightGrams, lengthMm, widthMm, heightMm, ...bare } = valid;
    void [weightGrams, lengthMm, widthMm, heightMm];

    expect(failure(() => planNewVariant(bare, FILES))).toEqual({
      errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
      details: { fields: ['weightGrams', 'sizesMm'] },
    });
  });

  it.each([[null], ['text'], [7], [[]]])('refuses an element that is no object: %p', (raw) => {
    expect(codeOf(() => planNewVariant(raw, FILES))).toBe('VARIANT_INVALID');
  });
});

describe('planNewVariants', () => {
  it('plans every variant of the list, in order', () => {
    const plans = planNewVariants(
      [valid, { ...valid, price: 20, images: [{ file: 1, position: 1 }] }],
      FILES,
    );

    expect(plans.map((plan) => plan.price)).toEqual([12.5, 20]);
  });

  it.each([[undefined], [null], [[]], ['x'], [{}]])('wants a list with a variant: %p', (raw) => {
    expect(codeOf(() => planNewVariants(raw, FILES))).toBe('VARIANTS_REQUIRED');
  });

  it('names every variant that is wrong with its own error, and goes on past the first', () => {
    const { details, errorCode } = failure(() =>
      planNewVariants(
        [
          valid,
          { ...valid, price: -1 },
          { ...valid, barcode: '123' },
          { ...valid, images: [] },
          'nothing',
        ],
        FILES,
      ),
    );

    expect(errorCode).toBe('VARIANTS_INVALID');
    expect(details).toEqual({
      variants: [
        { index: 1, errorCode: 'PRODUCT_PRICE_INVALID' },
        { index: 2, errorCode: 'VARIANT_BARCODE_INVALID' },
        { index: 3, errorCode: 'VARIANT_IMAGE_REQUIRED' },
        { index: 4, errorCode: 'VARIANT_INVALID' },
      ],
    });
  });

  it('keeps the details of an error of a variant', () => {
    const { bare } = { bare: { price: 1, images: [{ file: 0, position: 1 }] } };

    expect(failure(() => planNewVariants([bare], FILES)).details).toEqual({
      variants: [
        {
          index: 0,
          errorCode: 'PRODUCT_SHIPPING_DATA_REQUIRED',
          details: { fields: ['weightGrams', 'sizesMm'] },
        },
      ],
    });
  });

  it('refuses more variants than the product may have, and counts the ones it has', () => {
    const many = Array.from({ length: MAX_PRODUCT_VARIANTS + 1 }, () => valid);

    expect(failure(() => planNewVariants(many, FILES))).toEqual({
      errorCode: 'PRODUCT_VARIANTS_TOO_MANY',
      details: { max: MAX_PRODUCT_VARIANTS },
    });
    expect(
      failure(() => planNewVariants([valid, valid], FILES, { have: MAX_PRODUCT_VARIANTS - 1 })),
    ).toEqual({
      errorCode: 'PRODUCT_VARIANTS_TOO_MANY',
      details: { max: MAX_PRODUCT_VARIANTS, have: MAX_PRODUCT_VARIANTS - 1 },
    });
    expect(planNewVariants([valid], FILES, { have: MAX_PRODUCT_VARIANTS - 1 })).toHaveLength(1);
  });

  it('refuses more variants in a request than the request may bring', () => {
    expect(codeOf(() => planNewVariants([valid, valid, valid], FILES, { perRequest: 2 }))).toBe(
      'PRODUCT_VARIANTS_TOO_MANY',
    );
  });
});

describe('repeatedCodes', () => {
  it('names the later variants that repeat a code of an earlier one', () => {
    expect(
      repeatedCodes([
        { sku: 'A-1', barcode: EAN13 },
        { sku: 'a-1', barcode: null },
        { sku: null, barcode: EAN13 },
        { sku: 'B', barcode: null },
        { sku: 'A-1', barcode: null },
      ]),
    ).toEqual({ skus: [1, 4], barcodes: [2] });
  });

  it('finds nothing in codes that differ or are empty', () => {
    expect(
      repeatedCodes([
        { sku: null, barcode: null },
        { sku: null, barcode: null },
        { sku: 'x', barcode: null },
      ]),
    ).toEqual({ skus: [], barcodes: [] });
  });
});

describe('parseVariantsText', () => {
  it('parses a JSON text', () => {
    expect(parseVariantsText('[{"price":1}]')).toEqual([{ price: 1 }]);
  });

  it.each([[undefined], [''], ['   '], ['not json'], [7]])('wants a JSON text: %p', (text) => {
    expect(codeOf(() => parseVariantsText(text))).toBe('VARIANTS_REQUIRED');
  });
});

describe('planVariantUpdate', () => {
  it('reads each field sent and leaves the others undefined', () => {
    expect(
      planVariantUpdate({
        sku: ' AB ',
        barcode: EAN13,
        weightGrams: 400,
        position: 2,
        images: [{ imageId: 3, position: 1 }],
      }),
    ).toEqual({
      sku: 'AB',
      barcode: EAN13,
      shippingChanges: { weightGrams: 400 },
      withoutShippingData: false,
      position: 2,
      images: [{ key: 3, position: 1 }],
    });
  });

  it('takes null as a way to clear a code, and an empty list of pictures', () => {
    expect(planVariantUpdate({ sku: null, barcode: '', images: [] })).toMatchObject({
      sku: null,
      barcode: null,
      images: [],
    });
  });

  it('refuses a change that changes nothing', () => {
    expect(codeOf(() => planVariantUpdate({}))).toBe('NO_FIELDS_TO_UPDATE');
  });

  // an empty list takes the pictures away; null, a text, a number, an object are no list at all,
  // and null is no way to say none
  it.each([
    ['null', null],
    ['a text', 'first'],
    ['a number', 5],
    ['an object', { imageId: 1, position: 1 }],
  ])('refuses pictures that are %s as VARIANT_IMAGES_INVALID', (_case, images) => {
    expect(codeOf(() => planVariantUpdate({ images }))).toBe('VARIANT_IMAGES_INVALID');
  });

  it.each([
    ['a stock', { stock: 1 }, 'PRODUCT_STOCK_NOT_ALLOWED'],
    ['a place of 0', { position: 0 }, 'VARIANT_POSITION_INVALID'],
    ['a place that is a fraction', { position: 1.5 }, 'VARIANT_POSITION_INVALID'],
    ['a barcode that is wrong', { barcode: '12' }, 'VARIANT_BARCODE_INVALID'],
    ['an article number over 64 signs', { sku: 'x'.repeat(65) }, 'PRODUCT_SKU_TOO_LONG'],
    ['a weight of 0', { weightGrams: 0 }, 'PRODUCT_WEIGHT_INVALID'],
    [
      'a picture twice',
      {
        images: [
          { imageId: 1, position: 1 },
          { imageId: 1, position: 2 },
        ],
      },
      'VARIANT_IMAGES_REPEATED',
    ],
  ])('refuses %s', (_case, fields, code) => {
    expect(codeOf(() => planVariantUpdate(fields))).toBe(code);
  });
});

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

describe('readVariantPrice', () => {
  it('reads a price of whole cents, a number or the text of one', () => {
    expect(readVariantPrice(12.5)).toBe(12.5);
    expect(readVariantPrice('12.50')).toBe(12.5);
    expect(readVariantPrice(0)).toBe(0);
    expect(readVariantPrice(99_999_999.99)).toBe(99_999_999.99);
  });

  it('leaves a price that is not sent as it is', () => {
    expect(readVariantPrice(undefined)).toBeUndefined();
  });

  it.each([
    ['a part of a cent', 10.004],
    ['a price below 0', -1],
    ['a price over what the column holds', 100_000_000],
    ['a word', 'cheap'],
    ['an empty text', ''],
    ['null', null],
  ])('refuses %s', (_case, price) => {
    expect(codeOf(() => readVariantPrice(price))).toBe('PRODUCT_PRICE_INVALID');
  });
});

describe('readVariantSale', () => {
  it.each(['keep', 'remove'] as const)('reads the word %s that goes with a price', (word) => {
    expect(readVariantSale(word, 10)).toEqual({ word });
  });

  it('reads a new sale with its end as a date', () => {
    const endsAt = inAnHour();

    expect(readVariantSale({ percent: 10, endsAt }, 10)).toEqual({
      word: 'new',
      sale: { percent: 10, endsAt },
      endsAt: new Date(endsAt),
    });
  });

  it('leaves a sale that is not sent as it is', () => {
    expect(readVariantSale(undefined, 10)).toBeUndefined();
    expect(readVariantSale(undefined, undefined)).toBeUndefined();
  });

  // the sale alone has a route of its own
  it.each(['keep', 'remove', { amount: 1, endsAt: inAnHour() }])(
    'refuses a word on the sale without a price: %p',
    (word) => {
      expect(codeOf(() => readVariantSale(word, undefined))).toBe('PRODUCT_SALE_REQUIRES_PRICE');
    },
  );

  it.each([
    ['in the past', new Date(Date.now() - 60_000).toISOString()],
    ['no date', 'next week'],
  ])('refuses a new sale with an end that is %s', (_case, endsAt) => {
    expect(codeOf(() => readVariantSale({ percent: 10, endsAt }, 10))).toBe(
      'PRODUCT_SALE_ENDS_AT_INVALID',
    );
  });
});

describe('planVariantsChange', () => {
  it('reads the price, the word on the sale, the weight and the sizes', () => {
    const endsAt = inAnHour();

    expect(
      planVariantsChange({
        price: '19.99',
        sale: { amount: 2, endsAt },
        weightGrams: 400,
        lengthMm: 10,
        widthMm: 20,
        heightMm: 30,
      }),
    ).toEqual({
      price: 19.99,
      sale: { word: 'new', sale: { amount: 2, endsAt }, endsAt: new Date(endsAt) },
      shippingChanges: { weightGrams: 400, lengthMm: 10, widthMm: 20, heightMm: 30 },
      withoutShippingData: false,
    });
  });

  it('reads a change of the weight alone, and the flag that the data come later', () => {
    expect(planVariantsChange({ weightGrams: null, withoutShippingData: true })).toEqual({
      price: undefined,
      sale: undefined,
      shippingChanges: { weightGrams: null },
      withoutShippingData: true,
    });
  });

  it.each([
    ['nothing', {}, 'NO_FIELDS_TO_UPDATE'],
    ['the flag alone', { withoutShippingData: true }, 'NO_FIELDS_TO_UPDATE'],
    ['a stock', { price: 1, stock: 1 }, 'PRODUCT_STOCK_NOT_ALLOWED'],
    ['a word on the sale without a price', { sale: 'keep' }, 'PRODUCT_SALE_REQUIRES_PRICE'],
    ['a price past the cent', { price: 1.001 }, 'PRODUCT_PRICE_INVALID'],
    ['a weight of 0', { weightGrams: 0 }, 'PRODUCT_WEIGHT_INVALID'],
    ['a size of 0', { lengthMm: 0 }, 'PRODUCT_SIZES_INVALID'],
  ])('refuses %s', (_case, fields, code) => {
    expect(codeOf(() => planVariantsChange(fields))).toBe(code);
  });

  // the article number, the barcode and the place belong to one variant
  it('does not read the fields of one variant alone', () => {
    expect(
      codeOf(() => planVariantsChange({ sku: 'X', barcode: EAN13, position: 2 } as never)),
    ).toBe('NO_FIELDS_TO_UPDATE');
    expect(planVariantsChange({ price: 5, sku: 'X', position: 2 } as never)).not.toHaveProperty(
      'sku',
    );
  });

  // the same list of pictures for every variant, written whole
  describe('the pictures', () => {
    it('reads the list: the pictures of the gallery with the places they get', () => {
      expect(
        planVariantsChange({
          images: [
            { imageId: 5, position: 2 },
            { imageId: 7, position: 1 },
          ],
        }).images,
      ).toEqual([
        { key: 5, position: 2 },
        { key: 7, position: 1 },
      ]);
    });

    it('counts a list of pictures as a change on its own, an empty one too', () => {
      expect(planVariantsChange({ images: [{ imageId: 5, position: 1 }] }).price).toBeUndefined();
      expect(planVariantsChange({ images: [] }).images).toEqual([]);
    });

    it('reads the pictures together with the other fields', () => {
      expect(planVariantsChange({ price: 9, images: [{ imageId: 5, position: 1 }] })).toMatchObject(
        { price: 9, images: [{ key: 5, position: 1 }] },
      );
    });

    it('leaves the pictures alone when the request does not name them', () => {
      expect(planVariantsChange({ price: 9 }).images).toBeUndefined();
    });

    it.each([
      ['null (no way to take them away)', null, 'VARIANT_IMAGES_INVALID'],
      ['a text', 'first', 'VARIANT_IMAGES_INVALID'],
      [
        'a picture twice',
        [
          { imageId: 5, position: 1 },
          { imageId: 5, position: 2 },
        ],
        'VARIANT_IMAGES_REPEATED',
      ],
      [
        'a place twice',
        [
          { imageId: 5, position: 1 },
          { imageId: 6, position: 1 },
        ],
        'VARIANT_IMAGE_POSITION_INVALID',
      ],
      ['a place of 0', [{ imageId: 5, position: 0 }], 'VARIANT_IMAGE_POSITION_INVALID'],
      ['an id that is no id', [{ imageId: 0, position: 1 }], 'VARIANT_IMAGE_NOT_FOUND'],
    ])('refuses pictures that are %s', (_case, images, code) => {
      expect(codeOf(() => planVariantsChange({ price: 9, images }))).toBe(code);
    });

    it('refuses more pictures than a variant shows', () => {
      const images = Array.from({ length: MAX_VARIANT_IMAGES + 1 }, (_, i) => ({
        imageId: i + 1,
        position: i + 1,
      }));

      expect(failure(() => planVariantsChange({ images }))).toEqual({
        errorCode: 'VARIANT_IMAGES_TOO_MANY',
        details: { max: MAX_VARIANT_IMAGES },
      });
    });
  });
});

describe('planVariantUpdate with a price', () => {
  it('reads the price and the word on the sale beside the other fields', () => {
    expect(planVariantUpdate({ price: 9, sale: 'remove', sku: 'A' })).toMatchObject({
      price: 9,
      sale: { word: 'remove' },
      sku: 'A',
    });
  });

  it('is a change by the price alone', () => {
    expect(planVariantUpdate({ price: 9 })).toMatchObject({ price: 9, sku: undefined });
  });

  it('refuses a word on the sale without a price, even beside other fields', () => {
    expect(codeOf(() => planVariantUpdate({ sale: 'keep', sku: 'A' }))).toBe(
      'PRODUCT_SALE_REQUIRES_PRICE',
    );
  });

  it('refuses a price past the cent', () => {
    expect(codeOf(() => planVariantUpdate({ price: 10.004 }))).toBe('PRODUCT_PRICE_INVALID');
  });
});
