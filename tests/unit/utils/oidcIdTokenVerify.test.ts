import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import jsonwebtoken from 'jsonwebtoken';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { b64urlJson } from '@helpers/b64Payload.js';
import { verifyOidcIdToken } from '@utils/oidcIdTokenVerify.js';

import { rejectedBy } from '../../helpers/errors.js';
import { jsonResponse, stubFetch, textResponse } from '../../helpers/fetchStub.js';

const ISSUER = 'https://accounts.google.com';
const AUDIENCE = 'test-client-id';

const providerKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rotatedKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const strangerKey = generateKeyPairSync('rsa', { modulusLength: 2048 });

const jwkOf = (publicKey: KeyObject, kid: string) => ({
  ...publicKey.export({ format: 'jwk' }),
  kid,
  use: 'sig',
  alg: 'RS256',
});

const nowSec = () => Math.floor(Date.now() / 1000);

const claims = (extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: AUDIENCE,
  sub: '1234567890',
  email: 'buyer@example.com',
  email_verified: true,
  exp: nowSec() + 600,
  ...extra,
});

const signWith = (privateKey: KeyObject, kid: string, extra: Record<string, unknown> = {}) =>
  jsonwebtoken.sign(claims(extra), privateKey, { algorithm: 'RS256', keyid: kid });

const providerToken = (extra: Record<string, unknown> = {}) =>
  signWith(providerKey.privateKey, 'key-1', extra);

// the module caches key sets by url for an hour, a new url per test keeps tests apart
let uriCounter = 0;
const newJwksUri = () => `https://idp.test/jwks/${++uriCounter}`;

const options = (jwksUri: string, extra: Record<string, unknown> = {}) => ({
  jwksUri,
  issuers: [ISSUER, 'accounts.google.com'],
  audience: AUDIENCE,
  algorithms: ['RS256' as const],
  ...extra,
});

// the provider publishes the key-1 public key
const serveProviderKeys = () =>
  stubFetch(() => jsonResponse({ keys: [jwkOf(providerKey.publicKey, 'key-1')] }));

afterEach(() => {
  jest.restoreAllMocks();
});

describe('verifyOidcIdToken', () => {
  it('returns the claims of a token signed with the provider key', async () => {
    serveProviderKeys();

    const payload = await verifyOidcIdToken<Record<string, unknown>>(
      providerToken(),
      options(newJwksUri()),
    );

    expect(payload).toMatchObject({ sub: '1234567890', email: 'buyer@example.com' });
  });

  it('loads the key set from the provider url', async () => {
    const calls = serveProviderKeys();
    const uri = newJwksUri();

    await verifyOidcIdToken(providerToken(), options(uri));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: uri, method: 'GET' });
  });

  it('accepts every issuer from the allowed list', async () => {
    serveProviderKeys();

    await expect(
      verifyOidcIdToken(providerToken({ iss: 'accounts.google.com' }), options(newJwksUri())),
    ).resolves.toMatchObject({ iss: 'accounts.google.com' });
  });

  it.each([
    ['the token was issued for another client', { aud: 'someone-else' }],
    ['the token comes from another issuer', { iss: 'https://evil.example.com' }],
    ['the token is expired', { exp: nowSec() - 120 }],
  ])('rejects the token when %s', async (_case, extra) => {
    serveProviderKeys();

    const err = await rejectedBy(() =>
      verifyOidcIdToken(providerToken(extra), options(newJwksUri())),
    );

    expect(err).toMatchObject({ statusCode: 401, errorCode: 'ID_TOKEN_VERIFY_FAILED' });
  });

  it('rejects a token signed with a foreign key under the provider key id', async () => {
    serveProviderKeys();

    const err = await rejectedBy(() =>
      verifyOidcIdToken(signWith(strangerKey.privateKey, 'key-1'), options(newJwksUri())),
    );

    expect(err).toMatchObject({ statusCode: 401, errorCode: 'ID_TOKEN_VERIFY_FAILED' });
  });

  it('rejects a token whose claims were changed after signing', async () => {
    serveProviderKeys();

    const [header, , signature] = providerToken().split('.');
    const forged = `${header}.${b64urlJson(claims({ email: 'admin@example.com' }))}.${signature}`;

    const err = await rejectedBy(() => verifyOidcIdToken(forged, options(newJwksUri())));

    expect(err).toMatchObject({ statusCode: 401 });
  });

  it('rejects a token signed with a shared secret instead of the provider key', async () => {
    const calls = serveProviderKeys();
    const token = jsonwebtoken.sign(claims(), 'guessable-secret', {
      algorithm: 'HS256',
      keyid: 'key-1',
    });

    const err = await rejectedBy(() => verifyOidcIdToken(token, options(newJwksUri())));

    expect(err).toMatchObject({ statusCode: 401, errorCode: 'ID_TOKEN_UNSUPPORTED_ALG' });
    expect(calls).toHaveLength(0);
  });

  it('rejects an unsigned token', async () => {
    serveProviderKeys();
    const unsigned = `${b64urlJson({ alg: 'none', kid: 'key-1' })}.${b64urlJson(claims())}.`;

    const err = await rejectedBy(() => verifyOidcIdToken(unsigned, options(newJwksUri())));

    expect(err).toMatchObject({ statusCode: 401, errorCode: 'ID_TOKEN_UNSUPPORTED_ALG' });
  });

  it('rejects a token without a key id', async () => {
    serveProviderKeys();
    const token = jsonwebtoken.sign(claims(), providerKey.privateKey, { algorithm: 'RS256' });

    const err = await rejectedBy(() => verifyOidcIdToken(token, options(newJwksUri())));

    expect(err).toMatchObject({ statusCode: 401, errorCode: 'ID_TOKEN_NO_KID' });
  });

  it.each([
    ['an empty string', ''],
    ['random text', 'not-a-token'],
    ['a header that is null', `${b64urlJson(null)}.${b64urlJson(claims())}.sig`],
    [
      'a header that is an array',
      `${b64urlJson([{ alg: 'RS256', kid: 'key-1' }])}.${b64urlJson(claims())}.sig`,
    ],
    ['a header that is a string', `${b64urlJson('RS256')}.${b64urlJson(claims())}.sig`],
    ['a header that is a number', `${b64urlJson(42)}.${b64urlJson(claims())}.sig`],
  ])('rejects %s as an invalid token, not as a server fault', async (_case, token) => {
    serveProviderKeys();

    const err = await rejectedBy(() => verifyOidcIdToken(token, options(newJwksUri())));

    expect(err).toMatchObject({ statusCode: 401 });
  });

  it.each([
    ['null', b64urlJson(null)],
    ['an array', b64urlJson([{ alg: 'RS256', kid: 'key-1' }])],
  ])('reports a header that is %s as INVALID_ID_TOKEN', async (_case, header) => {
    serveProviderKeys();

    const err = await rejectedBy(() =>
      verifyOidcIdToken(`${header}.${b64urlJson(claims())}.sig`, options(newJwksUri())),
    );

    expect(err).toMatchObject({ statusCode: 401, errorCode: 'INVALID_ID_TOKEN' });
  });

  // an empty client id must not turn into "any client", a token for another app stays foreign;
  // the settings are ours, so it is a server fault, and the provider keys are not even loaded
  it.each([
    ['the audience is empty', { audience: '' }],
    ['the audience is blank', { audience: '   ' }],
    ['an issuer in the list is empty', { issuers: [ISSUER, ''] }],
    ['the issuer list is empty', { issuers: [] }],
    ['the key set url is empty', { jwksUri: '' }],
  ])('refuses to check a token when %s', async (_case, extra) => {
    const calls = serveProviderKeys();

    const err = await rejectedBy(() =>
      verifyOidcIdToken(providerToken({ aud: 'another-app' }), options(newJwksUri(), extra)),
    );

    expect(err).toMatchObject({
      statusCode: 500,
      errorCode: 'INTERNAL_ERROR',
      details: { reason: 'OIDC_VERIFY_CONFIG_INVALID' },
    });
    expect(calls).toHaveLength(0);
  });
});

describe('verifyOidcIdToken key set', () => {
  it('loads the key set once and reuses it for the next tokens', async () => {
    const calls = serveProviderKeys();
    const uri = newJwksUri();

    await verifyOidcIdToken(providerToken(), options(uri));
    await verifyOidcIdToken(providerToken({ sub: 'other-user' }), options(uri));

    expect(calls).toHaveLength(1);
  });

  it('loads the key set again when the provider rotated its keys', async () => {
    const uri = newJwksUri();
    let rotated = false;
    const calls = stubFetch(() =>
      jsonResponse({
        keys: rotated
          ? [jwkOf(providerKey.publicKey, 'key-1'), jwkOf(rotatedKey.publicKey, 'key-2')]
          : [jwkOf(providerKey.publicKey, 'key-1')],
      }),
    );

    await verifyOidcIdToken(providerToken(), options(uri));
    rotated = true;
    const payload = await verifyOidcIdToken(signWith(rotatedKey.privateKey, 'key-2'), options(uri));

    expect(payload).toMatchObject({ sub: '1234567890' });
    expect(calls).toHaveLength(2);
  });

  it('loads the key set again after an hour', async () => {
    const calls = serveProviderKeys();
    const uri = newJwksUri();
    const start = Date.now();
    // valid for the whole test, including the jump past the hour
    const token = providerToken({ exp: Math.floor(start / 1000) + 3 * 3600 });

    await verifyOidcIdToken(token, options(uri));
    jest.spyOn(Date, 'now').mockReturnValue(start + 61 * 60 * 1000);
    await verifyOidcIdToken(token, options(uri));

    expect(calls).toHaveLength(2);
  });

  it('rejects a token whose key id the provider does not publish', async () => {
    serveProviderKeys();

    const err = await rejectedBy(() =>
      verifyOidcIdToken(signWith(strangerKey.privateKey, 'unknown-key'), options(newJwksUri())),
    );

    expect(err).toMatchObject({ statusCode: 401, errorCode: 'JWKS_KID_NOT_FOUND' });
  });

  it('rejects the token when the published key is broken', async () => {
    // an rsa key without its modulus and exponent
    stubFetch(() => jsonResponse({ keys: [{ kty: 'RSA', kid: 'key-1' }] }));

    const err = await rejectedBy(() => verifyOidcIdToken(providerToken(), options(newJwksUri())));

    expect(err).toMatchObject({ statusCode: 401, errorCode: 'JWK_TO_KEY_FAILED' });
  });

  it('rejects the token when the provider key set is empty', async () => {
    stubFetch(() => jsonResponse({ keys: [] }));

    const err = await rejectedBy(() => verifyOidcIdToken(providerToken(), options(newJwksUri())));

    expect(err).toMatchObject({ errorCode: 'JWKS_EMPTY' });
  });

  it('fails the login when the key set cannot be loaded', async () => {
    stubFetch(() => textResponse('unavailable', 503));

    const err = await rejectedBy(() => verifyOidcIdToken(providerToken(), options(newJwksUri())));

    expect(err).toMatchObject({ errorCode: 'JWKS_FETCH_FAILED' });
  });

  it('treats an unreadable key set as a server fault', async () => {
    stubFetch(() => textResponse('<html>oops</html>'));

    const err = await rejectedBy(() => verifyOidcIdToken(providerToken(), options(newJwksUri())));

    expect(err).toMatchObject({ statusCode: 500, errorCode: 'INTERNAL_ERROR' });
  });
});
