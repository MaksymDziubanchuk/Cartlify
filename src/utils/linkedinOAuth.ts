import env from '@config/env.js';
import { AppError } from '@utils/errors.js';
import { createPlaceholder, decodePlaceholderInternal } from '@helpers/placeholder.js';
import { b64urlJson, signState } from '@helpers/b64Payload.js';

type StatePayload = {
  guestId: string;
  nonce: string;
  iat: number;
  exp: number;
};

export type LinkedInTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: 'Bearer' | string;

  id_token?: string;
  scope?: string;
};

export type LinkedInIdTokenPayload = {
  // required-ish OIDC claims
  iss: string;
  aud: string | string[];
  sub: string;
  iat: number;
  exp: number;

  // common optional identity claims
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
};

export type LinkedInUserInfoResponse = {
  // OIDC UserInfo
  sub: string;

  // optional identity data
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;

  email?: string;
  email_verified?: boolean;
};

const { LINKEDIN_STATE_SECRET, LINKEDIN_CLIENT_ID, LINKEDIN_REDIRECT_URI, LINKEDIN_CLIENT_SECRET } =
  env;

const LINKEDIN_SCOPE = 'openid profile email';

// build signed callback state
// limits replay window
export function createLinkedInOAuthState(guestId: string) {
  const secret = LINKEDIN_STATE_SECRET;
  if (!secret) throw new AppError('LINKEDIN_STATE_SECRET is missing', 500);

  const now = Math.floor(Date.now() / 1000);

  // bind callback to guest
  const payload: StatePayload = {
    guestId,
    nonce: createPlaceholder(16, 'base64url'),
    iat: now,
    exp: now + 10 * 60,
  };

  // make state tamper-evident
  const payloadB64 = b64urlJson(payload);
  const sig = signState(payloadB64, secret);

  return `${payloadB64}.${sig}`;
}

// build provider redirect url
// includes signed state
export function buildLinkedInAuthUrl(guestId: string) {
  const clientId = LINKEDIN_CLIENT_ID;
  const redirectUri = LINKEDIN_REDIRECT_URI;

  if (!clientId) throw new AppError('LINKEDIN_CLIENT_ID is missing', 500);
  if (!redirectUri) throw new AppError('LINKEDIN_REDIRECT_URI is missing', 500);

  // bind auth start to callback
  const state = createLinkedInOAuthState(guestId);

  const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', LINKEDIN_SCOPE);
  url.searchParams.set('state', state);

  return url.toString();
}

// validate callback state token
// block tamper and replay
export function verifyLinkedInOAuthState(state: string): StatePayload {
  const secret = LINKEDIN_STATE_SECRET;
  if (!secret) throw new AppError('LINKEDIN_STATE_SECRET is missing', 500);

  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) throw new AppError('INVALID_STATE', 500);

  // verify state signature
  const expected = signState(payloadB64, secret);
  if (sig !== expected) throw new AppError('INVALID_PAYLOAD', 500);

  // decode state payload
  const raw = decodePlaceholderInternal(payloadB64, 'base64url').toString('utf8');
  const payload = JSON.parse(raw) as StatePayload;

  const now = Math.floor(Date.now() / 1000);

  // enforce expiry window
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    throw new AppError('LINKEDIN_OAUTH_STATE_EXPIRED', 401);
  }

  // validate issued-at bounds
  if (typeof payload.iat !== 'number') {
    throw new AppError('LINKEDIN_OAUTH_STATE_IAT_INVALID', 401);
  }

  if (payload.iat > now + 30) {
    throw new AppError('LINKEDIN_OAUTH_STATE_IAT_IN_FUTURE', 401);
  }

  if (payload.exp <= payload.iat) {
    throw new AppError('LINKEDIN_OAUTH_STATE_TIME_RANGE_INVALID', 401);
  }

  return payload;
}

// exchange auth code for tokens
// client_secret stays server-side
export async function exchangeLinkedInCodeForTokens(code: string): Promise<LinkedInTokenResponse> {
  const clientId = LINKEDIN_CLIENT_ID;
  const clientSecret = LINKEDIN_CLIENT_SECRET;
  const redirectUri = LINKEDIN_REDIRECT_URI;

  if (!clientId) throw new AppError('LINKEDIN_CLIENT_ID is missing', 500);
  if (!clientSecret) throw new AppError('LINKEDIN_CLIENT_SECRET is missing', 500);
  if (!redirectUri) throw new AppError('LINKEDIN_REDIRECT_URI is missing', 500);

  // build token exchange body
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  // call linkedin token endpoint
  const res = await fetch('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new AppError('LINKEDIN_OAUTH_TOKEN_EXCHANGE_FAILED', 401);
  }

  // parse token response
  const data = JSON.parse(text) as LinkedInTokenResponse;

  // require access token for next step
  if (!data.access_token) throw new AppError('LINKEDIN_OAUTH_NO_ACCESS_TOKEN', 401);

  return data;
}
