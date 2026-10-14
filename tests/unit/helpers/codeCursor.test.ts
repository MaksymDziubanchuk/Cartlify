import { describe, expect, it } from '@jest/globals';

import { decodeCursor, encodeCursor } from '@helpers/codeCursor.js';
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

  it.each([
    ['the cursor is empty', ''],
    ['the cursor has characters outside base64url', 'abc+/='],
    ['the cursor is not json', Buffer.from('not json').toString('base64url')],
    ['the id is zero', encodeJson({ id: 0, v: null })],
    ['the id is negative', encodeJson({ id: -5, v: null })],
    ['the id is not an integer', encodeJson({ id: 1.5, v: null })],
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
