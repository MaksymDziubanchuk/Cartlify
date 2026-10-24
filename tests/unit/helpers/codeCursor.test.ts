import { describe, expect, it } from '@jest/globals';

import {
  cursorDate,
  cursorNumber,
  cursorString,
  decodeCursor,
  encodeCursor,
} from '@helpers/codeCursor.js';
import { BadRequestError } from '@utils/errors.js';

// base64url of a json value, the same encoding the cursor uses
const encodeJson = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('codeCursor', () => {
  it('returns the same payload when an encoded cursor is decoded', () => {
    const payloads = [
      { id: 1, v: null },
      { id: 42, v: 19.99 },
      { id: 7, v: 'name with spaces / and + signs' },
    ];

    for (const payload of payloads) {
      expect(decodeCursor(encodeCursor(payload))).toEqual(payload);
    }
  });

  it('produces only base64url characters when the payload has unicode text', () => {
    expect(encodeCursor({ id: 3, v: 'Café ✓' })).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('reads the last id the database holds', () => {
    expect(decodeCursor(encodeCursor({ id: 2_147_483_647, v: null }))).toEqual({
      id: 2_147_483_647,
      v: null,
    });
  });

  // base64url decoding skips a sign it does not know, so such a cursor would read as a good one:
  // only the signs of base64url are a cursor
  it.each([
    ['a sign before it', `!${encodeCursor({ id: 4, v: 'x' })}`],
    ['a sign after it', `${encodeCursor({ id: 4, v: 'x' })}!`],
    [
      'a space inside it',
      `${encodeCursor({ id: 4, v: 'x' }).slice(0, 4)} ${encodeCursor({ id: 4, v: 'x' }).slice(4)}`,
    ],
  ])('refuses a good cursor with %s', (_case, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(BadRequestError);
  });

  it.each([
    ['the cursor is empty', ''],
    ['the cursor has characters outside base64url', 'abc+/='],
    ['the cursor is not json', Buffer.from('not json').toString('base64url')],
    ['the id is zero', encodeJson({ id: 0, v: null })],
    ['the id is negative', encodeJson({ id: -5, v: null })],
    ['the id is not an integer', encodeJson({ id: 1.5, v: null })],
    // the int of postgres ends there: a bigger id is no row, the database failed it with 500
    ['the id is past the ids of the database', encodeJson({ id: 2_147_483_648, v: null })],
    ['the id is missing', encodeJson({ v: 'x' })],
    ['the payload is null', encodeJson(null)],
  ])('throws CURSOR_INVALID when %s', (_case, cursor) => {
    let error: unknown;

    try {
      decodeCursor(cursor);
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({ statusCode: 400, errorCode: 'CURSOR_INVALID' });
  });
});

// the sort value of a cursor: a value that does not fit the sort is a bad request
describe('cursor sort values', () => {
  const invalid = (fn: () => unknown) => {
    let error: unknown;

    try {
      fn();
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(BadRequestError);
    expect(error).toMatchObject({ statusCode: 400, errorCode: 'CURSOR_INVALID' });
  };

  it('reads an iso date', () => {
    expect(cursorDate('2026-03-01T10:00:00.000Z')).toEqual(new Date('2026-03-01T10:00:00.000Z'));
  });

  it.each([
    ['a word', 'yesterday'],
    ['null', null],
    ['a number', 1772359200000],
  ])('rejects a date that is %s', (_case, v) => {
    invalid(() => cursorDate(v));
  });

  it.each([
    ['a number', 19.99, 19.99],
    ['zero', 0, 0],
    ['a numeric string', '25.5', 25.5],
  ])('reads %s as a number', (_case, v, num) => {
    expect(cursorNumber(v)).toBe(num);
  });

  it.each([
    ['a word', 'cheap'],
    ['a date', '2026-03-01T10:00:00.000Z'],
    ['an empty string', ' '],
    ['null', null],
  ])('rejects a number that is %s', (_case, v) => {
    invalid(() => cursorNumber(v));
  });

  it('reads a string, an empty one too', () => {
    expect(cursorString('Kyiv')).toBe('Kyiv');
    expect(cursorString('')).toBe('');
  });

  it.each([null, 42])('rejects the string %p', (v) => {
    invalid(() => cursorString(v));
  });
});
