import { inspect } from 'node:util';
import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { b64url, b64urlJson, signState } from '@helpers/b64Payload.js';

import { rejectedBy, statusOf, thrownBy } from '../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../helpers/fetchStub.js';
import { importWithEnv } from '../../helpers/freshImport.js';

type GithubOAuth = typeof import('@utils/githubOAuth.js');
type GithubEmailItem = import('@utils/githubOAuth.js').GithubEmailItem;

// synthetic settings, the module reads them at import
const CONFIG = {
  GITHUB_CLIENT_ID: 'test-github-client-id',
  GITHUB_CLIENT_SECRET: 'test-github-client-secret',
  GITHUB_REDIRECT_URI: 'http://localhost:3000/api/auth/github/callback',
  GITHUB_STATE_SECRET: 'test-github-state-secret',
};
const NO_CONFIG = Object.fromEntries(Object.keys(CONFIG).map((key) => [key, '']));

const nowSec = () => Math.floor(Date.now() / 1000);

const signed = (payload: unknown, secret = CONFIG.GITHUB_STATE_SECRET) => {
  const body = typeof payload === 'string' ? b64url(payload) : b64urlJson(payload);
  return `${body}.${signState(body, secret)}`;
};

const tokens = { access_token: 'gho_test', token_type: 'bearer', scope: 'read:user,user:email' };
const profile = { id: 42, login: 'octo', name: 'Octo Cat', email: null };

let github: GithubOAuth;

beforeAll(async () => {
  github = await importWithEnv<GithubOAuth>('@utils/githubOAuth.js', CONFIG);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('buildGithubAuthUrl', () => {
  it('sends the user to the github consent page with our client, callback and scopes', () => {
    const url = new URL(github.buildGithubAuthUrl('guest-1'));

    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe(CONFIG.GITHUB_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.GITHUB_REDIRECT_URI);
    // the profile and the email list are read after the login
    expect(url.searchParams.get('scope')?.split(' ').sort()).toEqual(['read:user', 'user:email']);
  });

  it('binds the state in the url to the guest who started the login', () => {
    const state = new URL(github.buildGithubAuthUrl('guest-1')).searchParams.get('state')!;

    expect(github.verifyGithubOAuthState(state, 'guest-1')?.guestId).toBe('guest-1');
  });
});

describe('verifyGithubOAuthState', () => {
  // login csrf: a state from a login another browser started must not finish here
  it('rejects a valid state when another guest finishes the login', () => {
    const state = github.createGithubOAuthState('guest-1');

    expect(thrownBy(() => github.verifyGithubOAuthState(state, 'guest-2'))).toMatchObject({
      statusCode: 403,
      errorCode: 'GITHUB_OAUTH_STATE_GUEST_MISMATCH',
    });
  });

  it('reports an expired state as expired, whoever finishes it', () => {
    const start = Date.now();
    const state = github.createGithubOAuthState('guest-1');

    jest.spyOn(Date, 'now').mockReturnValue(start + 11 * 60 * 1000);

    expect(thrownBy(() => github.verifyGithubOAuthState(state, 'guest-2'))).toMatchObject({
      errorCode: 'GITHUB_OAUTH_STATE_EXPIRED',
    });
  });

  it('returns the guest and lets the state live ten minutes', () => {
    const payload = github.verifyGithubOAuthState(
      github.createGithubOAuthState('guest-7'),
      'guest-7',
    );

    expect(payload?.guestId).toBe('guest-7');
    expect(payload!.exp - payload!.iat).toBe(600);
  });

  it('rejects the state after ten minutes', () => {
    const start = Date.now();
    const state = github.createGithubOAuthState('guest-1');

    jest.spyOn(Date, 'now').mockReturnValue(start + 11 * 60 * 1000);
    const err = thrownBy(() => github.verifyGithubOAuthState(state, 'guest-1'));

    expect(err).toMatchObject({ errorCode: 'GITHUB_OAUTH_STATE_EXPIRED' });
    expect([400, 401]).toContain(statusOf(err));
  });

  it.each([
    ['has no signature', 'payload-only'],
    [
      'was signed with another secret',
      signed({ guestId: 'g', nonce: 'n', iat: nowSec(), exp: nowSec() + 600 }, 'not-our-secret'),
    ],
  ])('rejects a state that %s', (_case, state) => {
    expect(thrownBy(() => github.verifyGithubOAuthState(state, 'g'))).toMatchObject({
      statusCode: 400,
    });
  });

  it.each([
    ['was issued in the future', { iat: nowSec() + 120, exp: nowSec() + 720 }],
    ['expires before it was issued', { iat: nowSec() + 20, exp: nowSec() + 10 }],
    ['has no issue time', { exp: nowSec() + 600 }],
  ])('rejects a signed state that %s', (_case, times) => {
    const err = thrownBy(() =>
      github.verifyGithubOAuthState(signed({ guestId: 'g', nonce: 'n', ...times }), 'g'),
    );

    expect([400, 401]).toContain(statusOf(err));
  });

  it('treats a signed state that is not json as a server fault, only we can sign one', () => {
    expect(thrownBy(() => github.verifyGithubOAuthState(signed('not json'), 'g'))).toMatchObject({
      statusCode: 500,
    });
  });
});

describe('exchangeGithubCodeForTokens', () => {
  it('posts the code with our client credentials and asks for json', async () => {
    const calls = stubFetch(() => jsonResponse(tokens));

    await expect(github.exchangeGithubCodeForTokens('auth-code', 'the-state')).resolves.toEqual(
      tokens,
    );

    expect(calls[0]).toMatchObject({
      url: 'https://github.com/login/oauth/access_token',
      method: 'POST',
      headers: { accept: 'application/json' },
    });
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      code: 'auth-code',
      client_id: CONFIG.GITHUB_CLIENT_ID,
      client_secret: CONFIG.GITHUB_CLIENT_SECRET,
      redirect_uri: CONFIG.GITHUB_REDIRECT_URI,
      state: 'the-state',
    });
  });

  // github answers a bad code with 200 and an error field
  it('reports an error answer as unauthorized even with status 200', async () => {
    stubFetch(() => jsonResponse({ error: 'bad_verification_code' }));

    const err = await rejectedBy(() => github.exchangeGithubCodeForTokens('used-code'));

    // the github code tells why, the same way a provider error in the callback is reported
    expect(err).toMatchObject({
      statusCode: 401,
      errorCode: 'GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED',
      details: { providerError: 'bad_verification_code' },
    });
  });

  it('reports an answer without an access token as unauthorized', async () => {
    stubFetch(() => jsonResponse({ token_type: 'bearer' }));

    const err = await rejectedBy(() => github.exchangeGithubCodeForTokens('auth-code'));

    expect(err).toMatchObject({ statusCode: 401, errorCode: 'GITHUB_OAUTH_NO_ACCESS_TOKEN' });
  });

  // the same contract as the google and linkedin exchanges
  it('reports a failed exchange as unauthorized and keeps the github status', async () => {
    stubFetch(() => textResponse('server error', 502));

    const err = await rejectedBy(() => github.exchangeGithubCodeForTokens('auth-code'));

    expect(err).toMatchObject({
      statusCode: 401,
      errorCode: 'GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED',
      details: { status: 502 },
    });
    expect(inspect(err, { depth: 5 })).not.toContain(CONFIG.GITHUB_CLIENT_SECRET);
  });

  it.each([
    ['is not json', '<html>maintenance</html>'],
    ['is json but not an object', 'null'],
  ])('treats a token response that %s as a server fault', async (_case, body) => {
    stubFetch(() => textResponse(body));

    const err = await rejectedBy(() => github.exchangeGithubCodeForTokens('auth-code'));

    expect(err).toMatchObject({
      statusCode: 500,
      errorCode: 'INTERNAL_ERROR',
      details: { reason: 'GITHUB_OAUTH_TOKEN_PARSE_FAILED' },
    });
  });
});

describe('fetchGithubUser', () => {
  it('reads the profile with the access token', async () => {
    const calls = stubFetch(() => jsonResponse(profile));

    await expect(github.fetchGithubUser('gho_test')).resolves.toEqual(profile);

    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/user',
      method: 'GET',
      headers: { authorization: 'Bearer gho_test' },
    });
    // the github api refuses requests without a user agent
    expect(calls[0]!.headers['user-agent']).toEqual(expect.any(String));
  });

  it('reports a refused token as unauthorized', async () => {
    stubFetch(() => jsonResponse({ message: 'Bad credentials' }, 401));

    const err = await rejectedBy(() => github.fetchGithubUser('expired'));

    expect(err).toMatchObject({
      statusCode: 401,
      errorCode: 'GITHUB_OAUTH_FETCH_USER_FAILED',
      details: { status: 401 },
    });
  });

  it('treats an unreadable profile as a server fault', async () => {
    stubFetch(() => textResponse('<html>unicorn</html>'));

    const err = await rejectedBy(() => github.fetchGithubUser('gho_test'));

    expect(err).toMatchObject({
      statusCode: 500,
      errorCode: 'INTERNAL_ERROR',
      details: { reason: 'GITHUB_OAUTH_USER_PARSE_FAILED' },
    });
  });
});

describe('fetchGithubEmails', () => {
  const emails: GithubEmailItem[] = [{ email: 'octo@example.com', primary: true, verified: true }];

  it('reads the email list with the access token', async () => {
    const calls = stubFetch(() => jsonResponse(emails));

    await expect(github.fetchGithubEmails('gho_test')).resolves.toEqual(emails);

    expect(calls[0]).toMatchObject({
      url: 'https://api.github.com/user/emails',
      headers: { authorization: 'Bearer gho_test' },
    });
  });

  it('gives an empty list when github does not answer with a list', async () => {
    stubFetch(() => jsonResponse({ message: 'odd' }));

    await expect(github.fetchGithubEmails('gho_test')).resolves.toEqual([]);
  });

  it('reports a refused token as unauthorized', async () => {
    stubFetch(() => jsonResponse({ message: 'Requires authentication' }, 403));

    const err = await rejectedBy(() => github.fetchGithubEmails('gho_test'));

    expect(err).toMatchObject({
      statusCode: 401,
      errorCode: 'GITHUB_OAUTH_FETCH_EMAILS_FAILED',
      details: { status: 403 },
    });
  });

  it('treats an unreadable email list as a server fault', async () => {
    stubFetch(() => textResponse('<html>unicorn</html>'));

    const err = await rejectedBy(() => github.fetchGithubEmails('gho_test'));

    expect(err).toMatchObject({
      statusCode: 500,
      errorCode: 'INTERNAL_ERROR',
      details: { reason: 'GITHUB_OAUTH_EMAILS_PARSE_FAILED' },
    });
  });
});

describe('pickBestGithubEmail', () => {
  const user = (email: string | null = null) => ({ id: 42, login: 'octo', email });

  it('takes the primary verified address first', () => {
    const emails = [
      { email: 'other@example.com', primary: false, verified: true },
      { email: 'main@example.com', primary: true, verified: true },
    ];

    expect(github.pickBestGithubEmail(user('profile@example.com'), emails)).toBe(
      'main@example.com',
    );
  });

  it('takes any verified address when the primary one is not verified', () => {
    const emails = [
      { email: 'main@example.com', primary: true, verified: false },
      { email: 'backup@example.com', primary: false, verified: true },
    ];

    expect(github.pickBestGithubEmail(user(), emails)).toBe('backup@example.com');
  });

  it('falls back to the profile address, trimmed and in lower case', () => {
    expect(github.pickBestGithubEmail(user('  Octo@Example.COM '), [])).toBe('octo@example.com');
  });

  it('gives null when there is no address at all', () => {
    const emails = [{ email: 'main@example.com', primary: true, verified: false }];

    expect(github.pickBestGithubEmail(user(), emails)).toBeNull();
    expect(github.pickBestGithubEmail(user('   '), [])).toBeNull();
  });
});

describe('github oauth without settings', () => {
  let bare: GithubOAuth;

  beforeAll(async () => {
    bare = await importWithEnv<GithubOAuth>('@utils/githubOAuth.js', NO_CONFIG);
  });

  it('cannot start a login or check a state', () => {
    expect(thrownBy(() => bare.buildGithubAuthUrl('guest-1'))).toMatchObject({ statusCode: 500 });
    expect(thrownBy(() => bare.verifyGithubOAuthState('a.b', 'g'))).toMatchObject({
      statusCode: 500,
    });
  });

  it('cannot exchange a code and does not call github', async () => {
    const calls = stubFetch(() => jsonResponse(tokens));

    const err = await rejectedBy(() => bare.exchangeGithubCodeForTokens('auth-code'));

    expect(err).toMatchObject({ statusCode: 500 });
    expect(calls).toHaveLength(0);
  });
});
