import { Prisma } from '@prisma/client';
import { describe, expect, it } from '@jest/globals';

import { decimalToNumber, toNumberSafe, toStringSafe } from '@helpers/safeNormalizer.js';

describe('toNumberSafe', () => {
  it.each([
    [0, 0],
    [42, 42],
    [-3.5, -3.5],
    ['7', 7],
    [' 12.5 ', 12.5],
    ['-1', -1],
    [{ value: '9' }, 9],
  ])('reads %p as %p', (input, expected) => {
    expect(toNumberSafe(input)).toBe(expected);
  });

  it.each([
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['an empty string', ''],
    // Number('   ') is 0, but a blank field is not a number
    ['a blank string', '   '],
    ['a word', 'abc'],
    ['a number followed by text', '12abc'],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['a plain object', {}],
    ['an object with a numeric value', { value: 5 }],
  ])('returns undefined when the input is %s', (_case, input) => {
    expect(toNumberSafe(input)).toBeUndefined();
  });
});

describe('toStringSafe', () => {
  it('returns a string as it is, without trimming', () => {
    expect(toStringSafe('  hi ')).toBe('  hi ');
    expect(toStringSafe('')).toBe('');
  });

  it('unwraps a multipart field object', () => {
    expect(toStringSafe({ value: 'from form' })).toBe('from form');
  });

  it.each([
    ['a number', 5],
    ['null', null],
    ['undefined', undefined],
    ['an object without value', { other: 'x' }],
    ['an object with a non-string value', { value: 5 }],
  ])('returns undefined when the input is %s', (_case, input) => {
    expect(toStringSafe(input)).toBeUndefined();
  });
});

describe('decimalToNumber', () => {
  it('reads a prisma decimal', () => {
    expect(decimalToNumber(new Prisma.Decimal('19.99'))).toBe(19.99);
  });

  it('keeps a plain finite number', () => {
    expect(decimalToNumber(4.5)).toBe(4.5);
  });

  it('reads a numeric string', () => {
    expect(decimalToNumber('12.30')).toBe(12.3);
  });

  it('reads an object with a numeric toString', () => {
    expect(decimalToNumber({ toString: () => '3.25' })).toBe(3.25);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a word', 'abc'],
    ['NaN', Number.NaN],
  ])('falls back to 0 when the input is %s', (_case, input) => {
    expect(decimalToNumber(input)).toBe(0);
  });
});
