import env from '@config/env.js';
import { InternalError, UnauthorizedError } from '@utils/errors.js';
import { fetchFromProvider } from '@providers/identity/providerFetch.js';
import { createOAuthState, verifyOAuthState, type OAuthState } from '@providers/identity/state.js';

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
  // a boolean, a string "true" is accepted as well
  email_verified?: boolean | string;
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
// the state of a login with LinkedIn (state.ts), signed with its own secret
export const createLinkedInOAuthState = (
  guestId: string,
  accepted: readonly number[] = [],
  newsletter = false,
) => createOAuthState('linkedin', LINKEDIN_STATE_SECRET, guestId, accepted, newsletter);

export const verifyLinkedInOAuthState = (state: string, guestId: string): OAuthState =>
  verifyOAuthState('linkedin', LINKEDIN_STATE_SECRET, state, guestId);

// build provider redirect url
// includes signed state
export function buildLinkedInAuthUrl(
  guestId: string,
  accepted: readonly number[] = [],
  newsletter = false,
) {
  const clientId = LINKEDIN_CLIENT_ID;
  const redirectUri = LINKEDIN_REDIRECT_URI;

  if (!clientId) throw new InternalError({ reason: 'OAUTH_CLIENT_ID_MISSING' });
  if (!redirectUri) throw new InternalError({ reason: 'OAUTH_REDIRECT_URI_MISSING' });

  // bind auth start to callback
  const state = createLinkedInOAuthState(guestId, accepted, newsletter);

  const url = new URL('https://www.linkedin.com/oauth/v2/authorization');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', LINKEDIN_SCOPE);
  url.searchParams.set('state', state);

  return url.toString();
}

// validate callback state token

// exchange auth code for tokens
// client_secret stays server-side
export async function exchangeLinkedInCodeForTokens(code: string): Promise<LinkedInTokenResponse> {
  const clientId = LINKEDIN_CLIENT_ID;
  const clientSecret = LINKEDIN_CLIENT_SECRET;
  const redirectUri = LINKEDIN_REDIRECT_URI;

  if (!clientId) throw new InternalError({ reason: 'OAUTH_CLIENT_ID_MISSING' });
  if (!clientSecret) throw new InternalError({ reason: 'OAUTH_CLIENT_SECRET_MISSING' });
  if (!redirectUri) throw new InternalError({ reason: 'OAUTH_REDIRECT_URI_MISSING' });

  // build token exchange body
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  // call linkedin token endpoint
  const res = await fetchFromProvider('https://www.linkedin.com/oauth/v2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });

  const { text } = res;

  if (!res.ok) {
    throw new UnauthorizedError('OAUTH_TOKEN_EXCHANGE_FAILED', {
      status: res.status,
    });
  }

  // parse token response
  let data: LinkedInTokenResponse;

  try {
    data = JSON.parse(text) as LinkedInTokenResponse;
  } catch (err) {
    throw new InternalError({ reason: 'OAUTH_TOKEN_PARSE_FAILED' }, err);
  }

  // require access token for next step
  if (!data.access_token) throw new UnauthorizedError('OAUTH_NO_ACCESS_TOKEN');

  return data;
}
