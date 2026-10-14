import { describe, expect, it } from '@jest/globals';

import { assertLimit } from '@helpers/assertLimit.js';
import { BadRequestError } from '@utils/errors.js';

import { thrownBy } from '../../helpers/errors.js';

describe('assertLimit', () => {
  it.each([
    [1, 1],
    [20, 20],
    [100, 100],
    ['15', 15],
  ])('returns %p as %p when the limit is a positive integer', (input, expected) => {
    expect(assertLimit(input)).toBe(expected);
  });

  it('caps the limit at 100 when a bigger page is asked', () => {
    expect(assertLimit(101)).toBe(100);
    expect(assertLimit(10_000)).toBe(100);
  });

  it.each([
    ['zero', 0],
    ['a negative number', -5],
    ['a fraction', 2.5],
    ['NaN', Number.NaN],
    ['infinity', Number.POSITIVE_INFINITY],
    ['an empty string', ''],
    ['a word', 'ten'],
    ['null', null],
    ['undefined', undefined],
    ['a boolean', true],
    ['an array', [5]],
  ])('throws LIMIT_INVALID when the limit is %s', (_case, input) => {
    const err = thrownBy(() => assertLimit(input));

    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ statusCode: 400, errorCode: 'LIMIT_INVALID' });
  });
});
