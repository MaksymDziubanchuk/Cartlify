import env from '@config/env.js';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  InternalError,
  UnauthorizedError,
} from '@utils/errors.js';
import { createPlaceholder, decodePlaceholderInternal } from '@helpers/placeholder.js';
import { b64urlJson, signState } from '@helpers/b64Payload.js';
import { fetchFromProvider } from '@utils/oauthFetch.js';

type StatePayload = {
  guestId: string;
  nonce: string;
  iat: number;
  exp: number;
  // the versions of the terms and of the contract the page of the shop sent with the start:
  // an account this login makes takes the consent to them
  accepted?: number[];
};

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

// build signed oauth state
export function createGithubOAuthState(guestId: string, accepted: readonly number[] = []) {
  const secret = GITHUB_STATE_SECRET;
  if (!secret) throw new InternalError({ reason: 'GITHUB_STATE_SECRET_MISSING' });

  const now = Math.floor(Date.now() / 1000);

  // short-lived state window
  const payload: StatePayload = {
    guestId,
    nonce: createPlaceholder(16, 'base64url'),
    iat: now,
    exp: now + 10 * 60,
    ...(accepted.length ? { accepted: [...accepted] } : {}),
  };

  // sign state for tamper check
  const payloadB64 = b64urlJson(payload);
  const sig = signState(payloadB64, secret);

  return `${payloadB64}.${sig}`;
}

// build github authorize url
export function buildGithubAuthUrl(guestId: string, accepted: readonly number[] = []) {
  const clientId = GITHUB_CLIENT_ID;
  const redirectUri = GITHUB_REDIRECT_URI;

  if (!clientId) throw new InternalError({ reason: 'GITHUB_CLIENT_ID_MISSING' });
  if (!redirectUri) throw new InternalError({ reason: 'GITHUB_REDIRECT_URI_MISSING' });

  // attach state to redirect
  const state = createGithubOAuthState(guestId, accepted);

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', GITHUB_SCOPE);
  url.searchParams.set('state', state);

  return url.toString();
}

// verify oauth state signature, time window and the guest who finishes the login
export function verifyGithubOAuthState(state: string, guestId: string): StatePayload {
  const secret = GITHUB_STATE_SECRET;
  if (!secret) throw new InternalError({ reason: 'GITHUB_STATE_SECRET_MISSING' });

  // split payload and signature
  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) throw new BadRequestError('INVALID_STATE');

  // compare expected signature
  const expected = signState(payloadB64, secret);
  if (sig !== expected) throw new BadRequestError('INVALID_PAYLOAD');

  try {
    // decode signed state payload
    const json = decodePlaceholderInternal(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as StatePayload;

    const now = Math.floor(Date.now() / 1000);

    // enforce state expiration
    if (typeof payload.exp !== 'number' || payload.exp < now) {
      throw new UnauthorizedError('GITHUB_OAUTH_STATE_EXPIRED');
    }

    if (typeof payload.iat !== 'number') {
      throw new UnauthorizedError('GITHUB_OAUTH_STATE_IAT_INVALID');
    }

    if (payload.iat > now + 30) {
      throw new UnauthorizedError('GITHUB_OAUTH_STATE_IAT_IN_FUTURE');
    }

    if (payload.exp <= payload.iat) {
      throw new UnauthorizedError('GITHUB_OAUTH_STATE_TIME_RANGE_INVALID');
    }

    // the login was started by another guest, in another browser: finishing it here
    // would sign this browser into someone else's account (login csrf)
    if (payload.guestId !== guestId) {
      throw new ForbiddenError('GITHUB_OAUTH_STATE_GUEST_MISMATCH');
    }

    return payload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new InternalError({ reason: 'GITHUB_OAUTH_STATE_PARSE_FAILED' }, err);
  }
}

// exchange code for access token
export async function exchangeGithubCodeForTokens(
  code: string,
  state?: string,
): Promise<GithubTokenResponse> {
  const clientId = GITHUB_CLIENT_ID;
  const clientSecret = GITHUB_CLIENT_SECRET;
  const redirectUri = GITHUB_REDIRECT_URI;

  if (!clientId) throw new InternalError({ reason: 'GITHUB_CLIENT_ID_MISSING' });
  if (!clientSecret) throw new InternalError({ reason: 'GITHUB_CLIENT_SECRET_MISSING' });
  if (!redirectUri) throw new InternalError({ reason: 'GITHUB_REDIRECT_URI_MISSING' });

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
    throw new UnauthorizedError('GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED', { status: res.status });
  }

  // parse token response union
  const data = parseGithubJson<GithubTokenResponse | GithubTokenError>(
    text,
    'GITHUB_OAUTH_TOKEN_PARSE_FAILED',
  );

  // github answers a refused code with 200 and an error field, its code tells why
  if ('error' in data) {
    throw new UnauthorizedError('GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED', {
      providerError: data.error,
    });
  }

  if (!data.access_token) throw new UnauthorizedError('GITHUB_OAUTH_NO_ACCESS_TOKEN');

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
    throw new UnauthorizedError('GITHUB_OAUTH_FETCH_USER_FAILED', { status: res.status });
  }

  return parseGithubJson<GithubUserResponse>(text, 'GITHUB_OAUTH_USER_PARSE_FAILED');
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
    throw new UnauthorizedError('GITHUB_OAUTH_FETCH_EMAILS_FAILED', { status: res.status });
  }

  const data = parseGithubJson<GithubEmailItem[]>(text, 'GITHUB_OAUTH_EMAILS_PARSE_FAILED');
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
