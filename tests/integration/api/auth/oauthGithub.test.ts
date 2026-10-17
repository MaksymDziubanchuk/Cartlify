import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { getMe, sessionCookie, signIn } from '../../../helpers/actors.js';
import { startApp, stopApp, withoutErrorLog } from '../../../helpers/app.js';
import { cookieHeader, cookieJar, setCookies } from '../../../helpers/cookies.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';
import { asAdmin } from '../../../helpers/db.js';
import {
  closeSessions,
  createProduct,
  createUser,
  removeProducts,
  uniqueEmail,
  type TestProduct,
} from '../../../helpers/factories.js';
import {
  answerAsGithub,
  callback,
  craftState,
  FRONTEND_CALLBACK,
  landing,
  startLogin,
  type GithubAccount,
} from '../../../helpers/oauth.js';

let app: FastifyInstance;
let csrf: Csrf;
const emails: string[] = [];
const products: TestProduct[] = [];
let nextGithubId = Number(`${Date.now()}`.slice(-9));

// a github account with one verified primary email
function account(overrides: Partial<GithubAccount> = {}): GithubAccount & { email: string } {
  const email = uniqueEmail('github');
  emails.push(email);

  return {
    id: ++nextGithubId,
    name: 'Octo Test',
    emails: [{ email, primary: true, verified: true }],
    ...overrides,
    email: overrides.email ?? email,
  };
}

// the whole login: start, github answers, callback with the browser that started it
async function loginWith(gh: GithubAccount, cookie = '') {
  answerAsGithub(gh);
  const { guestId, state } = await startLogin(app, 'github', cookie);

  return callback(app, 'github', { code: 'test-code', state }, cookie || cookieHeader({ guestId }));
}

const expectRefused = (res: Parameters<typeof landing>[0], errorCode?: string) => {
  const where = landing(res);
  expect(where.status).toBe(302);
  expect(where.page).toBe(FRONTEND_CALLBACK);
  expect(where.error).toEqual(errorCode ?? expect.any(String));
  expect(setCookies(res as never).accessToken).toBeUndefined();
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
        name: true,
      },
    }),
  );

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
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
    await removeProducts(products);
  } finally {
    await stopApp();
  }
});

describe('GET /api/auth/oauth/github', () => {
  it('sends the browser to GitHub with our app, the scopes and a state', async () => {
    const { guestId, state, location } = await startLogin(app, 'github');

    expect(`${location.origin}${location.pathname}`).toBe(
      'https://github.com/login/oauth/authorize',
    );
    expect(location.searchParams.get('client_id')).toBe('test-github-client');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/api/auth/github/callback',
    );
    expect(location.searchParams.get('scope')).toBe('read:user user:email');
    expect(state).not.toBe('');
    // the state is bound to this browser, so it gets its guest cookie here
    expect(guestId).not.toBe('');
  });

  it('refuses a browser that is already signed in', async () => {
    const user = await createUser({ email: uniqueEmail('github-signed-in') });
    emails.push(user.email);
    const session = await signIn(app, csrf, user);

    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/oauth/github',
      headers: { cookie: sessionCookie(session) },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ errorCode: 'ALREADY_AUTHENTICATED' });
  });
});

describe('GET /api/auth/github/callback', () => {
  it('signs a new user in and sends the browser to the frontend', async () => {
    const gh = account({ name: 'Octo New' });

    const res = await loginWith(gh);

    expect(landing(res)).toEqual({ status: 302, page: FRONTEND_CALLBACK, error: null });
    const cookies = setCookies(res);
    expect(cookies.accessToken?.cleared).toBe(false);
    expect(cookies.refreshToken?.cleared).toBe(false);
    expect(cookies.guestId?.cleared).toBe(true);
    // an oauth login keeps the session as long as rememberMe does
    expect(cookies.refreshToken?.maxAge).toBe(2592000);

    const me = await getMe(app, sessionCookie(cookieJar(res)));
    expect(me.json()).toMatchObject({ email: gh.email, name: 'Octo New' });
    expect(await userByEmail(gh.email)).toMatchObject({
      authProvider: 'GITHUB',
      providerSub: String(gh.id),
      isVerified: true,
      passwordHash: null,
    });
  });

  // a profile name is at most 100 characters; a long name from the provider must not stop the login
  it('cuts a name over 100 characters instead of refusing the login', async () => {
    const gh = account({ name: 'N'.repeat(150) });

    const res = await loginWith(gh);

    expect(landing(res).error).toBeNull();
    const me = await getMe(app, sessionCookie(cookieJar(res)));
    expect(me.json().name).toBe('N'.repeat(100));
  });

  it('signs a returning user into the same account', async () => {
    const gh = account();
    await loginWith(gh);
    const first = await userByEmail(gh.email);

    const res = await loginWith(gh);

    expect(landing(res).error).toBeNull();
    expect((await getMe(app, sessionCookie(cookieJar(res)))).json()).toMatchObject({
      id: first!.id,
    });
  });

  // github keeps the account id, the email can change there
  it('signs the same github account into the same user after its email changed', async () => {
    const gh = account();
    await loginWith(gh);
    const first = await userByEmail(gh.email);
    const newEmail = uniqueEmail('github-renamed');
    emails.push(newEmail);

    const res = await loginWith({
      ...gh,
      emails: [{ email: newEmail, primary: true, verified: true }],
    });

    expect(landing(res).error).toBeNull();
    // the email we have stays: only root may change one, a new address needs a system function
    expect((await getMe(app, sessionCookie(cookieJar(res)))).json()).toMatchObject({
      id: first!.id,
      email: gh.email,
    });
    expect(await userByEmail(newEmail)).toBeNull();
  });

  it('takes the verified primary email when github lists several', async () => {
    const primary = uniqueEmail('github-primary');
    const other = uniqueEmail('github-other');
    emails.push(primary, other);

    const res = await loginWith(
      account({
        emails: [
          { email: other, primary: false, verified: true },
          { email: primary, primary: true, verified: true },
        ],
      }),
    );

    expect((await getMe(app, sessionCookie(cookieJar(res)))).json()).toMatchObject({
      email: primary,
    });
  });

  it('refuses an account without a verified email', async () => {
    const email = uniqueEmail('github-unverified');
    emails.push(email);

    const res = await loginWith(account({ emails: [{ email, primary: true, verified: false }] }));

    expectRefused(res, 'GITHUB_EMAIL_NOT_VERIFIED');
    expect(await userByEmail(email)).toBeNull();
  });

  it('refuses an email that belongs to a verified local account', async () => {
    const local = await createUser({ email: uniqueEmail('github-local') });
    emails.push(local.email);

    const res = await loginWith(
      account({ emails: [{ email: local.email, primary: true, verified: true }] }),
    );

    expectRefused(res, 'AUTH_PROVIDER_MISMATCH');
    expect(await userByEmail(local.email)).toMatchObject({ authProvider: 'LOCAL' });
  });

  // someone registered the email without proving it; the owner proves it through github
  it('takes over an unverified local account with the same email', async () => {
    const local = await createUser({ email: uniqueEmail('github-unclaimed'), isVerified: false });
    emails.push(local.email);

    const res = await loginWith(
      account({ emails: [{ email: local.email, primary: true, verified: true }] }),
    );

    expect(landing(res).error).toBeNull();
    expect(await userByEmail(local.email)).toMatchObject({
      id: local.id,
      authProvider: 'GITHUB',
      isVerified: true,
      passwordHash: null,
    });
  });

  it('moves the favorites of the guest to the account', async () => {
    const product = await createProduct();
    products.push(product);
    const added = await app.inject({
      method: 'POST',
      url: `/api/favorites/${product.id}`,
      headers: withCsrf(csrf),
    });
    const guest = cookieHeader({ guestId: cookieJar(added).guestId });
    const gh = account();

    await loginWith(gh, guest);

    const user = await userByEmail(gh.email);
    const favorites = await asAdmin((tx) =>
      tx.favorite.findMany({ where: { productId: product.id }, select: { userId: true } }),
    );
    expect(favorites).toEqual([{ userId: user!.id }]);
  });

  it.each([
    ['access_denied', 'OAUTH_ACCESS_DENIED'],
    ['temporarily_unavailable', 'OAUTH_CALLBACK_ERROR'],
  ])('sends the browser back with %s from github as %s', async (providerError, errorCode) => {
    const res = await callback(app, 'github', { error: providerError, state: 'any' });

    expectRefused(res, errorCode);
  });

  it('refuses a login started in another browser without redeeming its code', async () => {
    const calls = answerAsGithub(account());
    const { state } = await startLogin(app, 'github');
    const { guestId: otherBrowser } = await startLogin(app, 'github');

    const res = await callback(
      app,
      'github',
      { code: 'test-code', state },
      cookieHeader({ guestId: otherBrowser }),
    );

    expectRefused(res, 'GITHUB_OAUTH_STATE_GUEST_MISMATCH');
    expect(calls).toHaveLength(0);
  });

  it('refuses a state that was changed on the way', async () => {
    const calls = answerAsGithub(account());
    const { guestId, state } = await startLogin(app, 'github');
    const [payload, sig] = state.split('.');
    const forged = `${payload}x.${sig}`;

    const res = await callback(
      app,
      'github',
      { code: 'test-code', state: forged },
      cookieHeader({ guestId }),
    );

    expectRefused(res);
    expect(calls).toHaveLength(0);
  });

  it('refuses a state past its ten minutes', async () => {
    const { guestId } = await startLogin(app, 'github');
    const now = Math.floor(Date.now() / 1000);
    const state = craftState('github', { guestId, nonce: 'n', iat: now - 1200, exp: now - 600 });

    const res = await callback(
      app,
      'github',
      { code: 'test-code', state },
      cookieHeader({ guestId }),
    );

    expectRefused(res, 'GITHUB_OAUTH_STATE_EXPIRED');
  });

  it('refuses to finish a login for a browser that is already signed in', async () => {
    const user = await createUser({ email: uniqueEmail('github-already') });
    emails.push(user.email);
    const session = await signIn(app, csrf, user);
    const { state } = await startLogin(app, 'github');

    const res = await callback(app, 'github', { code: 'test-code', state }, sessionCookie(session));

    expectRefused(res, 'ALREADY_AUTHENTICATED');
  });

  it('keeps a server failure out of the address the browser gets', async () => {
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    const { guestId, state } = await startLogin(app, 'github');

    // the failure is on purpose, its error line stays out of the output
    const res = await withoutErrorLog(() =>
      callback(app, 'github', { code: 'test-code', state }, cookieHeader({ guestId })),
    );

    expectRefused(res, 'OAUTH_LOGIN_FAILED');
  });
});
