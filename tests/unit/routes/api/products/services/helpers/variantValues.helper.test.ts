import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { MAX_ATTRIBUTE_MULTI_VALUES } from '@config/limits.js';
import {
  cardAttributesOf,
  numberLabel,
} from '@routes/api/products/services/helpers/variantCardAttributes.helper.js';
import {
  VARIANT_ATTRIBUTES_PER_REQUEST_MAX,
  planValueInputs,
  rawOf,
  resolveNewVariants,
  resolveValue,
  resolveValues,
  withVariant,
  type AttributeInfo,
  type ValueContext,
} from '@routes/api/products/services/helpers/variantValues.helper.js';
import { AppError, BadRequestError } from '@utils/errors.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

// the values of the characteristics of a variant, as far as the request and the directory tell:
// the shape of the list, a value against the type of its characteristic, and the card made of the
// rows. The database is not asked

const info = (patch: Partial<AttributeInfo> & { id: number }): AttributeInfo => ({
  name: `Characteristic ${patch.id}`,
  type: 'text',
  decimals: null,
  minValue: null,
  maxValue: null,
  ...patch,
});

// a text (1), a number of 1 digit after the point between 1 and 100 (2), yes/no (3), a choice (4)
// with the values 40 and 41, a set (5) with the values 50, 51 and 52; the value 90 is one of the
// characteristic 99
const ctx: ValueContext = {
  attributes: new Map([
    [1, info({ id: 1, type: 'text' })],
    [
      2,
      info({
        id: 2,
        type: 'number',
        decimals: 1,
        minValue: new Prisma.Decimal(1),
        maxValue: new Prisma.Decimal(100),
      }),
    ],
    [3, info({ id: 3, type: 'boolean' })],
    [4, info({ id: 4, type: 'option' })],
    [5, info({ id: 5, type: 'options' })],
    [6, info({ id: 6, type: 'number', decimals: 0 })],
  ]),
  optionOwner: new Map([
    [40, 4],
    [41, 4],
    [50, 5],
    [51, 5],
    [52, 5],
    [90, 99],
  ]),
};

const resolve = (attributeId: number, value: unknown, allowRemove = true) =>
  resolveValue(ctx, { attributeId, value }, { allowRemove });

const failure = (fn: () => unknown) => {
  const err = thrownBy(fn);

  expect(err).toBeInstanceOf(BadRequestError);
  const { errorCode, details } = err as BadRequestError;
  return { errorCode, details: details as Record<string, unknown> };
};

describe('planValueInputs', () => {
  it('is nothing when the request names none', () => {
    expect(planValueInputs(undefined)).toBeUndefined();
  });

  it('reads the characteristics with their values, a null among them', () => {
    expect(
      planValueInputs([
        { attributeId: 1, value: 'black' },
        { attributeId: 2, value: null },
        { attributeId: 3, value: false },
        { attributeId: 5, value: [50, 51] },
      ]),
    ).toEqual([
      { attributeId: 1, value: 'black' },
      { attributeId: 2, value: null },
      { attributeId: 3, value: false },
      { attributeId: 5, value: [50, 51] },
    ]);
  });

  it('takes an empty list', () => {
    expect(planValueInputs([])).toEqual([]);
  });

  it.each([
    ['no list', 'black'],
    ['an object', { attributeId: 1, value: 'black' }],
    ['an element that is no object', [3]],
    ['an element with no id', [{ value: 'black' }]],
    ['an element with no value', [{ attributeId: 1 }]],
    ['an id that is no whole number', [{ attributeId: 1.5, value: 'x' }]],
    ['an id that is a word', [{ attributeId: '1', value: 'x' }]],
    ['an id of 0', [{ attributeId: 0, value: 'x' }]],
    [
      'too many',
      Array.from({ length: VARIANT_ATTRIBUTES_PER_REQUEST_MAX + 1 }, (_, i) => ({
        attributeId: i + 1,
        value: 'x',
      })),
    ],
  ])('refuses %s with VARIANT_ATTRIBUTES_INVALID', (_name, raw) => {
    expect(failure(() => planValueInputs(raw)).errorCode).toBe('VARIANT_ATTRIBUTES_INVALID');
  });

  it('refuses a characteristic named twice and names it', () => {
    expect(
      failure(() =>
        planValueInputs([
          { attributeId: 7, value: 'a' },
          { attributeId: 8, value: 'a' },
          { attributeId: 7, value: 'b' },
          { attributeId: 8, value: 'b' },
        ]),
      ),
    ).toEqual({ errorCode: 'VARIANT_ATTRIBUTES_REPEATED', details: { attributeIds: [7, 8] } });
  });
});

describe('resolveValue: a text', () => {
  it('is trimmed', () => {
    expect(resolve(1, '  Matte finish ')).toEqual({
      attributeId: 1,
      value: { type: 'text', text: 'Matte finish' },
    });
  });

  it('takes 500 signs as a person counts them', () => {
    expect(resolve(1, 'x'.repeat(500))).toBeDefined();
    expect(resolve(1, '\u{1F600}'.repeat(500))).toBeDefined();
  });

  it.each([
    ['a number', 5],
    ['yes', true],
    ['a list', ['a']],
    ['an object', { a: 1 }],
    ['nothing but blanks', '   \t '],
    ['an empty text', ''],
    ['a text with NUL', 'a\u0000b'],
    ['501 signs', 'x'.repeat(501)],
  ])('refuses %s with ATTRIBUTE_VALUE_INVALID', (_name, value) => {
    expect(failure(() => resolve(1, value))).toMatchObject({
      errorCode: 'ATTRIBUTE_VALUE_INVALID',
      details: { attributeId: 1, type: 'text' },
    });
  });
});

describe('resolveValue: a number', () => {
  it('takes a number within the digits after the point and the bounds, bounds included', () => {
    for (const value of [1, 100, 12.5, 99.9]) {
      expect(resolve(2, value)).toMatchObject({ value: { type: 'number' } });
    }
    expect(rawOf(resolve(2, 12.5)!.value)).toBe(12.5);
  });

  it('refuses more digits after the point than the characteristic has, with the digits it has', () => {
    expect(failure(() => resolve(2, 12.55))).toMatchObject({
      errorCode: 'ATTRIBUTE_VALUE_TOO_PRECISE',
      details: { attributeId: 2, bound: 1, value: 12.55 },
    });
    expect(failure(() => resolve(6, 0.5)).errorCode).toBe('ATTRIBUTE_VALUE_TOO_PRECISE');
    // the float that 0.1 + 0.2 makes is not a number of 3 digits
    expect(failure(() => resolve(6, 0.1 + 0.2)).errorCode).toBe('ATTRIBUTE_VALUE_TOO_PRECISE');
  });

  it('refuses a number below the least and above the greatest, with the bound', () => {
    expect(failure(() => resolve(2, 0.9))).toMatchObject({
      errorCode: 'ATTRIBUTE_VALUE_TOO_SMALL',
      details: { attributeId: 2, bound: 1, value: 0.9 },
    });
    expect(failure(() => resolve(2, 100.1))).toMatchObject({
      errorCode: 'ATTRIBUTE_VALUE_TOO_LARGE',
      details: { attributeId: 2, bound: 100, value: 100.1 },
    });
  });

  it('keeps a number with no bounds within what the column holds (15 digits before the point)', () => {
    expect(resolve(6, 999_999_999_999_999)).toBeDefined();
    expect(resolve(6, -999_999_999_999_999)).toBeDefined();
    expect(failure(() => resolve(6, 1e15)).errorCode).toBe('ATTRIBUTE_VALUE_TOO_LARGE');
    expect(failure(() => resolve(6, -1e15)).errorCode).toBe('ATTRIBUTE_VALUE_TOO_SMALL');
  });

  it.each([
    ['a word of digits', '12'],
    ['yes', true],
    ['not a number', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['a list', [1]],
  ])('refuses %s with ATTRIBUTE_VALUE_INVALID', (_name, value) => {
    expect(failure(() => resolve(2, value)).errorCode).toBe('ATTRIBUTE_VALUE_INVALID');
  });
});

describe('resolveValue: yes or no', () => {
  it('takes true and false', () => {
    expect(resolve(3, true)!.value).toEqual({ type: 'boolean', bool: true });
    expect(resolve(3, false)!.value).toEqual({ type: 'boolean', bool: false });
  });

  it.each([
    ['a word', 'yes'],
    ['a number', 1],
    ['a list', [true]],
  ])('refuses %s with ATTRIBUTE_VALUE_INVALID', (_name, value) => {
    expect(failure(() => resolve(3, value)).errorCode).toBe('ATTRIBUTE_VALUE_INVALID');
  });
});

describe('resolveValue: a choice of one value', () => {
  it('takes the id of a value of the characteristic', () => {
    expect(resolve(4, 41)!.value).toEqual({ type: 'option', optionIds: [41] });
  });

  it('refuses a value of another characteristic and a value that is not there, with the id', () => {
    for (const id of [90, 12345]) {
      expect(failure(() => resolve(4, id))).toMatchObject({
        errorCode: 'ATTRIBUTE_OPTION_NOT_FOUND',
        details: { attributeId: 4, optionIds: [id] },
      });
    }
  });

  it.each([
    ['a word', 'black'],
    ['a list', [40]],
    ['yes', true],
    ['a fraction', 40.5],
  ])('refuses %s with ATTRIBUTE_VALUE_INVALID', (_name, value) => {
    expect(failure(() => resolve(4, value)).errorCode).toBe('ATTRIBUTE_VALUE_INVALID');
  });
});

describe('resolveValue: several values of a list', () => {
  it('takes ids of values of the characteristic, in the order of their ids', () => {
    expect(resolve(5, [52, 50])!.value).toEqual({ type: 'options', optionIds: [50, 52] });
  });

  it('refuses a value twice and names it', () => {
    expect(failure(() => resolve(5, [50, 51, 50]))).toMatchObject({
      errorCode: 'ATTRIBUTE_VALUES_REPEATED',
      details: { attributeId: 5, optionIds: [50] },
    });
  });

  it('refuses more values than the limit, with the limit and the number', () => {
    const many = Array.from({ length: MAX_ATTRIBUTE_MULTI_VALUES + 1 }, (_, i) => 1000 + i);

    expect(failure(() => resolve(5, many))).toMatchObject({
      errorCode: 'ATTRIBUTE_VALUES_TOO_MANY',
      details: { attributeId: 5, max: MAX_ATTRIBUTE_MULTI_VALUES, have: many.length },
    });
  });

  it('refuses values of another characteristic and names all of them', () => {
    expect(failure(() => resolve(5, [50, 90, 12345]))).toMatchObject({
      errorCode: 'ATTRIBUTE_OPTION_NOT_FOUND',
      details: { attributeId: 5, optionIds: [90, 12345] },
    });
  });

  it.each([
    ['one id', 50],
    ['a text', 'GPS'],
    ['ids that are words', ['50']],
    ['a mix', [50, 'a']],
  ])('refuses %s with ATTRIBUTE_VALUE_INVALID', (_name, value) => {
    expect(failure(() => resolve(5, value)).errorCode).toBe('ATTRIBUTE_VALUE_INVALID');
  });
});

describe('resolveValue: no value', () => {
  it('takes the value away in a change, for any type, an empty set too', () => {
    for (const id of [1, 2, 3, 4, 5]) {
      expect(resolve(id, null)).toEqual({ attributeId: id, value: null });
    }
    expect(resolve(5, [])).toEqual({ attributeId: 5, value: null });
  });

  it('is no value in a new variant: the characteristic is left alone', () => {
    for (const id of [1, 2, 3, 4, 5]) expect(resolve(id, null, false)).toBeUndefined();
    expect(resolve(5, [], false)).toBeUndefined();
  });
});

describe('resolveValues and resolveNewVariants', () => {
  it('leave out what is no value and keep the order of the request', () => {
    expect(
      resolveValues(
        ctx,
        [
          { attributeId: 3, value: true },
          { attributeId: 1, value: null },
          { attributeId: 4, value: 40 },
        ],
        { allowRemove: false },
      ).map((item) => item.attributeId),
    ).toEqual([3, 4]);
  });

  it('name every new variant whose values are wrong, by its place, with its own error', () => {
    const err = thrownBy(() =>
      resolveNewVariants(ctx, [
        { attributes: [{ attributeId: 1, value: 'ok' }] },
        { attributes: [{ attributeId: 2, value: 500 }] },
        { attributes: [{ attributeId: 3, value: 'yes' }] },
      ]),
    ) as AppError;

    expect(err.errorCode).toBe('VARIANTS_INVALID');
    expect(err.statusCode).toBe(400);
    expect(err.details).toEqual({
      variants: [
        {
          index: 1,
          errorCode: 'ATTRIBUTE_VALUE_TOO_LARGE',
          details: { attributeId: 2, attributeName: 'Characteristic 2', bound: 100, value: 500 },
        },
        {
          index: 2,
          errorCode: 'ATTRIBUTE_VALUE_INVALID',
          details: { attributeId: 3, attributeName: 'Characteristic 3', type: 'boolean' },
        },
      ],
    });
  });

  it('give the values of every right variant', () => {
    const all = resolveNewVariants(ctx, [
      { attributes: [{ attributeId: 1, value: 'a' }] },
      { attributes: [] },
    ]);

    expect(all.map((list) => list.length)).toEqual([1, 0]);
  });

  it('put the variant into the details of a problem with withVariant', () => {
    const err = withVariant(new BadRequestError('ATTRIBUTE_VALUE_INVALID', { attributeId: 3 }), {
      variantId: 77,
    });

    expect(err).toMatchObject({
      statusCode: 400,
      errorCode: 'ATTRIBUTE_VALUE_INVALID',
      details: { variantId: 77, attributeId: 3 },
    });
  });
});

describe('rawOf', () => {
  it('writes a value as the admin log and a form keep it', () => {
    expect(rawOf({ type: 'text', text: 'a' })).toBe('a');
    expect(rawOf({ type: 'number', number: new Prisma.Decimal('1.500') })).toBe(1.5);
    expect(rawOf({ type: 'boolean', bool: false })).toBe(false);
    expect(rawOf({ type: 'option', optionIds: [4] })).toBe(4);
    expect(rawOf({ type: 'options', optionIds: [4, 5] })).toEqual([4, 5]);
    expect(rawOf(null)).toBeNull();
  });
});

describe('numberLabel', () => {
  it('has no trailing zeros and takes the unit after a space', () => {
    expect(numberLabel('256.000', 'GB')).toBe('256 GB');
    expect(numberLabel(new Prisma.Decimal('1.500'), null)).toBe('1.5');
    expect(numberLabel(0.25, 'kg')).toBe('0.25 kg');
    expect(numberLabel('-3.000', null)).toBe('-3');
    expect(numberLabel('100.000', null)).toBe('100');
  });
});

describe('cardAttributesOf', () => {
  const base = {
    unit: null,
    isMain: false,
    groupId: 1,
    groupName: 'General',
    groupPosition: 1,
    textValue: null,
    numberValue: null,
    boolValue: null,
    optionId: null,
    optionName: null,
    colorCode: null,
  };

  it('folds the rows into the groups of each variant, a set into one item', () => {
    const card = cardAttributesOf([
      {
        ...base,
        variantId: 10,
        attributeId: 1,
        name: 'Colour',
        type: 'option',
        isMain: true,
        optionId: 40,
        optionName: 'black',
        colorCode: '#000000',
      },
      {
        ...base,
        variantId: 10,
        attributeId: 2,
        name: 'Memory',
        unit: 'GB',
        type: 'number',
        numberValue: '256.000',
      },
      {
        ...base,
        variantId: 10,
        attributeId: 3,
        name: 'Features',
        type: 'options',
        groupId: 2,
        groupName: 'Extras',
        groupPosition: 2,
        optionId: 50,
        optionName: 'NFC',
      },
      {
        ...base,
        variantId: 10,
        attributeId: 3,
        name: 'Features',
        type: 'options',
        groupId: 2,
        groupName: 'Extras',
        groupPosition: 2,
        optionId: 51,
        optionName: 'GPS',
      },
      {
        ...base,
        variantId: 10,
        attributeId: 4,
        name: 'Waterproof',
        type: 'boolean',
        groupId: 2,
        groupName: 'Extras',
        groupPosition: 2,
        boolValue: true,
      },
      {
        ...base,
        variantId: 11,
        attributeId: 5,
        name: 'Finish',
        type: 'text',
        textValue: 'Matte',
      },
    ]);

    expect(card.get(10)).toEqual([
      {
        group: { id: 1, name: 'General', position: 1 },
        items: [
          {
            attribute: { id: 1, name: 'Colour', unit: null, type: 'option', isMain: true },
            value: 'black',
            raw: 40,
            colorCode: '#000000',
          },
          {
            attribute: { id: 2, name: 'Memory', unit: 'GB', type: 'number', isMain: false },
            value: '256 GB',
            raw: 256,
          },
        ],
      },
      {
        group: { id: 2, name: 'Extras', position: 2 },
        items: [
          {
            attribute: { id: 3, name: 'Features', unit: null, type: 'options', isMain: false },
            value: 'NFC, GPS',
            raw: [50, 51],
          },
          {
            attribute: { id: 4, name: 'Waterproof', unit: null, type: 'boolean', isMain: false },
            value: 'yes',
            raw: true,
          },
        ],
      },
    ]);
    expect(card.get(11)).toEqual([
      {
        group: { id: 1, name: 'General', position: 1 },
        items: [
          {
            attribute: { id: 5, name: 'Finish', unit: null, type: 'text', isMain: false },
            value: 'Matte',
            raw: 'Matte',
          },
        ],
      },
    ]);
    expect(card.has(12)).toBe(false);
  });

  it('writes no for false and leaves a colour out when the value has none', () => {
    const card = cardAttributesOf([
      { ...base, variantId: 1, attributeId: 1, name: 'Flag', type: 'boolean', boolValue: false },
      {
        ...base,
        variantId: 1,
        attributeId: 2,
        name: 'Size',
        type: 'option',
        optionId: 9,
        optionName: 'XL',
      },
    ]);

    const items = card.get(1)![0]!.items;
    expect(items[0]).toMatchObject({ value: 'no', raw: false });
    expect(items[1]).toEqual({
      attribute: { id: 2, name: 'Size', unit: null, type: 'option', isMain: false },
      value: 'XL',
      raw: 9,
    });
  });
});
