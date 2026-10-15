import { inspect } from 'node:util';
import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { b64url, b64urlJson, signState } from '@helpers/b64Payload.js';

import { rejectedBy, statusOf, thrownBy } from '../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../helpers/fetchStub.js';
import { importWithEnv } from '../../helpers/freshImport.js';

type LinkedInOAuth = typeof import('@utils/linkedinOAuth.js');

// synthetic settings, the module reads them at import
const CONFIG = {
  LINKEDIN_CLIENT_ID: 'test-linkedin-client-id',
  LINKEDIN_CLIENT_SECRET: 'test-linkedin-client-secret',
  LINKEDIN_REDIRECT_URI: 'http://localhost:3000/api/auth/linkedin/callback',
  LINKEDIN_STATE_SECRET: 'test-linkedin-state-secret',
};
const NO_CONFIG = Object.fromEntries(Object.keys(CONFIG).map((key) => [key, '']));

const nowSec = () => Math.floor(Date.now() / 1000);

const signed = (payload: unknown, secret = CONFIG.LINKEDIN_STATE_SECRET) => {
  const body = typeof payload === 'string' ? b64url(payload) : b64urlJson(payload);
  return `${body}.${signState(body, secret)}`;
};

const tokens = {
  access_token: 'linkedin-access-token',
  expires_in: 5183999,
  token_type: 'Bearer',
  id_token: 'linkedin-id-token',
  scope: 'email,openid,profile',
};

let linkedin: LinkedInOAuth;

beforeAll(async () => {
  linkedin = await importWithEnv<LinkedInOAuth>('@utils/linkedinOAuth.js', CONFIG);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('buildLinkedInAuthUrl', () => {
  it('sends the user to the linkedin consent page with our client, callback and scopes', () => {
    const url = new URL(linkedin.buildLinkedInAuthUrl('guest-1'));

    expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.LINKEDIN_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.LINKEDIN_REDIRECT_URI);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual([
      'email',
      'openid',
      'profile',
    ]);
  });

  it('binds the state in the url to the guest who started the login', () => {
    const state = new URL(linkedin.buildLinkedInAuthUrl('guest-1')).searchParams.get('state')!;

    expect(linkedin.verifyLinkedInOAuthState(state, 'guest-1').guestId).toBe('guest-1');
  });
});

describe('verifyLinkedInOAuthState', () => {
  // login csrf: a state from a login another browser started must not finish here
  it('rejects a valid state when another guest finishes the login', () => {
    const state = linkedin.createLinkedInOAuthState('guest-1');

    expect(thrownBy(() => linkedin.verifyLinkedInOAuthState(state, 'guest-2'))).toMatchObject({
      statusCode: 403,
      errorCode: 'LINKEDIN_OAUTH_STATE_GUEST_MISMATCH',
    });
  });

  it('reports an expired state as expired, whoever finishes it', () => {
    const start = Date.now();
    const state = linkedin.createLinkedInOAuthState('guest-1');

    jest.spyOn(Date, 'now').mockReturnValue(start + 11 * 60 * 1000);

    expect(thrownBy(() => linkedin.verifyLinkedInOAuthState(state, 'guest-2'))).toMatchObject({
      errorCode: 'LINKEDIN_OAUTH_STATE_EXPIRED',
    });
  });

  it('returns the guest and lets the state live ten minutes', () => {
    const payload = linkedin.verifyLinkedInOAuthState(
      linkedin.createLinkedInOAuthState('guest-7'),
      'guest-7',
    );

    expect(payload.guestId).toBe('guest-7');
    expect(payload.exp - payload.iat).toBe(600);
  });

  it('rejects the state after ten minutes', () => {
    const start = Date.now();
    const state = linkedin.createLinkedInOAuthState('guest-1');

    jest.spyOn(Date, 'now').mockReturnValue(start + 11 * 60 * 1000);
    const err = thrownBy(() => linkedin.verifyLinkedInOAuthState(state, 'guest-1'));

    expect(err).toMatchObject({ errorCode: 'LINKEDIN_OAUTH_STATE_EXPIRED' });
    expect([400, 401]).toContain(statusOf(err));
  });

  it.each([
    ['has no signature', 'payload-only'],
    [
      'was signed with another secret',
      signed({ guestId: 'g', nonce: 'n', iat: nowSec(), exp: nowSec() + 600 }, 'not-our-secret'),
    ],
  ])('rejects a state that %s', (_case, state) => {
    expect(thrownBy(() => linkedin.verifyLinkedInOAuthState(state, 'g'))).toMatchObject({
      statusCode: 400,
    });
  });

  it.each([
    ['was issued in the future', { iat: nowSec() + 120, exp: nowSec() + 720 }],
    ['expires before it was issued', { iat: nowSec() + 20, exp: nowSec() + 10 }],
    ['has no issue time', { exp: nowSec() + 600 }],
  ])('rejects a signed state that %s', (_case, times) => {
    const err = thrownBy(() =>
      linkedin.verifyLinkedInOAuthState(signed({ guestId: 'g', nonce: 'n', ...times }), 'g'),
    );

    expect([400, 401]).toContain(statusOf(err));
  });

  it('treats a signed state that is not json as a server fault, only we can sign one', () => {
    expect(
      thrownBy(() => linkedin.verifyLinkedInOAuthState(signed('not json'), 'g')),
    ).toMatchObject({
      statusCode: 500,
    });
  });
});

describe('exchangeLinkedInCodeForTokens', () => {
  it('posts the code with our client credentials to the linkedin token endpoint', async () => {
    const calls = stubFetch(() => jsonResponse(tokens));

    await expect(linkedin.exchangeLinkedInCodeForTokens('auth-code')).resolves.toEqual(tokens);

    expect(calls[0]).toMatchObject({
      url: 'https://www.linkedin.com/oauth/v2/accessToken',
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      code: 'auth-code',
      client_id: CONFIG.LINKEDIN_CLIENT_ID,
      client_secret: CONFIG.LINKEDIN_CLIENT_SECRET,
      redirect_uri: CONFIG.LINKEDIN_REDIRECT_URI,
      grant_type: 'authorization_code',
    });
  });

  it('reports a refused code as unauthorized and keeps the linkedin status', async () => {
    stubFetch(() => jsonResponse({ error: 'invalid_request' }, 400));

    const err = await rejectedBy(() => linkedin.exchangeLinkedInCodeForTokens('used-code'));

    expect(err).toMatchObject({
      statusCode: 401,
      errorCode: 'LINKEDIN_OAUTH_TOKEN_EXCHANGE_FAILED',
      details: { status: 400 },
    });
    expect(inspect(err, { depth: 5 })).not.toContain(CONFIG.LINKEDIN_CLIENT_SECRET);
  });

  it('reports an answer without an access token as unauthorized', async () => {
    stubFetch(() => jsonResponse({ expires_in: 10 }));

    const err = await rejectedBy(() => linkedin.exchangeLinkedInCodeForTokens('auth-code'));

    expect(err).toMatchObject({ statusCode: 401, errorCode: 'LINKEDIN_OAUTH_NO_ACCESS_TOKEN' });
  });

  it('treats an unreadable token response as a server fault', async () => {
    stubFetch(() => textResponse('<html>bad gateway</html>'));

    const err = await rejectedBy(() => linkedin.exchangeLinkedInCodeForTokens('auth-code'));

    expect(err).toMatchObject({ statusCode: 500, errorCode: 'INTERNAL_ERROR' });
  });
});

describe('linkedin oauth without settings', () => {
  let bare: LinkedInOAuth;

  beforeAll(async () => {
    bare = await importWithEnv<LinkedInOAuth>('@utils/linkedinOAuth.js', NO_CONFIG);
  });

  it('cannot start a login or check a state', () => {
    expect(thrownBy(() => bare.buildLinkedInAuthUrl('guest-1'))).toMatchObject({
      statusCode: 500,
    });
    expect(thrownBy(() => bare.verifyLinkedInOAuthState('a.b', 'g'))).toMatchObject({
      statusCode: 500,
    });
  });

  it('cannot exchange a code and does not call linkedin', async () => {
    const calls = stubFetch(() => jsonResponse(tokens));

    const err = await rejectedBy(() => bare.exchangeLinkedInCodeForTokens('auth-code'));

    expect(err).toMatchObject({ statusCode: 500 });
    expect(calls).toHaveLength(0);
  });
});
