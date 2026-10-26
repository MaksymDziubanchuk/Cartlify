import { afterEach, describe, expect, it, jest } from '@jest/globals';

import env from '@config/env.js';
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

// the link of the mail lives as long as VERIFY_TTL_MS says, a day unless set
describe('makeVerifyToken with VERIFY_TTL_MS', () => {
  afterEach(() => {
    env.VERIFY_TTL_MS = DAY_MS;
    jest.useRealTimers();
  });

  it('expires when the setting says', () => {
    jest.useFakeTimers({ now: new Date('2026-03-01T10:00:00.000Z') });
    env.VERIFY_TTL_MS = 2 * 60 * 60 * 1000;

    expect(makeVerifyToken().expiresAt.toISOString()).toBe('2026-03-01T12:00:00.000Z');
  });
});
