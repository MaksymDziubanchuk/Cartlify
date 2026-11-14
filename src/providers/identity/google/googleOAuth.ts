import env from '@config/env.js';
import { InternalError, UnauthorizedError } from '@utils/errors.js';
import { fetchFromProvider } from '@providers/identity/providerFetch.js';
import { createOAuthState, verifyOAuthState, type OAuthState } from '@providers/identity/state.js';

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

// the state of a login with Google (state.ts), signed with its own secret
export const createGoogleOAuthState = (
  guestId: string,
  accepted: readonly number[] = [],
  newsletter = false,
) => createOAuthState('google', GOOGLE_STATE_SECRET, guestId, accepted, newsletter);

export const verifyGoogleOAuthState = (state: string, guestId: string): OAuthState =>
  verifyOAuthState('google', GOOGLE_STATE_SECRET, state, guestId);

// build google authorize url
export function buildGoogleAuthUrl(
  guestId: string,
  accepted: readonly number[] = [],
  newsletter = false,
) {
  const clientId = GOOGLE_CLIENT_ID;
  const redirectUri = GOOGLE_REDIRECT_URI;

  if (!clientId) throw new InternalError({ reason: 'OAUTH_CLIENT_ID_MISSING' });
  if (!redirectUri) throw new InternalError({ reason: 'OAUTH_REDIRECT_URI_MISSING' });

  // attach state to redirect
  const state = createGoogleOAuthState(guestId, accepted, newsletter);

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPE);
  url.searchParams.set('state', state);

  return url.toString();
}

// exchange code for tokens
export async function exchangeGoogleCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const clientId = GOOGLE_CLIENT_ID;
  const clientSecret = GOOGLE_CLIENT_SECRET;
  const redirectUri = GOOGLE_REDIRECT_URI;

  if (!clientId) throw new InternalError({ reason: 'OAUTH_CLIENT_ID_MISSING' });
  if (!clientSecret) throw new InternalError({ reason: 'OAUTH_CLIENT_SECRET_MISSING' });
  if (!redirectUri) throw new InternalError({ reason: 'OAUTH_REDIRECT_URI_MISSING' });

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  // call google token endpoint
  const res = await fetchFromProvider('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const { text } = res;
  if (!res.ok) {
    throw new UnauthorizedError('OAUTH_TOKEN_EXCHANGE_FAILED', { status: res.status });
  }

  try {
    return JSON.parse(text) as GoogleTokenResponse;
  } catch (err) {
    throw new InternalError({ reason: 'OAUTH_TOKEN_PARSE_FAILED' }, err);
  }
}
