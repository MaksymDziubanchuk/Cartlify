import { createHash } from 'node:crypto';
import { describe, expect, it } from '@jest/globals';

import { hashToken, verifyTokenHash } from '@helpers/tokenHash.js';
import { BadRequestError, InternalError } from '@utils/errors.js';

import { thrownBy } from '../../helpers/errors.js';

describe('hashToken', () => {
  it('is the sha-256 of the token as hex by default', () => {
    expect(hashToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
  });

  it('can return base64url instead', () => {
    expect(hashToken('abc', 'base64url')).toBe(
      createHash('sha256').update('abc').digest('base64url'),
    );
  });

  it('gives different hashes for different tokens', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
  });

  it.each([
    ['empty', ''],
    ['not a string', 123],
  ])('throws TOKEN_INVALID when the token is %s', (_case, token) => {
    const err = thrownBy(() => hashToken(token as string));

    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toMatchObject({ errorCode: 'TOKEN_INVALID' });
  });
});

describe('verifyTokenHash', () => {
  const stored = hashToken('reset-token-123');

  it('is true for the token that was stored', () => {
    expect(verifyTokenHash('reset-token-123', stored)).toBe(true);
  });

  it('is false for any other token', () => {
    expect(verifyTokenHash('reset-token-124', stored)).toBe(false);
    expect(verifyTokenHash('reset-token-123 ', stored)).toBe(false);
  });

  it('is false for an empty token instead of throwing', () => {
    expect(verifyTokenHash('', stored)).toBe(false);
  });

  it('is false when the stored hash has another length', () => {
    expect(verifyTokenHash('reset-token-123', stored.slice(0, 10))).toBe(false);
  });

  it('works with base64url hashes', () => {
    const storedB64 = hashToken('t', 'base64url');

    expect(verifyTokenHash('t', storedB64, 'base64url')).toBe(true);
    expect(verifyTokenHash('u', storedB64, 'base64url')).toBe(false);
  });

  it('throws an internal error when the stored hash is missing, a server-side bug', () => {
    expect(thrownBy(() => verifyTokenHash('t', ''))).toBeInstanceOf(InternalError);
  });
});
