import { describe, expect, it } from '@jest/globals';

import {
  DEFAULT_PLACEHOLDER_BYTES,
  createPlaceholder,
  decodePlaceholderInternal,
} from '@helpers/placeholder.js';
import { InternalError } from '@utils/errors.js';

import { thrownBy } from '../../helpers/errors.js';

describe('createPlaceholder', () => {
  it('makes 32 random bytes as hex by default', () => {
    const value = createPlaceholder();

    expect(DEFAULT_PLACEHOLDER_BYTES).toBe(32);
    expect(value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('makes the asked number of bytes as base64url', () => {
    const value = createPlaceholder(16, 'base64url');

    expect(value).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(value, 'base64url')).toHaveLength(16);
  });

  it('never repeats', () => {
    const values = new Set(Array.from({ length: 200 }, () => createPlaceholder()));

    expect(values.size).toBe(200);
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
  ])('throws an internal error when the byte count is %s', (_case, bytes) => {
    expect(thrownBy(() => createPlaceholder(bytes))).toBeInstanceOf(InternalError);
  });
});

describe('decodePlaceholderInternal', () => {
  it('returns the original bytes of a hex placeholder', () => {
    const value = createPlaceholder(8);

    expect(decodePlaceholderInternal(value).toString('hex')).toBe(value);
  });

  it('accepts upper-case hex', () => {
    expect(decodePlaceholderInternal('ABCDEF').toString('hex')).toBe('abcdef');
  });

  it('returns the original bytes of a base64url placeholder', () => {
    const value = createPlaceholder(10, 'base64url');

    expect(decodePlaceholderInternal(value, 'base64url').toString('base64url')).toBe(value);
  });

  it.each([
    ['empty', ''],
    ['odd length', 'abc'],
    ['not hex', 'zz11'],
    ['with spaces', 'ab cd'],
  ])('throws an internal error when a hex placeholder is %s', (_case, value) => {
    expect(thrownBy(() => decodePlaceholderInternal(value))).toBeInstanceOf(InternalError);
  });

  it.each([
    ['empty', ''],
    ['with + and /', 'ab+c/d'],
    ['with padding', 'YWJj='],
    // one base64 character carries only 6 bits, it cannot encode a single byte
    ['one character long', 'A'],
  ])('throws an internal error when a base64url placeholder is %s', (_case, value) => {
    expect(thrownBy(() => decodePlaceholderInternal(value, 'base64url'))).toBeInstanceOf(
      InternalError,
    );
  });

  it('throws an internal error when the value is not a string', () => {
    expect(thrownBy(() => decodePlaceholderInternal(42 as unknown as string))).toBeInstanceOf(
      InternalError,
    );
  });
});
