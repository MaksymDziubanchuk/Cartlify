import { describe, expect, it } from '@jest/globals';

import {
  checkAttributeSettings,
  checkOrderIds,
  normalizeColor,
  normalizeDirectoryName,
  normalizeUnit,
} from '@helpers/attributeFields.js';

import { thrownBy } from '../../helpers/errors.js';

// the values of the directory of characteristics: names, the unit, the colour of a value, the
// settings of a number and the order of a scope

describe('normalizeDirectoryName', () => {
  it('trims a name and keeps one of 100 signs', () => {
    expect(normalizeDirectoryName('  Screen  ', 'ATTRIBUTE_GROUP')).toBe('Screen');
    expect(normalizeDirectoryName('x'.repeat(100), 'ATTRIBUTE')).toHaveLength(100);
  });

  it('counts the signs a person sees, not the code units', () => {
    expect(normalizeDirectoryName('\u{1F600}'.repeat(100), 'ATTRIBUTE')).toHaveLength(200);
  });

  it.each([['   '], [''], [null], [undefined], [5], ['x'.repeat(101)]])(
    'refuses %p with the code of its kind and names the field',
    (value) => {
      expect(thrownBy(() => normalizeDirectoryName(value, 'ATTRIBUTE_OPTION'))).toMatchObject({
        statusCode: 400,
        errorCode: 'ATTRIBUTE_OPTION_FIELDS_INVALID',
        details: { fields: ['name'] },
      });
    },
  );
});

describe('normalizeUnit', () => {
  it('trims a unit, takes up to 20 signs, and gives null for none', () => {
    expect(normalizeUnit(' GB ')).toBe('GB');
    expect(normalizeUnit('u'.repeat(20))).toHaveLength(20);
    expect(normalizeUnit('   ')).toBeNull();
    expect(normalizeUnit(null)).toBeNull();
  });

  it.each([['u'.repeat(21)], [5], [undefined]])('refuses %p', (value) => {
    expect(thrownBy(() => normalizeUnit(value))).toMatchObject({
      errorCode: 'ATTRIBUTE_FIELDS_INVALID',
      details: { fields: ['unit'] },
    });
  });
});

describe('normalizeColor', () => {
  it('takes #RRGGBB in any case, keeps it in small letters, and null is none', () => {
    expect(normalizeColor('#00FF7f')).toBe('#00ff7f');
    expect(normalizeColor(' #000000 ')).toBe('#000000');
    expect(normalizeColor(null)).toBeNull();
  });

  it.each([['00ff00'], ['#0f0'], ['#00gg00'], ['red'], [''], [5], [undefined]])(
    'refuses %p',
    (value) => {
      expect(thrownBy(() => normalizeColor(value))).toMatchObject({
        errorCode: 'ATTRIBUTE_OPTION_FIELDS_INVALID',
        details: { fields: ['colorCode'] },
      });
    },
  );
});

describe('checkAttributeSettings', () => {
  const settings = (type: string, over: Record<string, unknown> = {}) =>
    ({
      type,
      isMain: false,
      decimals: undefined,
      minValue: undefined,
      maxValue: undefined,
      ...over,
    }) as Parameters<typeof checkAttributeSettings>[0];

  it('gives a number its digits (0 when not said) and its bounds', () => {
    expect(checkAttributeSettings(settings('number'))).toEqual({
      decimals: 0,
      minValue: null,
      maxValue: null,
    });
    expect(
      checkAttributeSettings(settings('number', { decimals: 3, minValue: 1.5, maxValue: 120 })),
    ).toEqual({ decimals: 3, minValue: 1.5, maxValue: 120 });
  });

  it.each([[-1], [4], [1.5], ['2']])('refuses %p digits after the point', (decimals) => {
    expect(thrownBy(() => checkAttributeSettings(settings('number', { decimals })))).toMatchObject({
      errorCode: 'ATTRIBUTE_FIELDS_INVALID',
      details: { fields: ['decimals'] },
    });
  });

  it('refuses bounds that are not numbers, too big, or the wrong way round', () => {
    expect(
      thrownBy(() => checkAttributeSettings(settings('number', { minValue: 'low' }))),
    ).toMatchObject({ details: { fields: ['minValue'] } });
    expect(
      thrownBy(() => checkAttributeSettings(settings('number', { maxValue: 1e16 }))),
    ).toMatchObject({ details: { fields: ['maxValue'] } });
    expect(
      thrownBy(() => checkAttributeSettings(settings('number', { minValue: 5, maxValue: 1 }))),
    ).toMatchObject({ details: { fields: ['minValue', 'maxValue'] } });
  });

  it.each([['text'], ['boolean'], ['option'], ['options']])(
    'gives %s no settings of a number and refuses ones that are sent',
    (type) => {
      expect(checkAttributeSettings(settings(type))).toEqual({
        decimals: null,
        minValue: null,
        maxValue: null,
      });
      expect(
        thrownBy(() => checkAttributeSettings(settings(type, { decimals: 1, minValue: 1 }))),
      ).toMatchObject({ details: { fields: ['decimals', 'minValue'] } });
    },
  );

  it.each([['number'], ['boolean'], ['option']])('lets a %s be a main characteristic', (type) => {
    expect(() => checkAttributeSettings(settings(type, { isMain: true }))).not.toThrow();
  });

  it.each([['text'], ['options']])('refuses a %s as a main characteristic', (type) => {
    expect(thrownBy(() => checkAttributeSettings(settings(type, { isMain: true })))).toMatchObject({
      errorCode: 'ATTRIBUTE_MAIN_NOT_ALLOWED',
      details: { type },
    });
  });
});

describe('checkOrderIds', () => {
  it('takes every row once, in any order', () => {
    expect(() => checkOrderIds([1, 2, 3], [3, 1, 2])).not.toThrow();
    expect(() => checkOrderIds([], [])).not.toThrow();
  });

  it('names what is missing, what is not a row of the scope and what comes twice', () => {
    expect(thrownBy(() => checkOrderIds([1, 2, 3], [3, 3, 9]))).toMatchObject({
      statusCode: 400,
      errorCode: 'ORDER_IDS_MISMATCH',
      details: { missing: [1, 2], unknown: [9], repeated: [3] },
    });
  });
});

describe('the bounds of a number and the digits the column keeps', () => {
  const bounded = (over: Record<string, unknown>) =>
    ({
      type: 'number',
      isMain: false,
      decimals: undefined,
      minValue: undefined,
      maxValue: undefined,
      ...over,
    }) as Parameters<typeof checkAttributeSettings>[0];

  it.each([[0.125], [99.5], [-0.001], [1e14]])('keeps %p as it is', (bound) => {
    expect(checkAttributeSettings(bounded({ minValue: bound })).minValue).toBe(bound);
  });

  it.each([[0.1234], [1.0005], [-2.00001]])(
    'refuses %p, which the column would round to 3 digits',
    (bound) => {
      expect(thrownBy(() => checkAttributeSettings(bounded({ maxValue: bound })))).toMatchObject({
        errorCode: 'ATTRIBUTE_FIELDS_INVALID',
        details: { fields: ['maxValue'] },
      });
    },
  );
});
