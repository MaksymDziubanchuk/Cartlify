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

// decode jwt payload part
export function decodeJwtPayload<T>(jwt: string): T {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new AppError('INVALID_GOOGLE_ID_TOKEN', 500);
  return JSON.parse(decodePlaceholderInternal(parts[1], 'base64url').toString('utf8')) as T;
}

// read google oauth env
const { GOOGLE_STATE_SECRET, GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI, GOOGLE_CLIENT_SECRET } = env;

const GOOGLE_SCOPE = 'openid email profile';

// build signed oauth state
export function createGoogleOAuthState(guestId: string) {
  const secret = GOOGLE_STATE_SECRET;
  if (!secret) throw new AppError('GOOGLE_STATE_SECRET is missing', 500);

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

  if (!clientId) throw new AppError('GOOGLE_CLIENT_ID is missing', 500);
  if (!redirectUri) throw new AppError('GOOGLE_REDIRECT_URI is missing', 500);

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
export function verifyGoogleOAuthState(state: string): StatePayload | null {
  const secret = GOOGLE_STATE_SECRET;
  if (!secret) throw new AppError('GOOGLE_STATE_SECRET is missing', 500);

  // split payload and signature
  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) throw new AppError('INVALID_STATE', 500);

  // compare expected signature
  const expected = signState(payloadB64, secret);
  if (sig !== expected) throw new AppError('INVALID_PAYLOAD', 500);

  try {
    // decode state json payload
    const json = decodePlaceholderInternal(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as StatePayload;

    const now = Math.floor(Date.now() / 1000);

    // enforce state expiration
    if (typeof payload.exp !== 'number' || payload.exp < now) {
      throw new AppError('GOOGLE_OAUTH_STATE_EXPIRED', 401);
    }

    if (typeof payload.iat !== 'number') {
      throw new AppError('GOOGLE_OAUTH_STATE_IAT_INVALID', 401);
    }

    if (payload.iat > now + 30) {
      throw new AppError('GOOGLE_OAUTH_STATE_IAT_IN_FUTURE', 401);
    }

    if (payload.exp <= payload.iat) {
      throw new AppError('GOOGLE_OAUTH_STATE_TIME_RANGE_INVALID', 401);
    }

    return payload as StatePayload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Parsing payload failed!', 500);
  }
}

// exchange code for tokens
export async function exchangeGoogleCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const clientId = GOOGLE_CLIENT_ID;
  const clientSecret = GOOGLE_CLIENT_SECRET;
  const redirectUri = GOOGLE_REDIRECT_URI;

  if (!clientId) throw new AppError('GOOGLE_CLIENT_ID is missing', 500);
  if (!clientSecret) throw new AppError('GOOGLE_CLIENT_SECRET is missing', 500);
  if (!redirectUri) throw new AppError('GOOGLE_REDIRECT_URI is missing', 500);

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
    throw new AppError('GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED', 401);
  }

  return JSON.parse(text) as GoogleTokenResponse;
}
