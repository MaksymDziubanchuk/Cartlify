import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { InternalError, UnauthorizedError } from '@utils/errors.js';
import { fetchFromProvider } from '@utils/oauthFetch.js';

type Jwk = {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  x5c?: string[];
};

type Jwks = {
  keys: Jwk[];
};

type JwtHeader = {
  kid: string;
  alg: string;
  typ?: string;
};

type VerifyOpts = {
  jwksUri: string;
  issuers: string[];
  audience: string;
  algorithms?: jwt.Algorithm[];
};

// cache jwks by uri
// map keys by kid
const jwksCache = new Map<string, { fetchedAtMs: number; keysByKid: Map<string, Jwk> }>();

// decode base64url to utf8
// used for jwt header only
function b64urlToUtf8(input: string) {
  const b64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  return Buffer.from(b64 + pad, 'base64').toString('utf8');
}

// parse jwt header json
// require kid and alg
function readJwtHeader(token: string): JwtHeader {
  const [h] = token.split('.');
  if (!h) throw new UnauthorizedError('INVALID_ID_TOKEN');

  const raw = b64urlToUtf8(h);
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UnauthorizedError('INVALID_ID_TOKEN', undefined, err);
  }

  // a jwt header is a json object; null, an array, a string or a number is not a token
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new UnauthorizedError('INVALID_ID_TOKEN');
  }

  const header = parsed as Record<string, unknown>;

  if (!header.kid) throw new UnauthorizedError('ID_TOKEN_NO_KID');
  if (!header.alg) throw new UnauthorizedError('ID_TOKEN_NO_ALG');

  return { kid: header.kid, alg: header.alg, typ: header.typ } as JwtHeader;
}

// resolve jwk for kid
// cache jwks responses
async function getJwkByKid(jwksUri: string, kid: string) {
  const ttlMs = 60 * 60 * 1000;
  const now = Date.now();

  const cached = jwksCache.get(jwksUri);
  if (cached && now - cached.fetchedAtMs < ttlMs) {
    const key = cached.keysByKid.get(kid);
    if (key) return key;
  }

  const res = await fetchFromProvider(jwksUri, {
    method: 'GET',
    headers: { accept: 'application/json' },
  });
  const { text } = res;

  if (!res.ok) throw new UnauthorizedError('JWKS_FETCH_FAILED', { status: res.status });

  let jwks: Jwks;

  try {
    jwks = JSON.parse(text) as Jwks;
  } catch (err) {
    throw new InternalError({ reason: 'JWKS_PARSE_FAILED' }, err);
  }

  if (!jwks?.keys?.length) throw new UnauthorizedError('JWKS_EMPTY');

  const keysByKid = new Map<string, Jwk>();
  for (const k of jwks.keys) {
    if (k.kid) keysByKid.set(k.kid, k);
  }

  jwksCache.set(jwksUri, { fetchedAtMs: now, keysByKid });

  const key = keysByKid.get(kid);
  if (!key) throw new UnauthorizedError('JWKS_KID_NOT_FOUND');

  return key;
}

// convert jwk to key object
// fail closed on errors
function jwkToPublicKey(jwk: Jwk) {
  try {
    return crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
  } catch (err) {
    throw new UnauthorizedError('JWK_TO_KEY_FAILED', undefined, err);
  }
}

// verify token against issuers
// accept first valid issuer
function verifyAgainstIssList<T>(token: string, key: crypto.KeyObject, opt: VerifyOpts): T {
  const algs: jwt.Algorithm[] = opt.algorithms ?? ['RS256'];

  for (const iss of opt.issuers) {
    try {
      const payload = jwt.verify(token, key, {
        algorithms: algs,
        issuer: iss,
        audience: opt.audience,
        clockTolerance: 10,
      }) as T;

      return payload;
    } catch {
      continue;
    }
  }

  throw new UnauthorizedError('ID_TOKEN_VERIFY_FAILED');
}

const isBlank = (value: unknown) => typeof value !== 'string' || value.trim() === '';

// fail closed on our own settings: jsonwebtoken skips the aud and iss checks for an empty value,
// so an empty client id would accept a token issued to any app; this is a server fault, so 500
function assertVerifyOpts(opt: VerifyOpts): void {
  if (
    isBlank(opt.jwksUri) ||
    isBlank(opt.audience) ||
    !Array.isArray(opt.issuers) ||
    opt.issuers.length === 0 ||
    opt.issuers.some(isBlank)
  ) {
    throw new InternalError({ reason: 'OIDC_VERIFY_CONFIG_INVALID' });
  }
}

// validate header and key
// verify signature and claims
export async function verifyOidcIdToken<T>(token: string, opt: VerifyOpts): Promise<T> {
  assertVerifyOpts(opt);

  const header = readJwtHeader(token);

  if (header.alg !== 'RS256') {
    throw new UnauthorizedError('ID_TOKEN_UNSUPPORTED_ALG');
  }

  const jwk = await getJwkByKid(opt.jwksUri, header.kid);
  const key = jwkToPublicKey(jwk);

  return verifyAgainstIssList<T>(token, key, opt);
}
