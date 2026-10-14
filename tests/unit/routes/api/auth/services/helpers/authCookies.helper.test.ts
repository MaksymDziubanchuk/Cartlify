import { describe, expect, it } from '@jest/globals';

import {
  clearAuthCookies,
  clearGuestIdCookie,
  setAccessTokenCookie,
  setGuestIdCookie,
  setRefreshTokenCookie,
  shouldClearRefreshCookieOnRefreshError,
} from '@routes/api/auth/services/helpers/authCookies.helper.js';
import { verifyRefreshToken } from '@utils/jwt.js';
import {
  BadRequestError,
  ForbiddenError,
  InternalError,
  ServiceUnavailableError,
  UnauthorizedError,
} from '@utils/errors.js';

import { fakeReply } from '../../../../../../helpers/fakeHttp.js';
import { thrownBy } from '../../../../../../helpers/errors.js';

const named = (name: string) => Object.assign(new Error(name), { name });

describe('auth cookies', () => {
  it.each([
    ['accessToken', setAccessTokenCookie],
    ['refreshToken', setRefreshTokenCookie],
    ['guestId', setGuestIdCookie],
  ] as const)('sets %s as an http-only, same-site cookie for the whole site', (name, set) => {
    const { reply, cookies } = fakeReply();

    set(reply, 'value-1', 600);

    expect(cookies[name]).toEqual({
      value: 'value-1',
      options: { httpOnly: true, sameSite: 'lax', path: '/', secure: false, maxAge: 600 },
    });
  });

  it('marks responses that set auth cookies as not cacheable', () => {
    const { reply, headers } = fakeReply();

    setAccessTokenCookie(reply, 'token', 60);

    expect(headers).toMatchObject({
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      Expires: '0',
    });
  });

  it('clears both login cookies on logout but keeps the guest id', () => {
    const { reply, cleared } = fakeReply();

    clearAuthCookies(reply);

    expect(cleared.sort()).toEqual(['accessToken', 'refreshToken']);
  });

  it('clears the guest id on its own', () => {
    const { reply, cleared } = fakeReply();

    clearGuestIdCookie(reply);

    expect(cleared).toEqual(['guestId']);
  });
});

describe('shouldClearRefreshCookieOnRefreshError', () => {
  it.each(['TokenExpiredError', 'JsonWebTokenError', 'NotBeforeError'])(
    'clears the cookie after a raw jwt %s',
    (name) => {
      expect(shouldClearRefreshCookieOnRefreshError(named(name))).toBe(true);
    },
  );

  // these are the errors the refresh flow really throws, a cookie that caused them is dead
  it('clears the cookie when verifyRefreshToken rejects a forged token', () => {
    const err = thrownBy(() => verifyRefreshToken('forged.token.value'));

    expect(shouldClearRefreshCookieOnRefreshError(err)).toBe(true);
  });

  it.each([
    ['the refresh row is gone', new UnauthorizedError('REFRESH_TOKEN_ROW_NOT_FOUND')],
    ['the token expired in the database', new UnauthorizedError('refresh: token expired (db)')],
    ['the token was reused', new ForbiddenError('REFRESH_TOKEN_REUSE_DETECTED')],
    ['the cookie is empty', new BadRequestError('REFRESH_TOKEN_REQUIRED')],
  ])('clears the cookie when %s', (_case, err) => {
    expect(shouldClearRefreshCookieOnRefreshError(err)).toBe(true);
  });

  it.each([
    ['the server failed', new InternalError()],
    ['redis is down', new ServiceUnavailableError('REDIS_UNAVAILABLE')],
    ['an unknown error happened', new Error('boom')],
    ['nothing was thrown', undefined],
  ])('keeps the cookie when %s, the session may still be fine', (_case, err) => {
    expect(shouldClearRefreshCookieOnRefreshError(err)).toBe(false);
  });
});
