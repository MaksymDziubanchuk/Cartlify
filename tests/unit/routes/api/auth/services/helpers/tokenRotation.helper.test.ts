import { describe, expect, it } from '@jest/globals';

import {
  assertRefreshRowBasicsOrThrow,
  calcFixedDeadlineMaxAgeSec,
  type RefreshTokenRow,
} from '@routes/api/auth/services/helpers/tokenRotation.helper.js';

import { thrownBy } from '../../../../../../helpers/errors.js';

const now = new Date('2026-06-01T12:00:00.000Z');
const later = (ms: number) => new Date(now.getTime() + ms);

describe('calcFixedDeadlineMaxAgeSec', () => {
  it('gives the seconds left until the session deadline', () => {
    expect(calcFixedDeadlineMaxAgeSec(later(60 * 60 * 1000), now)).toBe(3600);
  });

  // a cookie that lives past the deadline would carry a token the server already rejects
  it('rounds a part of a second down', () => {
    expect(calcFixedDeadlineMaxAgeSec(later(1999), now)).toBe(1);
  });

  it.each([
    ['is now', 0],
    ['is less than a second away', 400],
    ['has passed', -60_000],
  ])('keeps the cookie for one second when the deadline %s', (_case, ms) => {
    expect(calcFixedDeadlineMaxAgeSec(later(ms), now)).toBe(1);
  });
});

describe('assertRefreshRowBasicsOrThrow', () => {
  const row: RefreshTokenRow = {
    id: 9,
    userId: 3,
    type: 'REFRESH_TOKEN',
    token: 'hash',
    expiresAt: later(1000),
    usedAt: null,
    revokedAt: null,
    sessionId: '33333333-3333-4333-8333-333333333333',
    userAgent: null,
  };

  it('accepts a refresh token row of the same user', () => {
    expect(() => assertRefreshRowBasicsOrThrow(row, { userId: 3 })).not.toThrow();
  });

  it('rejects a row that belongs to another user', () => {
    expect(thrownBy(() => assertRefreshRowBasicsOrThrow(row, { userId: 4 }))).toMatchObject({
      statusCode: 401,
      errorCode: 'REFRESH_TOKEN_USER_MISMATCH',
    });
  });

  it.each(['VERIFY_EMAIL', 'RESET_PASSWORD'] as const)(
    'rejects a %s row used as a refresh token',
    (type) => {
      expect(
        thrownBy(() => assertRefreshRowBasicsOrThrow({ ...row, type }, { userId: 3 })),
      ).toMatchObject({
        statusCode: 401,
        errorCode: 'REFRESH_TOKEN_WRONG_TYPE',
      });
    },
  );
});
