import jsonwebtoken from 'jsonwebtoken';
import { afterEach, describe, expect, it } from '@jest/globals';

import env from '@config/env.js';
import {
  getTtl,
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '@utils/jwt.js';
import { AccessTokenExpiredError, UnauthorizedError } from '@utils/errors.js';

import { thrownBy } from '../../helpers/errors.js';

const accessPayload = { userId: 5, role: 'USER' as const, type: 'access' };
const refreshPayload = {
  userId: 5,
  role: 'USER' as const,
  type: 'refresh',
  jwtId: 77,
  rememberMe: false,
};

const nowSec = () => Math.floor(Date.now() / 1000);

// sign a token by hand to build payloads the app itself would never issue
const signRaw = (payload: object | string, secret: string) => jsonwebtoken.sign(payload, secret);

const envRecord = env as unknown as Record<string, unknown>;
const ttlKeys = [
  'JWT_ACCESS_TTL_SHORT',
  'JWT_ACCESS_TTL_LONG',
  'JWT_REFRESH_TTL_SHORT',
  'JWT_REFRESH_TTL_LONG',
] as const;
const savedTtl = Object.fromEntries(ttlKeys.map((key) => [key, envRecord[key]]));

afterEach(() => {
  Object.assign(envRecord, savedTtl);
});

describe('getTtl', () => {
  it('uses the default lifetimes when env sets none', () => {
    expect(getTtl(false, 'access')).toBe(1200);
    expect(getTtl(true, 'access')).toBe(3600);
    expect(getTtl(false, 'refresh')).toBe(86400);
    expect(getTtl(true, 'refresh')).toBe(2592000);
  });

  // env.ts checks the four lifetimes at the start (tests/unit/config/env.test.ts), a wrong one
  // stops the server; here only which of them a token takes
  it('takes the lifetime env read at the start', () => {
    envRecord.JWT_ACCESS_TTL_SHORT = 900;
    envRecord.JWT_ACCESS_TTL_LONG = 1800;
    envRecord.JWT_REFRESH_TTL_SHORT = 43200;
    envRecord.JWT_REFRESH_TTL_LONG = 604800;

    expect(getTtl(false, 'access')).toBe(900);
    expect(getTtl(true, 'access')).toBe(1800);
    expect(getTtl(false, 'refresh')).toBe(43200);
    expect(getTtl(true, 'refresh')).toBe(604800);
  });
});

describe('access tokens', () => {
  it('verify back to the same user, role and type', () => {
    const verified = verifyAccessToken(signAccessToken(accessPayload, false));

    expect(verified).toMatchObject(accessPayload);
  });

  it('live as long as the short or the long ttl says', () => {
    const short = verifyAccessToken(signAccessToken(accessPayload, false));
    const long = verifyAccessToken(signAccessToken(accessPayload, true));

    expect(short.exp - nowSec()).toBeGreaterThan(1200 - 5);
    expect(short.exp - nowSec()).toBeLessThanOrEqual(1200);
    expect(long.exp - nowSec()).toBeGreaterThan(3600 - 5);
  });

  it('report ACCESS_TOKEN_EXPIRED when the token is expired', () => {
    const token = signRaw({ ...accessPayload, exp: nowSec() - 10 }, env.JWT_ACCESS_SECRET);

    expect(thrownBy(() => verifyAccessToken(token))).toBeInstanceOf(AccessTokenExpiredError);
  });

  it('are rejected when signed with another secret, for example the refresh one', () => {
    const err = thrownBy(() => verifyAccessToken(signRefreshToken(refreshPayload, false)));

    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toMatchObject({ errorCode: 'ACCESS_TOKEN_INVALID' });
  });

  it('are rejected when the token is not a jwt at all', () => {
    expect(thrownBy(() => verifyAccessToken('not-a-token'))).toMatchObject({
      statusCode: 401,
      errorCode: 'ACCESS_TOKEN_INVALID',
    });
  });

  it('are rejected when the signature was tampered with', () => {
    const token = signAccessToken(accessPayload, false);
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');

    expect(thrownBy(() => verifyAccessToken(tampered))).toMatchObject({
      errorCode: 'ACCESS_TOKEN_INVALID',
    });
  });

  // a correctly signed token with a wrong payload is a different case than a bad signature
  it.each([
    ['the type is refresh', { ...accessPayload, type: 'refresh' }],
    ['the user id is missing', { role: 'USER', type: 'access' }],
    ['the user id is a string', { ...accessPayload, userId: '5' }],
    ['the role is missing', { userId: 5, type: 'access' }],
    // jwt allows a bare string as the payload
    ['the payload is a plain string', 'user-5'],
  ])('report ACCESS_TOKEN_PAYLOAD_INVALID when %s', (_case, payload) => {
    const token = signRaw(payload, env.JWT_ACCESS_SECRET);
    const err = thrownBy(() => verifyAccessToken(token));

    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toMatchObject({ errorCode: 'ACCESS_TOKEN_PAYLOAD_INVALID' });
  });
});

describe('refresh tokens', () => {
  it('verify back to the same payload', () => {
    const verified = verifyRefreshToken(signRefreshToken(refreshPayload, true));

    expect(verified).toMatchObject(refreshPayload);
  });

  it('live as long as the refresh ttl says', () => {
    const short = verifyRefreshToken(signRefreshToken(refreshPayload, false));
    const long = verifyRefreshToken(
      signRefreshToken({ ...refreshPayload, rememberMe: true }, true),
    );

    expect(short.exp - nowSec()).toBeGreaterThan(86400 - 5);
    expect(long.exp - nowSec()).toBeGreaterThan(2592000 - 5);
  });

  it('are rejected when signed with the access secret', () => {
    const err = thrownBy(() => verifyRefreshToken(signAccessToken(accessPayload, false)));

    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toMatchObject({ errorCode: 'REFRESH_TOKEN_INVALID' });
  });

  it('are rejected when expired', () => {
    const token = signRaw({ ...refreshPayload, exp: nowSec() - 10 }, env.JWT_REFRESH_SECRET);

    expect(thrownBy(() => verifyRefreshToken(token))).toBeInstanceOf(UnauthorizedError);
  });

  it.each([
    ['the type is access', { ...refreshPayload, type: 'access' }],
    ['the jwt id is missing', { ...refreshPayload, jwtId: undefined }],
    ['remember me is not a boolean', { ...refreshPayload, rememberMe: 'yes' }],
    ['the user id is missing', { ...refreshPayload, userId: undefined }],
    ['the payload is a plain string', 'user-5'],
  ])('report REFRESH_TOKEN_PAYLOAD_INVALID when %s', (_case, payload) => {
    const token = signRaw(payload, env.JWT_REFRESH_SECRET);
    const err = thrownBy(() => verifyRefreshToken(token));

    expect(err).toBeInstanceOf(UnauthorizedError);
    expect(err).toMatchObject({ errorCode: 'REFRESH_TOKEN_PAYLOAD_INVALID' });
  });
});
