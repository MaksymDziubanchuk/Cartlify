import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { makeVerifyToken } from '@helpers/makeTokens.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('makeVerifyToken', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('expires exactly one day after it was made', () => {
    jest.useFakeTimers({ now: new Date('2026-03-01T10:00:00.000Z') });

    const { expiresAt } = makeVerifyToken();

    expect(expiresAt.toISOString()).toBe('2026-03-02T10:00:00.000Z');
    expect(expiresAt.getTime() - Date.now()).toBe(DAY_MS);
  });

  it('is a url-safe string of 32 random bytes', () => {
    const { token } = makeVerifyToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => makeVerifyToken().token));

    expect(tokens.size).toBe(200);
  });
});
