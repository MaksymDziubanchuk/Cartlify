import { createHmac, randomBytes } from 'node:crypto';
import env from '../config/env.js';
import { AppError } from './errors.js';

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

function b64url(input: Buffer | string) {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function b64urlJson(obj: unknown) {
  return b64url(JSON.stringify(obj));
}

function b64urlDecodeToString(input: string) {
  const pad = '='.repeat((4 - (input.length % 4)) % 4);
  const b64 = (input + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

function signState(payloadB64: string, secret: string) {
  return b64url(createHmac('sha256', secret).update(payloadB64).digest());
}

export function decodeJwtPayload<T>(jwt: string): T {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new AppError('INVALID_GOOGLE_ID_TOKEN', 500);
  return JSON.parse(b64urlDecodeToString(parts[1])) as T;
}

const { GOOGLE_STATE_SECRET, GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI, GOOGLE_CLIENT_SECRET } = env;

export function createGoogleOAuthState(guestId: string) {
  const secret = GOOGLE_STATE_SECRET;
  if (!secret) throw new AppError('GOOGLE_STATE_SECRET is missing', 500);

  const now = Math.floor(Date.now() / 1000);

  const payload: StatePayload = {
    guestId,
    nonce: b64url(randomBytes(16)),
    iat: now,
    exp: now + 10 * 60,
  };

  const payloadB64 = b64urlJson(payload);
  const sig = signState(payloadB64, secret);

  return `${payloadB64}.${sig}`;
}

export function buildGoogleAuthUrl(guestId: string) {
  const clientId = GOOGLE_CLIENT_ID;
  const redirectUri = GOOGLE_REDIRECT_URI;

  if (!clientId) throw new AppError('GOOGLE_CLIENT_ID is missing', 500);
  if (!redirectUri) throw new AppError('GOOGLE_REDIRECT_URI is missing', 500);

  const state = createGoogleOAuthState(guestId);

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);

  return url.toString();
}

export function verifyGoogleOAuthState(state: string): StatePayload | null {
  const secret = GOOGLE_STATE_SECRET;
  if (!secret) throw new AppError('GOOGLE_STATE_SECRET is missing', 500);

  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) throw new AppError('INVALID_STATE', 500);

  const expected = signState(payloadB64, secret);
  if (sig !== expected) throw new AppError('INVALID_PAYLOAD', 500);

  try {
    const json = Buffer.from(
      payloadB64.replaceAll('-', '+').replaceAll('_', '/'),
      'base64',
    ).toString('utf8');
    return JSON.parse(json) as StatePayload;
  } catch {
    throw new AppError('Parsing payload failed!', 500);
  }
}

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

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    console.log('[GOOGLE_TOKEN_EXCHANGE_FAIL]', { status: res.status, body: text });
    throw new AppError('GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED', 401);
  }

  return JSON.parse(text) as GoogleTokenResponse;
}
