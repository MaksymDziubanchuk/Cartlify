import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { getMe, sessionCookie } from '../../../helpers/actors.js';
import { startApp, stopApp } from '../../../helpers/app.js';
import { takeLogs } from '../../../helpers/logs.js';
import { cookieHeader, cookieJar, setCookies } from '../../../helpers/cookies.js';
import { asAdmin } from '../../../helpers/db.js';
import { closeSessions, createUser, uniqueEmail, uniqueTag } from '../../../helpers/factories.js';
import {
  callback,
  FRONTEND_CALLBACK,
  landing,
  oidcProvider,
  signingKey,
  startLogin,
  type IdTokenOptions,
} from '../../../helpers/oauth.js';

let app: FastifyInstance;
const emails: string[] = [];
const linkedin = oidcProvider('linkedin');

// the claims of a linkedin account with a verified email
function account(overrides: Record<string, unknown> = {}) {
  const email = uniqueEmail('linkedin');
  emails.push(email);

  return {
    sub: `linkedin-${uniqueTag()}`,
    email,
    email_verified: true,
    name: 'Link Test',
    ...overrides,
  };
}

async function loginWith(claims: Record<string, unknown>, opts: IdTokenOptions = {}) {
  const calls = linkedin.answer(linkedin.idToken(claims, opts));
  const { guestId, state } = await startLogin(app, 'linkedin');
  const res = await callback(
    app,
    'linkedin',
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
      select: { id: true, authProvider: true, providerSub: true, isVerified: true },
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

describe('GET /api/auth/oauth/linkedin', () => {
  it('sends the browser to LinkedIn with our app, the scopes and a state', async () => {
    const { guestId, state, location } = await startLogin(app, 'linkedin');

    expect(`${location.origin}${location.pathname}`).toBe(
      'https://www.linkedin.com/oauth/v2/authorization',
    );
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      client_id: 'test-linkedin-client',
      redirect_uri: 'https://api.example.com/api/auth/linkedin/callback',
      response_type: 'code',
      scope: 'openid profile email',
    });
    expect(state).not.toBe('');
    expect(guestId).not.toBe('');
  });
});

describe('GET /api/auth/linkedin/callback', () => {
  it('signs a new user in with the verified email from the id_token', async () => {
    const claims = account({ name: 'Link New' });

    const { res, calls } = await loginWith(claims);

    expect(landing(res)).toEqual({ status: 302, page: FRONTEND_CALLBACK, error: null });
    expect(calls.map((c) => c.url)).toEqual(
      expect.arrayContaining([linkedin.tokenUrl, linkedin.jwksUrl]),
    );

    const me = await getMe(app, sessionCookie(cookieJar(res)));
    expect(me.json()).toMatchObject({ email: claims.email, name: 'Link New' });
    expect(await userByEmail(claims.email)).toMatchObject({
      authProvider: 'LINKEDIN',
      providerSub: claims.sub,
      isVerified: true,
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

  // the sub is the account at linkedin, the email can change there
  it('signs the same linkedin account into the same user after its email changed', async () => {
    const claims = account();
    await loginWith(claims);
    const first = await userByEmail(claims.email);
    const newEmail = uniqueEmail('linkedin-renamed');
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

  it('accepts the verification claim sent as the string "true"', async () => {
    const claims = account({ email_verified: 'true' });

    const { res } = await loginWith(claims);

    expect(landing(res).error).toBeNull();
    expect(await userByEmail(claims.email)).toMatchObject({ isVerified: true });
  });

  it.each([
    ['false', false],
    ['the string "false"', 'false'],
    ['missing', undefined],
  ])('refuses an email whose verification linkedin states as %s', async (_case, value) => {
    const claims = account({ email_verified: value });

    const { res } = await loginWith(claims);

    expectRefused(res, 'LINKEDIN_EMAIL_NOT_VERIFIED');
    expect(await userByEmail(claims.email)).toBeNull();
  });

  // without the claim nobody vouches for the email: it must not count as proven,
  // or it could take over an unverified local account with that email
  it('does not trust an email whose verification linkedin does not state', async () => {
    const local = await createUser({ email: uniqueEmail('linkedin-unclaimed'), isVerified: false });
    emails.push(local.email);

    const { res } = await loginWith(account({ email: local.email, email_verified: undefined }));

    expectRefused(res, 'LINKEDIN_EMAIL_NOT_VERIFIED');
    expect(await userByEmail(local.email)).toMatchObject({
      authProvider: 'LOCAL',
      isVerified: false,
    });
  });

  it.each<[string, IdTokenOptions]>([
    ['issued to another app', { audience: 'another-app' }],
    ['issued by someone else', { issuer: 'https://www.linkedin.example.com/oauth' }],
    ['already expired', { expiresIn: -120 }],
    [
      'signed by a key linkedin does not publish',
      { key: signingKey().privateKey, kid: 'unknown-key' },
    ],
    ['signed by another key under the id of the linkedin key', { key: signingKey().privateKey }],
  ])('refuses an id_token %s', async (_case, opts) => {
    const claims = account();

    const { res } = await loginWith(claims, opts);

    expectRefused(res);
    expect(await userByEmail(claims.email)).toBeNull();
  });

  it('refuses an email that belongs to a verified local account', async () => {
    const local = await createUser({ email: uniqueEmail('linkedin-local') });
    emails.push(local.email);

    const { res } = await loginWith(account({ email: local.email }));

    expectRefused(res, 'AUTH_PROVIDER_MISMATCH');
  });

  it('refuses a login started in another browser without redeeming its code', async () => {
    const calls = linkedin.answer(linkedin.idToken(account()));
    const { state } = await startLogin(app, 'linkedin');
    const { guestId: otherBrowser } = await startLogin(app, 'linkedin');

    const res = await callback(
      app,
      'linkedin',
      { code: 'test-code', state },
      cookieHeader({ guestId: otherBrowser }),
    );

    expectRefused(res, 'LINKEDIN_OAUTH_STATE_GUEST_MISMATCH');
    expect(calls).toHaveLength(0);
  });

  // linkedin names a refusal its own way, the frontend has to see the same code as for google
  it.each(['user_cancelled_login', 'user_cancelled_authorize'])(
    'treats %s from linkedin as the user declining',
    async (providerError) => {
      const res = await callback(app, 'linkedin', { error: providerError });

      expectRefused(res, 'OAUTH_ACCESS_DENIED');
    },
  );

  it('sends the browser back with any other linkedin error', async () => {
    const res = await callback(app, 'linkedin', { error: 'server_error' });

    expectRefused(res, 'OAUTH_CALLBACK_ERROR');
  });

  // LinkedIn out of reach, or silent for 5 seconds: the page says to try again, not that it failed
  it('sends the browser back with OAUTH_PROVIDER_UNAVAILABLE when LinkedIn cannot be reached', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const { guestId, state } = await startLogin(app, 'linkedin');

    const res = await callback(
      app,
      'linkedin',
      { code: 'any-code', state },
      cookieHeader({ guestId }),
    );

    expectRefused(res, 'OAUTH_PROVIDER_UNAVAILABLE');
    expect(takeLogs({ msg: 'oauth provider unavailable' })).toEqual([
      expect.objectContaining({ errorCode: 'OAUTH_PROVIDER_UNAVAILABLE' }),
    ]);
  });
});
