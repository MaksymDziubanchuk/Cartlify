import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';

import { b64urlJson, signState } from '@helpers/b64Payload.js';

import { setCookies } from './cookies.js';
import { jsonResponse, stubFetch, type FetchCall } from './fetchStub.js';

// the oauth providers answer our server here, our own login code runs for real: the made-up apps
// of tests/setup/integration.setup.ts, the provider answers, and for Google and LinkedIn a key
// that signs the id_token and is published as the provider's key list, so the signature check
// in oidcIdTokenVerify.ts works the way it does against the real providers

export type Provider = 'google' | 'github' | 'linkedin';

// the pictures of the accounts at the provider, by the address the server asks: an answer for each
// call, a Response is read once
export type Pictures = Record<string, (call: FetchCall) => Response | Promise<Response>>;

// the frontend page every callback sends the browser to (WEB_ORIGIN from the setup)
export const FRONTEND_CALLBACK = 'https://shop.example.com/auth/callback';

const STATE_SECRETS: Record<Provider, string> = {
  google: 'test-google-state-secret',
  github: 'test-github-state-secret',
  linkedin: 'test-linkedin-state-secret',
};

const OIDC = {
  google: {
    issuer: 'https://accounts.google.com',
    audience: 'test-google-client.apps.googleusercontent.com',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs',
  },
  linkedin: {
    issuer: 'https://www.linkedin.com/oauth',
    audience: 'test-linkedin-client',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    jwksUrl: 'https://www.linkedin.com/oauth/openid/jwks',
  },
} as const;

export type SigningKey = { privateKey: KeyObject; kid: string; jwk: Record<string, unknown> };

// a key like the ones the providers sign with
export function signingKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = randomUUID();

  return {
    privateKey,
    kid,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, use: 'sig', alg: 'RS256' },
  };
}

export type IdTokenOptions = {
  // another key or another key id: a token the provider never signed
  key?: KeyObject;
  kid?: string;
  audience?: string;
  issuer?: string;
  // seconds from now; negative for a token that has already expired
  expiresIn?: number;
  algorithm?: 'RS256' | 'HS256';
};

// Google or LinkedIn: an id_token signed with the provider key, and the provider answers
export function oidcProvider(name: 'google' | 'linkedin') {
  const { issuer, audience, tokenUrl, jwksUrl } = OIDC[name];
  const key = signingKey();

  function idToken(claims: Record<string, unknown>, opts: IdTokenOptions = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: opts.issuer ?? issuer,
      aud: opts.audience ?? audience,
      iat: now,
      exp: now + (opts.expiresIn ?? 600),
      ...claims,
    };

    if (opts.algorithm === 'HS256') {
      return jwt.sign(payload, 'a-shared-secret', { algorithm: 'HS256', keyid: key.kid });
    }

    return jwt.sign(payload, opts.key ?? key.privateKey, {
      algorithm: 'RS256',
      keyid: opts.kid ?? key.kid,
    });
  }

  // the code exchange gives this id_token, the key list holds the provider key
  function answer(token: string, pictures: Pictures = {}) {
    return stubFetch((call) => {
      const picture = pictures[call.url];
      if (picture) return picture(call);
      if (call.url === tokenUrl) {
        return jsonResponse({
          access_token: `${name}-access-token`,
          token_type: 'Bearer',
          expires_in: 3600,
          id_token: token,
        });
      }
      if (call.url === jwksUrl) return jsonResponse({ keys: [key.jwk] });

      throw new Error(`unexpected request to ${call.url}`);
    });
  }

  return { idToken, answer, tokenUrl, jwksUrl };
}

export type GithubAccount = {
  id: number;
  login?: string;
  name?: string | null;
  avatar_url?: string | null;
  email?: string | null;
  emails: { email: string; primary: boolean; verified: boolean }[];
};

// GitHub: the code exchange, the profile and the email list
export function answerAsGithub(account: GithubAccount, pictures: Pictures = {}) {
  return stubFetch((call) => {
    const picture = pictures[call.url];
    if (picture) return picture(call);
    if (call.url === 'https://github.com/login/oauth/access_token') {
      return jsonResponse({ access_token: 'gho_test', token_type: 'bearer', scope: 'user:email' });
    }
    if (call.url === 'https://api.github.com/user') {
      return jsonResponse({
        id: account.id,
        login: account.login ?? `octo-${account.id}`,
        name: account.name ?? null,
        avatar_url: account.avatar_url ?? null,
        email: account.email ?? null,
      });
    }
    if (call.url === 'https://api.github.com/user/emails') return jsonResponse(account.emails);

    throw new Error(`unexpected request to ${call.url}`);
  });
}

// a browser starting a login: its guest cookie and the state the provider would send back
export async function startLogin(app: FastifyInstance, provider: Provider, cookie = '') {
  const res = await app.inject({
    method: 'GET',
    url: `/api/auth/oauth/${provider}`,
    headers: cookie ? { cookie } : {},
  });
  if (res.statusCode !== 302) throw new Error(`login start answered ${res.statusCode}`);

  const location = new URL(String(res.headers.location));
  const guestId = setCookies(res).guestId?.value ?? /guestId=([^;]+)/.exec(cookie)?.[1] ?? '';

  return { guestId, state: location.searchParams.get('state') ?? '', location };
}

// the provider sending the browser back to our callback
export const callback = (
  app: FastifyInstance,
  provider: Provider,
  query: Record<string, string>,
  cookie = '',
) =>
  app.inject({
    method: 'GET',
    url: `/api/auth/${provider}/callback?${new URLSearchParams(query)}`,
    headers: cookie ? { cookie } : {},
  });

// a state signed with our own secret, with fields of the test's choosing
export function craftState(provider: Provider, payload: Record<string, unknown>): string {
  const payloadB64 = b64urlJson(payload);
  return `${payloadB64}.${signState(payloadB64, STATE_SECRETS[provider])}`;
}

// where the callback sent the browser: the frontend page and the error it carries
export function landing(res: { statusCode: number; headers: Record<string, unknown> }) {
  const location = new URL(String(res.headers.location ?? 'about:blank'));

  return {
    status: res.statusCode,
    page: `${location.origin}${location.pathname}`,
    error: location.searchParams.get('error'),
  };
}
