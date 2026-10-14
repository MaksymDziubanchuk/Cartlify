import { describe, expect, it } from '@jest/globals';

import { assertEmail, isEmail } from '@helpers/validateEmail.js';
import { BadRequestError } from '@utils/errors.js';

import { thrownBy } from '../../helpers/errors.js';

const valid = [
  'a@b.co',
  'john.doe@example.com',
  'user+tag@sub.example.co.uk',
  'UPPER@EXAMPLE.COM',
  'o_brien-1@mail-server.io',
];

const invalid: Array<[string, unknown]> = [
  ['empty', ''],
  ['without @', 'plain.example.com'],
  ['without a domain dot', 'user@localhost'],
  ['without a local part', '@example.com'],
  ['with two @', 'a@@example.com'],
  ['with a space inside', 'john doe@example.com'],
  ['with a leading space', ' john@example.com'],
  ['with a trailing space', 'john@example.com '],
  ['with an empty domain label', 'john@.example.com'],
  ['with two dots in a row in the domain', 'john@example..com'],
  ['with a domain label starting with a hyphen', 'john@-example.com'],
  ['with two dots in a row in the local part', 'jo..hn@example.com'],
  ['with an underscore in the domain', 'john@exa_mple.com'],
  ['not a string', 42],
  ['null', null],
];

describe('isEmail', () => {
  it.each(valid)('accepts %s', (email) => {
    expect(isEmail(email)).toBe(true);
  });

  it.each(invalid)('rejects an address %s', (_case, email) => {
    expect(isEmail(email)).toBe(false);
  });
});

describe('assertEmail', () => {
  it.each(valid)('passes %s', (email) => {
    expect(() => assertEmail(email)).not.toThrow();
  });

  it.each(invalid)('throws INVALID_EMAIL for an address %s', (_case, email) => {
    const err = thrownBy(() => assertEmail(email));

    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ errorCode: 'INVALID_EMAIL' });
  });
});
