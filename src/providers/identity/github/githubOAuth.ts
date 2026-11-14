import env from '@config/env.js';
import { InternalError, UnauthorizedError } from '@utils/errors.js';
import { fetchFromProvider } from '@providers/identity/providerFetch.js';
import { createOAuthState, verifyOAuthState, type OAuthState } from '@providers/identity/state.js';

type GithubTokenError = {
  error: string;
  error_description?: string;
  error_uri?: string;
};

export type GithubTokenResponse = {
  access_token: string;
  token_type: string;
  scope?: string;
};

export type GithubUserResponse = {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  email?: string | null;
  locale?: string | null;
};

export type GithubEmailItem = {
  email: string;
  primary: boolean;
  verified: boolean;
  visibility?: string | null;
};

const { GITHUB_STATE_SECRET, GITHUB_CLIENT_ID, GITHUB_REDIRECT_URI, GITHUB_CLIENT_SECRET } = env;

const GITHUB_SCOPE = 'read:user user:email';

// read a github json answer: one that is not a json object is a server fault, not a refused login
function parseGithubJson<T extends object>(text: string, reason: string): T {
  let data: unknown;

  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new InternalError({ reason }, err);
  }

  if (typeof data !== 'object' || data === null) throw new InternalError({ reason });

  return data as T;
}

// the state of a login with GitHub (state.ts), signed with its own secret
export const createGithubOAuthState = (
  guestId: string,
  accepted: readonly number[] = [],
  newsletter = false,
) => createOAuthState('github', GITHUB_STATE_SECRET, guestId, accepted, newsletter);

export const verifyGithubOAuthState = (state: string, guestId: string): OAuthState =>
  verifyOAuthState('github', GITHUB_STATE_SECRET, state, guestId);

// build github authorize url
export function buildGithubAuthUrl(
  guestId: string,
  accepted: readonly number[] = [],
  newsletter = false,
) {
  const clientId = GITHUB_CLIENT_ID;
  const redirectUri = GITHUB_REDIRECT_URI;

  if (!clientId) throw new InternalError({ reason: 'OAUTH_CLIENT_ID_MISSING' });
  if (!redirectUri) throw new InternalError({ reason: 'OAUTH_REDIRECT_URI_MISSING' });

  // attach state to redirect
  const state = createGithubOAuthState(guestId, accepted, newsletter);

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', GITHUB_SCOPE);
  url.searchParams.set('state', state);

  return url.toString();
}

// exchange code for access token
export async function exchangeGithubCodeForTokens(
  code: string,
  state?: string,
): Promise<GithubTokenResponse> {
  const clientId = GITHUB_CLIENT_ID;
  const clientSecret = GITHUB_CLIENT_SECRET;
  const redirectUri = GITHUB_REDIRECT_URI;

  if (!clientId) throw new InternalError({ reason: 'OAUTH_CLIENT_ID_MISSING' });
  if (!clientSecret) throw new InternalError({ reason: 'OAUTH_CLIENT_SECRET_MISSING' });
  if (!redirectUri) throw new InternalError({ reason: 'OAUTH_REDIRECT_URI_MISSING' });

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    ...(state ? { state } : {}),
  });

  // call github token endpoint
  const res = await fetchFromProvider('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });

  const { text } = res;
  if (!res.ok) {
    throw new UnauthorizedError('OAUTH_TOKEN_EXCHANGE_FAILED', { status: res.status });
  }

  // parse token response union
  const data = parseGithubJson<GithubTokenResponse | GithubTokenError>(
    text,
    'OAUTH_TOKEN_PARSE_FAILED',
  );

  // github answers a refused code with 200 and an error field, its code tells why
  if ('error' in data) {
    throw new UnauthorizedError('OAUTH_TOKEN_EXCHANGE_FAILED', {
      providerError: data.error,
    });
  }

  if (!data.access_token) throw new UnauthorizedError('OAUTH_NO_ACCESS_TOKEN');

  return data;
}

// fetch github user profile
export async function fetchGithubUser(accessToken: string): Promise<GithubUserResponse> {
  const res = await fetchFromProvider('https://api.github.com/user', {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'cartlify',
    },
  });

  const { text } = res;
  if (!res.ok) {
    throw new UnauthorizedError('OAUTH_FETCH_USER_FAILED', { status: res.status });
  }

  return parseGithubJson<GithubUserResponse>(text, 'OAUTH_USER_PARSE_FAILED');
}

// fetch github email list
export async function fetchGithubEmails(accessToken: string): Promise<GithubEmailItem[]> {
  const res = await fetchFromProvider('https://api.github.com/user/emails', {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'cartlify',
    },
  });

  const { text } = res;
  if (!res.ok) {
    throw new UnauthorizedError('OAUTH_FETCH_EMAILS_FAILED', { status: res.status });
  }

  const data = parseGithubJson<GithubEmailItem[]>(text, 'OAUTH_EMAILS_PARSE_FAILED');
  return Array.isArray(data) ? data : [];
}

// choose best verified email
export function pickBestGithubEmail(user: GithubUserResponse, emails: GithubEmailItem[]) {
  const primaryVerified = emails.find((e) => e.primary && e.verified)?.email;
  if (primaryVerified) return primaryVerified;

  const anyVerified = emails.find((e) => e.verified)?.email;
  if (anyVerified) return anyVerified;

  const profileEmail = user.email?.trim().toLowerCase();
  if (profileEmail) return profileEmail;

  return null;
}
