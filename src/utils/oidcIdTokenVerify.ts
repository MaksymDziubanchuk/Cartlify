import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

import { AppError } from '@utils/errors.js';

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
  if (!h) throw new AppError('INVALID_ID_TOKEN', 401);

  const raw = b64urlToUtf8(h);
  const header = JSON.parse(raw);

  if (!header.kid) throw new AppError('ID_TOKEN_NO_KID', 401);
  if (!header.alg) throw new AppError('ID_TOKEN_NO_ALG', 401);

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

  const res = await fetch(jwksUri, { method: 'GET', headers: { accept: 'application/json' } });
  const text = await res.text();

  if (!res.ok) throw new AppError('JWKS_FETCH_FAILED', 401);

  const jwks = JSON.parse(text) as Jwks;
  if (!jwks?.keys?.length) throw new AppError('JWKS_EMPTY', 401);

  const keysByKid = new Map<string, Jwk>();
  for (const k of jwks.keys) {
    if (k.kid) keysByKid.set(k.kid, k);
  }

  jwksCache.set(jwksUri, { fetchedAtMs: now, keysByKid });

  const key = keysByKid.get(kid);
  if (!key) throw new AppError('JWKS_KID_NOT_FOUND', 401);

  return key;
}

// convert jwk to key object
// fail closed on errors
function jwkToPublicKey(jwk: Jwk) {
  try {
    return crypto.createPublicKey({ key: jwk as any, format: 'jwk' });
  } catch {
    throw new AppError('JWK_TO_KEY_FAILED', 401);
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

  throw new AppError('ID_TOKEN_VERIFY_FAILED', 401);
}

// validate header and key
// verify signature and claims
export async function verifyOidcIdToken<T>(token: string, opt: VerifyOpts): Promise<T> {
  const header = readJwtHeader(token);

  if (header.alg !== 'RS256') {
    throw new AppError('ID_TOKEN_UNSUPPORTED_ALG', 401);
  }

  const jwk = await getJwkByKid(opt.jwksUri, header.kid);
  const key = jwkToPublicKey(jwk);

  return verifyAgainstIssList<T>(token, key, opt);
}
