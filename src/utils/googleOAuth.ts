import env from '@config/env.js';
import { AppError, BadRequestError, InternalError, UnauthorizedError } from '@utils/errors.js';
import { createPlaceholder, decodePlaceholderInternal } from '@helpers/placeholder.js';
import { b64urlJson, signState } from '@helpers/b64Payload.js';

type StatePayload = {
  guestId: string;
  nonce: string;
  iat: number;
  exp: number;
};

type GoogleTokenResponse = {
  access_token: string;
  expires_in: number;
  token_type: 'Bearer';
  scope?: string;
  refresh_token?: string;
  id_token: string;
};

export type GoogleIdTokenPayload = {
  iss: string;
  aud: string;
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  iat: number;
  exp: number;
};

// read google oauth env
const { GOOGLE_STATE_SECRET, GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI, GOOGLE_CLIENT_SECRET } = env;

const GOOGLE_SCOPE = 'openid email profile';

// build signed oauth state
export function createGoogleOAuthState(guestId: string) {
  const secret = GOOGLE_STATE_SECRET;
  if (!secret) throw new InternalError({ reason: 'GOOGLE_STATE_SECRET_MISSING' });

  const now = Math.floor(Date.now() / 1000);

  // short-lived state payload
  const payload: StatePayload = {
    guestId,
    nonce: createPlaceholder(16, 'base64url'),
    iat: now,
    exp: now + 10 * 60,
  };

  // sign state for tamper check
  const payloadB64 = b64urlJson(payload);
  const sig = signState(payloadB64, secret);

  return `${payloadB64}.${sig}`;
}

// build google authorize url
export function buildGoogleAuthUrl(guestId: string) {
  const clientId = GOOGLE_CLIENT_ID;
  const redirectUri = GOOGLE_REDIRECT_URI;

  if (!clientId) throw new InternalError({ reason: 'GOOGLE_CLIENT_ID_MISSING' });
  if (!redirectUri) throw new InternalError({ reason: 'GOOGLE_REDIRECT_URI_MISSING' });

  // attach state to redirect
  const state = createGoogleOAuthState(guestId);

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPE);
  url.searchParams.set('state', state);

  return url.toString();
}

// verify oauth state signature
export function verifyGoogleOAuthState(state: string): StatePayload {
  const secret = GOOGLE_STATE_SECRET;
  if (!secret) throw new InternalError({ reason: 'GOOGLE_STATE_SECRET_MISSING' });

  // split payload and signature
  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) throw new BadRequestError('INVALID_STATE');

  // compare expected signature
  const expected = signState(payloadB64, secret);
  if (sig !== expected) throw new BadRequestError('INVALID_PAYLOAD');

  try {
    // decode state json payload
    const json = decodePlaceholderInternal(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as StatePayload;

    const now = Math.floor(Date.now() / 1000);

    // enforce state expiration
    if (typeof payload.exp !== 'number' || payload.exp < now) {
      throw new UnauthorizedError('GOOGLE_OAUTH_STATE_EXPIRED');
    }

    if (typeof payload.iat !== 'number') {
      throw new UnauthorizedError('GOOGLE_OAUTH_STATE_IAT_INVALID');
    }

    if (payload.iat > now + 30) {
      throw new UnauthorizedError('GOOGLE_OAUTH_STATE_IAT_IN_FUTURE');
    }

    if (payload.exp <= payload.iat) {
      throw new UnauthorizedError('GOOGLE_OAUTH_STATE_TIME_RANGE_INVALID');
    }

    return payload as StatePayload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new InternalError({ reason: 'GOOGLE_OAUTH_STATE_PARSE_FAILED' }, err);
  }
}

// exchange code for tokens
export async function exchangeGoogleCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const clientId = GOOGLE_CLIENT_ID;
  const clientSecret = GOOGLE_CLIENT_SECRET;
  const redirectUri = GOOGLE_REDIRECT_URI;

  if (!clientId) throw new InternalError({ reason: 'GOOGLE_CLIENT_ID_MISSING' });
  if (!clientSecret) throw new InternalError({ reason: 'GOOGLE_CLIENT_SECRET_MISSING' });
  if (!redirectUri) throw new InternalError({ reason: 'GOOGLE_REDIRECT_URI_MISSING' });

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  // call google token endpoint
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new UnauthorizedError('GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED', { status: res.status });
  }

  try {
    return JSON.parse(text) as GoogleTokenResponse;
  } catch (err) {
    throw new InternalError({ reason: 'GOOGLE_OAUTH_TOKEN_PARSE_FAILED' }, err);
  }
}
