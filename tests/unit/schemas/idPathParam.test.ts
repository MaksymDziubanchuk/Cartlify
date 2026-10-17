import { describe, expect, it } from '@jest/globals';

import { MAX_ID, idPathParam } from '@schemas/idPathParam.js';

describe('MAX_ID', () => {
  it('is the largest int of the database', () => {
    expect(MAX_ID).toBe(2 ** 31 - 1);
  });
});

describe('idPathParam', () => {
  it('is a digit string and says what the id is and its range', () => {
    const schema = idPathParam('the user');

    expect(schema.type).toBe('string');
    expect(schema.description).toBe('Id of the user: a whole number from 1 to 2147483647.');
  });

  it.each(['1', '42', '2147483647', '9999999999'])('lets the digits %s through', (value) => {
    expect(new RegExp(idPathParam('x').pattern).test(value)).toBe(true);
  });

  // the range itself is checked by validateId
  it.each(['0', '01', '-1', '1.5', '1e3', '0x1A', ' 7 ', 'abc', ''])(
    'refuses %p as digits of an id',
    (value) => {
      expect(new RegExp(idPathParam('x').pattern).test(value)).toBe(false);
    },
  );
});
