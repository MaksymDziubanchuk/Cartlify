import { createHmac } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';

import { b64url, b64urlJson, signState } from '@helpers/b64Payload.js';

describe('b64url', () => {
  it('matches the standard base64url encoding of a string', () => {
    const text = 'state?with/slashes+and=padding~ünïcode';

    expect(b64url(text)).toBe(Buffer.from(text, 'utf8').toString('base64url'));
  });

  it('matches the standard base64url encoding of raw bytes', () => {
    const bytes = Buffer.from([0xfb, 0xff, 0xfe, 0x00, 0x3e, 0x3f]);

    expect(b64url(bytes)).toBe(bytes.toString('base64url'));
  });

  it('never contains +, / or = padding', () => {
    for (let len = 1; len <= 10; len += 1) {
      expect(b64url(Buffer.alloc(len, 0xff))).toMatch(/^[A-Za-z0-9_-]*$/);
    }
  });

  it('returns an empty string for empty input', () => {
    expect(b64url('')).toBe('');
  });
});

describe('b64urlJson', () => {
  it('encodes json that decodes back to the same value', () => {
    const value = { id: 7, next: '/orders?page=2', tags: ['a', 'b'] };

    const decoded = JSON.parse(Buffer.from(b64urlJson(value), 'base64url').toString('utf8'));

    expect(decoded).toEqual(value);
  });
});

describe('signState', () => {
  it('is the base64url hmac-sha256 of the payload with the secret', () => {
    const expected = createHmac('sha256', 'secret').update('payload').digest('base64url');

    expect(signState('payload', 'secret')).toBe(expected);
  });

  it('gives the same signature for the same payload and secret', () => {
    expect(signState('p', 's')).toBe(signState('p', 's'));
  });

  it('changes when the payload or the secret changes', () => {
    const base = signState('payload', 'secret');

    expect(signState('payload2', 'secret')).not.toBe(base);
    expect(signState('payload', 'secret2')).not.toBe(base);
  });
});
