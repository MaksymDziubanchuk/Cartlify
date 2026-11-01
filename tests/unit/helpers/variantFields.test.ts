import { describe, expect, it } from '@jest/globals';

import { hasValidCheckDigit, isBarcode, normalizeBarcode } from '@helpers/variantFields.js';
import { BadRequestError } from '@utils/errors.js';

import { thrownBy } from '../../helpers/errors.js';

// real codes of the four lengths: an EAN-8, a UPC-A, an EAN-13, a GTIN-14
const EAN8 = '96385074';
const UPC_A = '036000291452';
const EAN13 = '4006381333931';
const GTIN14 = '10012345678902';

describe('hasValidCheckDigit', () => {
  it.each([EAN8, UPC_A, EAN13, GTIN14])('takes %s', (code) => {
    expect(hasValidCheckDigit(code)).toBe(true);
  });

  it.each([
    ['the last digit changed', '4006381333932'],
    ['two digits swapped', '4006381333391'],
    ['letters', '40063813339A1'],
    ['empty', ''],
  ])('refuses %s', (_case, code) => {
    expect(hasValidCheckDigit(code)).toBe(false);
  });
});

describe('isBarcode', () => {
  it('takes the lengths 8, 12, 13 and 14 with a good check digit', () => {
    for (const code of [EAN8, UPC_A, EAN13, GTIN14]) expect(isBarcode(code)).toBe(true);
  });

  // a code that is a good sum but not one of the lengths is no barcode
  it.each([
    ['9 digits', '000000000'],
    ['10 digits', '0000000000'],
    ['15 digits', '000000000000000'],
    ['a wrong check digit', '4006381333930'],
  ])('refuses %s', (_case, code) => {
    expect(isBarcode(code)).toBe(false);
  });
});

describe('normalizeBarcode', () => {
  it('keeps a code trimmed, takes an empty one as none and leaves an unsent one unsent', () => {
    expect(normalizeBarcode(`  ${EAN13} `)).toBe(EAN13);
    expect(normalizeBarcode('   ')).toBeNull();
    expect(normalizeBarcode('')).toBeNull();
    expect(normalizeBarcode(null)).toBeNull();
    expect(normalizeBarcode(undefined)).toBeUndefined();
  });

  it('refuses a code that is no barcode with VARIANT_BARCODE_INVALID', () => {
    for (const code of ['12345', '4006381333932', 'abcdefgh']) {
      const err = thrownBy(() => normalizeBarcode(code));

      expect(err).toBeInstanceOf(BadRequestError);
      expect((err as BadRequestError).errorCode).toBe('VARIANT_BARCODE_INVALID');
    }
  });
});
