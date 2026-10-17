import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';

import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { jsonResponse, stubFetch, type FetchCall } from '../../../helpers/fetchStub.js';

// WEB_ORIGIN from tests/setup/integration.setup.ts
const FRONTEND_CALLBACK = 'https://shop.example.com/auth/callback';

let app: FastifyInstance;

const run = `${Date.now()}${Math.round(Math.random() * 1e3)}`;
const githubId = Number(run);
const email = `oauth-${run}@example.com`;

const asAdmin = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(async (tx) => {
    await setAdminContext(tx);
    return fn(tx);
  });

// value of a cookie the response sets, '' when it clears it
function setCookie(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const line = [res.headers['set-cookie']]
    .flat()
    .filter(Boolean)
    .map(String)
    .find((cookie) => cookie.startsWith(`${name}=`));

  return line?.split(';')[0]!.slice(name.length + 1);
}

// github as our code meets it: the code exchange, the profile and the email list
function githubAnswers(call: FetchCall): Response {
  if (call.url === 'https://github.com/login/oauth/access_token') {
    return jsonResponse({ access_token: 'gho_test', token_type: 'bearer', scope: 'user:email' });
  }
  if (call.url === 'https://api.github.com/user') {
    return jsonResponse({
      id: githubId,
      login: `octo-${run}`,
      name: 'Octo Test',
      avatar_url: null,
    });
  }
  if (call.url === 'https://api.github.com/user/emails') {
    return jsonResponse([{ email, primary: true, verified: true }]);
  }

  throw new Error(`unexpected request to ${call.url}`);
}

// a browser starting a github login: its guest cookie and the state github would send back
async function startLogin() {
  const res = await app.inject({ method: 'GET', url: '/api/auth/oauth/github' });
  expect(res.statusCode).toBe(302);

  const state = new URL(String(res.headers.location)).searchParams.get('state');
  return { guestId: setCookie(res, 'guestId')!, state: state! };
}

const callback = (query: string, cookie = '') =>
  app.inject({
    method: 'GET',
    url: `/api/auth/github/callback?${query}`,
    headers: cookie ? { cookie } : {},
  });

beforeAll(async () => {
  app = await startApp();
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(async () => {
  // the login log is append-only and only root deletes users, so the user stays; its sessions close
  try {
    await asAdmin((tx) => tx.userToken.deleteMany({ where: { user: { email } } }));
  } finally {
    await stopApp();
  }
});

describe('GET /api/auth/github/callback', () => {
  let accessToken = '';

  it('signs the browser in and sends it to the frontend', async () => {
    const calls = stubFetch(githubAnswers);
    const { guestId, state } = await startLogin();

    const res = await callback(
      `code=test-code&state=${encodeURIComponent(state)}`,
      `guestId=${guestId}`,
    );

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(FRONTEND_CALLBACK);
    expect(calls.map((c) => c.url)).toContain('https://github.com/login/oauth/access_token');

    accessToken = setCookie(res, 'accessToken') ?? '';
    expect(accessToken).not.toBe('');
    expect(setCookie(res, 'refreshToken')).not.toBe('');
    expect(setCookie(res, 'guestId')).toBe('');

    const me = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie: `accessToken=${accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email });
  });

  it.each([
    ['access_denied', 'OAUTH_ACCESS_DENIED'],
    ['temporarily_unavailable', 'OAUTH_CALLBACK_ERROR'],
  ])('sends the browser back with %s from github as %s', async (providerError, errorCode) => {
    const res = await callback(`error=${providerError}`);

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND_CALLBACK}?error=${errorCode}`);
    expect(setCookie(res, 'accessToken')).toBeUndefined();
  });

  it('refuses a login started in another browser without redeeming its code', async () => {
    const calls = stubFetch(githubAnswers);
    const { state } = await startLogin();
    const { guestId: otherBrowser } = await startLogin();

    const res = await callback(
      `code=test-code&state=${encodeURIComponent(state)}`,
      `guestId=${otherBrowser}`,
    );

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `${FRONTEND_CALLBACK}?error=GITHUB_OAUTH_STATE_GUEST_MISMATCH`,
    );
    expect(setCookie(res, 'accessToken')).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('refuses to finish a login for a browser that is already signed in', async () => {
    expect(accessToken).not.toBe('');
    const { state } = await startLogin();

    const res = await callback(
      `code=test-code&state=${encodeURIComponent(state)}`,
      `accessToken=${accessToken}`,
    );

    expect(res.headers.location).toBe(`${FRONTEND_CALLBACK}?error=ALREADY_AUTHENTICATED`);
  });

  it('keeps a server failure out of the address the browser gets', async () => {
    stubFetch(() => {
      throw new TypeError('fetch failed');
    });
    const { guestId, state } = await startLogin();

    const res = await callback(
      `code=test-code&state=${encodeURIComponent(state)}`,
      `guestId=${guestId}`,
    );

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND_CALLBACK}?error=OAUTH_LOGIN_FAILED`);
  });
});
