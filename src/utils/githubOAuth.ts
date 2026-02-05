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

// build signed oauth state
export function createGithubOAuthState(guestId: string) {
  const secret = GITHUB_STATE_SECRET;
  if (!secret) throw new AppError('GITHUB_STATE_SECRET is missing', 500);

  const now = Math.floor(Date.now() / 1000);

  // short-lived state window
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

// build github authorize url
export function buildGithubAuthUrl(guestId: string) {
  const clientId = GITHUB_CLIENT_ID;
  const redirectUri = GITHUB_REDIRECT_URI;

  if (!clientId) throw new AppError('GITHUB_CLIENT_ID is missing', 500);
  if (!redirectUri) throw new AppError('GITHUB_REDIRECT_URI is missing', 500);

  // attach state to redirect
  const state = createGithubOAuthState(guestId);

  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', GITHUB_SCOPE);
  url.searchParams.set('state', state);

  return url.toString();
}

// verify oauth state signature
export function verifyGithubOAuthState(state: string): StatePayload | null {
  const secret = GITHUB_STATE_SECRET;
  if (!secret) throw new AppError('GITHUB_STATE_SECRET is missing', 500);

  // split payload and signature
  const [payloadB64, sig] = state.split('.');
  if (!payloadB64 || !sig) throw new AppError('INVALID_STATE', 500);

  // compare expected signature
  const expected = signState(payloadB64, secret);
  if (sig !== expected) throw new AppError('INVALID_PAYLOAD', 500);

  try {
    // decode signed state payload
    const json = decodePlaceholderInternal(payloadB64, 'base64url').toString('utf8');
    const payload = JSON.parse(json) as StatePayload;

    const now = Math.floor(Date.now() / 1000);

    // enforce state expiration
    if (typeof payload.exp !== 'number' || payload.exp < now) {
      throw new AppError('GITHUB_OAUTH_STATE_EXPIRED', 401);
    }

    if (typeof payload.iat !== 'number') {
      throw new AppError('GITHUB_OAUTH_STATE_IAT_INVALID', 401);
    }

    if (payload.iat > now + 30) {
      throw new AppError('GITHUB_OAUTH_STATE_IAT_IN_FUTURE', 401);
    }

    if (payload.exp <= payload.iat) {
      throw new AppError('GITHUB_OAUTH_STATE_TIME_RANGE_INVALID', 401);
    }

    return payload;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('Parsing payload failed!', 500);
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

  if (!clientId) throw new AppError('GITHUB_CLIENT_ID is missing', 500);
  if (!clientSecret) throw new AppError('GITHUB_CLIENT_SECRET is missing', 500);
  if (!redirectUri) throw new AppError('GITHUB_REDIRECT_URI is missing', 500);

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    ...(state ? { state } : {}),
  });

  // call github token endpoint
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new AppError('GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED', 401);
  }

  // parse token response union
  const data = JSON.parse(text) as GithubTokenResponse | GithubTokenError;

  // surface oauth error response
  if ('error' in data) {
    throw new AppError(
      data.error_description ?? data.error ?? 'GITHUB_OAUTH_TOKEN_EXCHANGE_FAILED',
      401,
    );
  }

  if (!data.access_token) throw new AppError('GITHUB_OAUTH_NO_ACCESS_TOKEN', 401);

  return data;
}

// fetch github user profile
export async function fetchGithubUser(accessToken: string): Promise<GithubUserResponse> {
  const res = await fetch('https://api.github.com/user', {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'cartlify',
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new AppError('GITHUB_OAUTH_FETCH_USER_FAILED', 401);
  }

  return JSON.parse(text) as GithubUserResponse;
}

// fetch github email list
export async function fetchGithubEmails(accessToken: string): Promise<GithubEmailItem[]> {
  const res = await fetch('https://api.github.com/user/emails', {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'cartlify',
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new AppError('GITHUB_OAUTH_FETCH_EMAILS_FAILED', 401);
  }

  const data = JSON.parse(text) as GithubEmailItem[];
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
