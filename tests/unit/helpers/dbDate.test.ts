import { describe, expect, it } from '@jest/globals';

import { isDbYear } from '@helpers/dbDate.js';

describe('isDbYear', () => {
  it.each([
    ['the year 0, which postgres has not', '0000-01-01T00:00:00.000Z', false],
    ['the year 1', '0001-01-01T00:00:00.000Z', true],
    ['a year of now', '2026-10-23T00:00:00.000Z', true],
    ['the year 9999', '9999-12-31T23:59:59.999Z', true],
    ['a year past 9999', '+010000-01-01T00:00:00.000Z', false],
  ])('tells %s', (_case, iso, fits) => {
    expect(isDbYear(new Date(iso))).toBe(fits);
  });
});
