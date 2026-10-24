import { describe, expect, it } from '@jest/globals';

import { holdsNul } from '@helpers/nulText.js';

describe('holdsNul', () => {
  it.each([
    ['a text with a NUL', 'bad\u0000text', true],
    ['a plain text', 'good text', false],
    ['a text that only writes the escape', 'a \\u0000 b', false],
    ['a NUL deep in an object', { a: [{ b: 'x\u0000' }] }, true],
    ['a NUL in a key', { 'k\u0000': 1 }, true],
    ['numbers, nulls and booleans', { a: 1, b: null, c: [true, 2.5] }, false],
    ['no value', undefined, false],
  ])('tells %s', (_case, value, holds) => {
    expect(holdsNul(value)).toBe(holds);
  });
});

describe('holdsNul in lists and objects', () => {
  it('finds a NUL in any item of a list, not only in the first', () => {
    expect(holdsNul(['fine', 'with \u0000 inside'])).toBe(true);
    expect(holdsNul(['fine', 'also fine'])).toBe(false);
  });

  it('finds a NUL in any field of an object, in a key too', () => {
    expect(holdsNul({ name: 'Lamp', note: 'a \u0000 b' })).toBe(true);
    expect(holdsNul({ name: 'Lamp', ['n\u0000te']: 'x' })).toBe(true);
    expect(holdsNul({ name: 'Lamp', note: 'fine' })).toBe(false);
  });

  it('finds no NUL in a number, a flag or nothing', () => {
    expect(holdsNul(5)).toBe(false);
    expect(holdsNul(true)).toBe(false);
    expect(holdsNul(null)).toBe(false);
  });
});
