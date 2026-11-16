import { afterEach, describe, expect, it } from '@jest/globals';

import {
  customsNeededFor,
  normalizeHsCode,
  normalizeOriginCountry,
  productsWithoutCustomsData,
} from '@helpers/customs.js';
import { isAppError } from '@utils/errors.js';

import { resetShopSettings, setShopSettings } from '../../helpers/shopSettings.js';

// what customs need of a product (the code of the goods, the country of origin) and when a cart
// needs them: a country of a zone that is not free of customs

afterEach(resetShopSettings);

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return isAppError(err) ? err.errorCode : String(err);
  }
  return 'NO_ERROR';
};

describe('normalizeHsCode', () => {
  it('takes 6 to 10 digits, without the dots and the spaces of a tariff book', () => {
    expect(normalizeHsCode('610510')).toBe('610510');
    expect(normalizeHsCode(' 6105.10 00 ')).toBe('61051000');
    expect(normalizeHsCode('6105100000')).toBe('6105100000');
  });

  it('reads nothing, an empty text and spaces as none', () => {
    expect(normalizeHsCode(undefined)).toBeNull();
    expect(normalizeHsCode(null)).toBeNull();
    expect(normalizeHsCode('  ')).toBeNull();
  });

  it.each([['61051'], ['61051000001'], ['6105-10'], ['ABCDEF']])('refuses %s', (code) => {
    expect(codeOf(() => normalizeHsCode(code))).toBe('PRODUCT_HS_CODE_INVALID');
  });

  it('refuses a value that is no text', () => {
    expect(codeOf(() => normalizeHsCode(610510))).toBe('PRODUCT_HS_CODE_INVALID');
  });
});

describe('normalizeOriginCountry', () => {
  it('takes two letters in any case, in capitals', () => {
    expect(normalizeOriginCountry('pt')).toBe('PT');
    expect(normalizeOriginCountry(' CN ')).toBe('CN');
    expect(normalizeOriginCountry('')).toBeNull();
  });

  it.each([['PRT'], ['P'], ['P1']])('refuses %s', (country) => {
    expect(codeOf(() => normalizeOriginCountry(country))).toBe('PRODUCT_ORIGIN_COUNTRY_INVALID');
  });
});

describe('customsNeededFor', () => {
  it('checks nothing while the shop names no country free of customs', () => {
    setShopSettings({ customsFreeCountries: null });

    expect(customsNeededFor('GB')).toBe(false);
  });

  it('needs customs for a country that is not free of them', () => {
    setShopSettings({ customsFreeCountries: ['ES', 'FR'] });

    expect(customsNeededFor('ES')).toBe(false);
    expect(customsNeededFor('GB')).toBe(true);
    expect(customsNeededFor(null)).toBe(false);
  });
});

describe('productsWithoutCustomsData', () => {
  it('names each product without a code or a country once, in the order of the cart', () => {
    expect(
      productsWithoutCustomsData([
        { productId: 2, name: 'Mug', hsCode: null, originCountry: 'PT' },
        { productId: 1, name: 'Shirt', hsCode: '610510', originCountry: 'PT' },
        { productId: 3, name: 'Lamp', hsCode: '940520', originCountry: null },
        { productId: 2, name: 'Mug', hsCode: null, originCountry: 'PT' },
      ]),
    ).toEqual([
      { productId: 2, name: 'Mug' },
      { productId: 3, name: 'Lamp' },
    ]);
  });
});
