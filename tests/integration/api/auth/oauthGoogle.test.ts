import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { getMe, sessionCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { cookieHeader, cookieJar, setCookies } from '../../../helpers/cookies.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser, uniqueEmail, uniqueTag } from '../../../helpers/factories.js';
import {
  callback,
  craftState,
  FRONTEND_CALLBACK,
  landing,
  oidcProvider,
  signingKey,
  startLogin,
  type IdTokenOptions,
} from '../../../helpers/oauth.js';

let app: FastifyInstance;
const emails: string[] = [];
const google = oidcProvider('google');

// the claims of a google account with a verified email
function account(overrides: Record<string, unknown> = {}) {
  const email = uniqueEmail('google');
  emails.push(email);

  return {
    sub: `google-${uniqueTag()}`,
    email,
    email_verified: true,
    name: 'Goo Test',
    ...overrides,
  };
}

// the whole login: start, google answers with this id_token, callback with the same browser
async function loginWith(claims: Record<string, unknown>, opts: IdTokenOptions = {}) {
  const calls = google.answer(google.idToken(claims, opts));
  const { guestId, state } = await startLogin(app, 'google');
  const res = await callback(
    app,
    'google',
    { code: 'test-code', state },
    cookieHeader({ guestId }),
  );

  return { res, calls };
}

const expectRefused = (res: Parameters<typeof landing>[0], errorCode?: string) => {
  const where = landing(res);
  expect(where.status).toBe(302);
  expect(where.page).toBe(FRONTEND_CALLBACK);
  expect(where.error).toEqual(errorCode ?? expect.any(String));
  expect(setCookies(res).accessToken).toBeUndefined();
};

const userByEmail = (email: string) =>
  asAdmin((tx) =>
    tx.user.findUnique({
      where: { email },
      select: {
        id: true,
        authProvider: true,
        providerSub: true,
        isVerified: true,
        passwordHash: true,
      },
    }),
  );

beforeAll(async () => {
  app = await startApp();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  try {
    const users = await asAdmin((tx) =>
      tx.user.findMany({ where: { email: { in: emails } }, select: { id: true } }),
    );
    await closeSessions(users.map((u) => u.id));
  } finally {
    await stopApp();
  }
});

describe('GET /api/auth/oauth/google', () => {
  it('sends the browser to Google with our app, the scopes and a state', async () => {
    const { guestId, state, location } = await startLogin(app, 'google');

    expect(`${location.origin}${location.pathname}`).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: 'test-google-client.apps.googleusercontent.com',
      redirect_uri: 'https://api.example.com/api/auth/google/callback',
      response_type: 'code',
      scope: 'openid email profile',
    });
    expect(state).not.toBe('');
    expect(guestId).not.toBe('');
  });
});

describe('GET /api/auth/google/callback', () => {
  it('signs a new user in with the verified email from the id_token', async () => {
    const claims = account({ name: 'Goo New' });

    const { res, calls } = await loginWith(claims);

    expect(landing(res)).toEqual({ status: 302, page: FRONTEND_CALLBACK, error: null });
    // our code checked the signature against the published key list
    expect(calls.map((c) => c.url)).toEqual(
      expect.arrayContaining([google.tokenUrl, google.jwksUrl]),
    );
    expect(setCookies(res).guestId?.cleared).toBe(true);

    const me = await getMe(app, sessionCookie(cookieJar(res)));
    expect(me.json()).toMatchObject({ email: claims.email, name: 'Goo New' });
    expect(await userByEmail(claims.email)).toMatchObject({
      authProvider: 'GOOGLE',
      providerSub: claims.sub,
      isVerified: true,
      passwordHash: null,
    });
  });

  // a profile name is at most 100 characters; a long name from the provider must not stop the login
  it('cuts a name over 100 characters instead of refusing the login', async () => {
    const claims = account({ name: 'N'.repeat(150) });

    const { res } = await loginWith(claims);

    expect(landing(res).error).toBeNull();
    const me = await getMe(app, sessionCookie(cookieJar(res)));
    expect(me.json().name).toBe('N'.repeat(100));
  });

  it('sends the code with our app secret and the redirect address to the token endpoint', async () => {
    const { calls } = await loginWith(account());

    const exchange = calls.find((c) => c.url === google.tokenUrl)!;
    expect(exchange.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toMatchObject({
      code: 'test-code',
      client_id: 'test-google-client.apps.googleusercontent.com',
      client_secret: 'test-google-secret',
      redirect_uri: 'https://api.example.com/api/auth/google/callback',
      grant_type: 'authorization_code',
    });
  });

  it('signs a returning user into the same account', async () => {
    const claims = account();
    await loginWith(claims);
    const first = await userByEmail(claims.email);

    const { res } = await loginWith(claims);

    expect((await getMe(app, sessionCookie(cookieJar(res)))).json()).toMatchObject({
      id: first!.id,
    });
  });

  // the sub is the account at google, the email can change there (openid connect: sub and iss
  // identify the user, an email is only a claim)
  it('signs the same google account into the same user after its email changed', async () => {
    const claims = account();
    await loginWith(claims);
    const first = await userByEmail(claims.email);
    const newEmail = uniqueEmail('google-renamed');
    emails.push(newEmail);

    const { res } = await loginWith({ ...claims, email: newEmail });

    expect(landing(res).error).toBeNull();
    // the email we have stays: only root may change one, a new address needs a system function
    expect((await getMe(app, sessionCookie(cookieJar(res)))).json()).toMatchObject({
      id: first!.id,
      email: claims.email,
    });
    expect(await userByEmail(newEmail)).toBeNull();
  });

  it.each([
    ['false', { email_verified: false }],
    ['missing', { email_verified: undefined }],
  ])('refuses an email that google marks as not verified (%s)', async (_case, overrides) => {
    const claims = account(overrides);

    const { res } = await loginWith(claims);

    expectRefused(res, 'GOOGLE_EMAIL_NOT_VERIFIED');
    expect(await userByEmail(claims.email)).toBeNull();
  });

  it.each<[string, IdTokenOptions]>([
    ['issued to another app', { audience: 'another-app.apps.googleusercontent.com' }],
    ['issued by someone else', { issuer: 'https://accounts.example.com' }],
    ['already expired', { expiresIn: -120 }],
    [
      'signed by a key google does not publish',
      { key: signingKey().privateKey, kid: 'unknown-key' },
    ],
    ['signed by another key under the id of the google key', { key: signingKey().privateKey }],
    ['signed with a shared secret instead of a key', { algorithm: 'HS256' }],
  ])('refuses an id_token %s', async (_case, opts) => {
    const claims = account();

    const { res } = await loginWith(claims, opts);

    expectRefused(res);
    expect(await userByEmail(claims.email)).toBeNull();
  });

  it('refuses an email that belongs to a verified local account', async () => {
    const local = await createUser({ email: uniqueEmail('google-local') });
    emails.push(local.email);

    const { res } = await loginWith(account({ email: local.email }));

    expectRefused(res, 'AUTH_PROVIDER_MISMATCH');
  });

  it('takes over an unverified local account with the same email', async () => {
    const local = await createUser({ email: uniqueEmail('google-unclaimed'), isVerified: false });
    emails.push(local.email);

    const { res } = await loginWith(account({ email: local.email }));

    expect(landing(res).error).toBeNull();
    expect(await userByEmail(local.email)).toMatchObject({
      id: local.id,
      authProvider: 'GOOGLE',
      isVerified: true,
      passwordHash: null,
    });
  });

  it('refuses a login started in another browser without redeeming its code', async () => {
    const calls = google.answer(google.idToken(account()));
    const { state } = await startLogin(app, 'google');
    const { guestId: otherBrowser } = await startLogin(app, 'google');

    const res = await callback(
      app,
      'google',
      { code: 'test-code', state },
      cookieHeader({ guestId: otherBrowser }),
    );

    expectRefused(res, 'GOOGLE_OAUTH_STATE_GUEST_MISMATCH');
    expect(calls).toHaveLength(0);
  });

  it('refuses a state that was changed on the way', async () => {
    const calls = google.answer(google.idToken(account()));
    const { guestId, state } = await startLogin(app, 'google');
    const [payload, sig] = state.split('.');

    const res = await callback(
      app,
      'google',
      { code: 'test-code', state: `${payload}x.${sig}` },
      cookieHeader({ guestId }),
    );

    expectRefused(res);
    expect(calls).toHaveLength(0);
  });

  it('refuses a state past its ten minutes', async () => {
    const { guestId } = await startLogin(app, 'google');
    const now = Math.floor(Date.now() / 1000);
    const state = craftState('google', { guestId, nonce: 'n', iat: now - 1200, exp: now - 600 });

    const res = await callback(
      app,
      'google',
      { code: 'test-code', state },
      cookieHeader({ guestId }),
    );

    expectRefused(res, 'GOOGLE_OAUTH_STATE_EXPIRED');
  });

  it('sends the browser back when the user declined at google', async () => {
    const res = await callback(app, 'google', { error: 'access_denied' });

    expectRefused(res, 'OAUTH_ACCESS_DENIED');
  });

  it('refuses a code google does not accept', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"error":"invalid_grant"}', { status: 400 }));
    const { guestId, state } = await startLogin(app, 'google');

    const res = await callback(
      app,
      'google',
      { code: 'used-code', state },
      cookieHeader({ guestId }),
    );

    expectRefused(res, 'GOOGLE_OAUTH_TOKEN_EXCHANGE_FAILED');
  });
});
