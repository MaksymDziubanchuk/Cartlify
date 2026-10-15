import { inspect } from 'node:util';
import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { b64url, b64urlJson, signState } from '@helpers/b64Payload.js';

import { rejectedBy, statusOf, thrownBy } from '../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../helpers/fetchStub.js';
import { importWithEnv } from '../../helpers/freshImport.js';

type GoogleOAuth = typeof import('@utils/googleOAuth.js');

// synthetic settings, the module reads them at import
const CONFIG = {
  GOOGLE_CLIENT_ID: 'test-google-client-id',
  GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/auth/google/callback',
  GOOGLE_STATE_SECRET: 'test-google-state-secret',
};
const NO_CONFIG = Object.fromEntries(Object.keys(CONFIG).map((key) => [key, '']));

const nowSec = () => Math.floor(Date.now() / 1000);

// a state signed the way the module signs it, to build payloads it would never issue itself
const signed = (payload: unknown, secret = CONFIG.GOOGLE_STATE_SECRET) => {
  const body = typeof payload === 'string' ? b64url(payload) : b64urlJson(payload);
  return `${body}.${signState(body, secret)}`;
};

const tokens = {
  access_token: 'google-access-token',
  expires_in: 3599,
  token_type: 'Bearer',
  id_token: 'google-id-token',
};

let google: GoogleOAuth;

beforeAll(async () => {
  google = await importWithEnv<GoogleOAuth>('@utils/googleOAuth.js', CONFIG);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('buildGoogleAuthUrl', () => {
  it('sends the user to the google consent page with our client, callback and scopes', () => {
    const url = new URL(google.buildGoogleAuthUrl('guest-1'));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.GOOGLE_REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([
      'email',
      'openid',
      'profile',
    ]);
  });

  it('binds the state in the url to the guest who started the login', () => {
    const state = new URL(google.buildGoogleAuthUrl('guest-1')).searchParams.get('state')!;

    expect(google.verifyGoogleOAuthState(state).guestId).toBe('guest-1');
  });

  it('gives every login its own state', () => {
    expect(google.createGoogleOAuthState('guest-1')).not.toBe(
      google.createGoogleOAuthState('guest-1'),
    );
  });
});

describe('verifyGoogleOAuthState', () => {
  it('returns the guest and lets the state live ten minutes', () => {
    const payload = google.verifyGoogleOAuthState(google.createGoogleOAuthState('guest-7'));

    expect(payload.guestId).toBe('guest-7');
    expect(payload.exp - payload.iat).toBe(600);
  });

  it('accepts the state nine minutes later and rejects it after eleven', () => {
    const start = Date.now();
    const state = google.createGoogleOAuthState('guest-1');

    jest.spyOn(Date, 'now').mockReturnValue(start + 9 * 60 * 1000);
    expect(google.verifyGoogleOAuthState(state).guestId).toBe('guest-1');

    jest.spyOn(Date, 'now').mockReturnValue(start + 11 * 60 * 1000);
    const err = thrownBy(() => google.verifyGoogleOAuthState(state));

    expect(err).toMatchObject({ errorCode: 'GOOGLE_OAUTH_STATE_EXPIRED' });
    expect([400, 401]).toContain(statusOf(err));
  });

  it.each([
    ['is empty', ''],
    ['has no signature', 'payload-only'],
    ['has an empty signature', 'payload.'],
  ])('rejects a state that %s', (_case, state) => {
    expect(thrownBy(() => google.verifyGoogleOAuthState(state))).toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects a state whose guest was changed after signing', () => {
    const [, signature] = google.createGoogleOAuthState('guest-1').split('.');
    const forged = `${b64urlJson({ guestId: 'attacker', nonce: 'n', iat: nowSec(), exp: nowSec() + 600 })}.${signature}`;

    expect(thrownBy(() => google.verifyGoogleOAuthState(forged))).toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects a state signed with another secret', () => {
    const state = signed(
      { guestId: 'guest-1', nonce: 'n', iat: nowSec(), exp: nowSec() + 600 },
      'not-our-secret',
    );

    expect(thrownBy(() => google.verifyGoogleOAuthState(state))).toMatchObject({
      statusCode: 400,
    });
  });

  it.each([
    ['has no expiry', { iat: nowSec() }, 'GOOGLE_OAUTH_STATE_EXPIRED'],
    ['has no issue time', { exp: nowSec() + 600 }, 'GOOGLE_OAUTH_STATE_IAT_INVALID'],
    [
      'was issued in the future',
      { iat: nowSec() + 120, exp: nowSec() + 720 },
      'GOOGLE_OAUTH_STATE_IAT_IN_FUTURE',
    ],
    [
      'expires before it was issued',
      { iat: nowSec() + 20, exp: nowSec() + 10 },
      'GOOGLE_OAUTH_STATE_TIME_RANGE_INVALID',
    ],
  ])('rejects a signed state that %s', (_case, times, errorCode) => {
    const err = thrownBy(() =>
      google.verifyGoogleOAuthState(signed({ guestId: 'guest-1', nonce: 'n', ...times })),
    );

    expect(err).toMatchObject({ errorCode });
    expect([400, 401]).toContain(statusOf(err));
  });

  it('treats a signed state that is not json as a server fault, only we can sign one', () => {
    expect(thrownBy(() => google.verifyGoogleOAuthState(signed('not json')))).toMatchObject({
      statusCode: 500,
    });
  });
});

describe('exchangeGoogleCodeForTokens', () => {
  it('posts the code with our client credentials to the google token endpoint', async () => {
    const calls = stubFetch(() => jsonResponse(tokens));

    await expect(google.exchangeGoogleCodeForTokens('auth-code')).resolves.toEqual(tokens);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: 'https://oauth2.googleapis.com/token',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      code: 'auth-code',
      client_id: CONFIG.GOOGLE_CLIENT_ID,
      client_secret: CONFIG.GOOGLE_CLIENT_SECRET,
      redirect_uri: CONFIG.GOOGLE_REDIRECT_URI,
      grant_type: 'authorization_code',
    });
  });

  it('reports a refused code as unauthorized and keeps the google status', async () => {
    stubFetch(() => jsonResponse({ error: 'invalid_grant' }, 400));

    const err = await rejectedBy(() => google.exchangeGoogleCodeForTokens('used-code'));

    expect(err).toMatchObject({
      statusCode: 401,
      errorCode: 'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED',
      details: { status: 400 },
    });
    expect(inspect(err, { depth: 5 })).not.toContain(CONFIG.GOOGLE_CLIENT_SECRET);
  });

  it('treats an unreadable token response as a server fault', async () => {
    stubFetch(() => textResponse('<html>bad gateway</html>'));

    const err = await rejectedBy(() => google.exchangeGoogleCodeForTokens('auth-code'));

    expect(err).toMatchObject({ statusCode: 500, errorCode: 'INTERNAL_ERROR' });
  });
});

describe('google oauth without settings', () => {
  let bare: GoogleOAuth;

  beforeAll(async () => {
    bare = await importWithEnv<GoogleOAuth>('@utils/googleOAuth.js', NO_CONFIG);
  });

  it('cannot start a login', () => {
    expect(thrownBy(() => bare.buildGoogleAuthUrl('guest-1'))).toMatchObject({
      statusCode: 500,
    });
  });

  it('cannot check a state', () => {
    expect(thrownBy(() => bare.verifyGoogleOAuthState(signed({ guestId: 'g' })))).toMatchObject({
      statusCode: 500,
    });
  });

  it('cannot exchange a code and does not call google', async () => {
    const calls = stubFetch(() => jsonResponse(tokens));

    const err = await rejectedBy(() => bare.exchangeGoogleCodeForTokens('auth-code'));

    expect(err).toMatchObject({ statusCode: 500 });
    expect(calls).toHaveLength(0);
  });
});
