import type { FastifyInstance } from 'fastify';
import type { Prisma } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { prisma } from '@db/client.js';
import { setAdminContext } from '@db/dbContext.service.js';
import { hashPass } from '@helpers/safePass.js';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';

const PASSWORD = 'password123';

let app: FastifyInstance;
let csrf: Csrf;
let userId: number;
let email: string;

const asAdmin = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(async (tx) => {
    await setAdminContext(tx);
    return fn(tx);
  });

type SetCookie = { name: string; value: string; cleared: boolean };

// the cookies a response sets; a cleared one comes back empty and already expired
function setCookies(res: { headers: Record<string, unknown> }): Record<string, SetCookie> {
  const lines = [res.headers['set-cookie']].flat().filter(Boolean).map(String);

  return Object.fromEntries(
    lines.map((line) => {
      const [pair, ...attrs] = line.split(';').map((part) => part.trim());
      const name = pair!.slice(0, pair!.indexOf('='));
      const value = pair!.slice(pair!.indexOf('=') + 1);
      const cleared =
        value === '' || attrs.some((a) => /^max-age=0$/i.test(a) || /^expires=.*1970/i.test(a));

      return [name, { name, value, cleared }];
    }),
  );
}

const cookieHeader = (cookies: Record<string, string>) =>
  Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

async function login() {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: withCsrf(csrf),
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);

  const cookies = setCookies(res);
  return { accessToken: cookies.accessToken!.value, refreshToken: cookies.refreshToken!.value };
}

const refresh = (cookies: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/refresh',
    headers: withCsrf(csrf, cookieHeader(cookies)),
  });

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);

  email = `refresh-${Date.now()}-${Math.round(Math.random() * 1e6)}@example.com`;
  const passwordHash = await hashPass(PASSWORD);

  ({ id: userId } = await asAdmin((tx) =>
    tx.user.create({ data: { email, passwordHash, isVerified: true }, select: { id: true } }),
  ));
});

afterAll(async () => {
  // the login log is append-only and only root deletes users, so a user that has logged in
  // stays (its email is unique to the run); its sessions are closed
  try {
    await asAdmin((tx) => tx.userToken.deleteMany({ where: { userId } }));
  } finally {
    await stopApp();
  }
});

describe('POST /api/auth/refresh', () => {
  // the browser drops the access cookie when it expires, the usual moment the frontend refreshes
  it('sets new access and refresh cookies when the access cookie has expired', async () => {
    const { refreshToken } = await login();

    const res = await refresh({ refreshToken });

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const cookies = setCookies(res);
    expect(cookies.accessToken?.cleared).toBe(false);
    expect(cookies.refreshToken?.cleared).toBe(false);
    expect(cookies.refreshToken?.value).not.toBe(refreshToken);

    // the new access cookie is enough to reach a page for signed-in users
    const me = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie: cookieHeader({ accessToken: cookies.accessToken!.value }) },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: userId });
  });

  it('rotates both tokens when the access cookie is still valid', async () => {
    const tokens = await login();

    const res = await refresh(tokens);

    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');

    const cookies = setCookies(res);
    expect(cookies.accessToken?.cleared).toBe(false);
    expect(cookies.refreshToken?.value).not.toBe(tokens.refreshToken);
  });

  it('keeps the access token out of the response body', async () => {
    const { refreshToken } = await login();

    const res = await refresh({ refreshToken });

    expect(res.body).not.toContain(setCookies(res).accessToken?.value ?? 'no access cookie');
    expect(res.headers['content-type']).toBeUndefined();
  });

  it('answers 400 without a refresh cookie', async () => {
    const res = await refresh({});

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'REFRESH_TOKEN_REQUIRED' });
  });

  it('answers 401 and clears both cookies when the refresh token is not valid', async () => {
    const res = await refresh({ refreshToken: 'not-a-jwt' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ errorCode: 'REFRESH_TOKEN_INVALID' });

    const cookies = setCookies(res);
    expect(cookies.accessToken?.cleared).toBe(true);
    expect(cookies.refreshToken?.cleared).toBe(true);
  });

  // a used refresh token coming back means it was copied: every session of the user is closed
  it('revokes every session when an already used refresh token comes back', async () => {
    const { refreshToken: first } = await login();

    const rotated = await refresh({ refreshToken: first });
    expect(rotated.statusCode).toBe(204);
    const second = setCookies(rotated).refreshToken!.value;

    const reused = await refresh({ refreshToken: first });
    expect(reused.statusCode).toBe(403);
    expect(reused.json()).toMatchObject({ errorCode: 'REFRESH_TOKEN_REUSE_DETECTED' });

    // the token the rightful owner got is closed as well
    const afterReuse = await refresh({ refreshToken: second });
    expect(afterReuse.statusCode).toBe(403);

    const open = await asAdmin((tx) =>
      tx.userToken.count({ where: { userId, type: 'REFRESH_TOKEN', usedAt: null } }),
    );
    expect(open).toBe(0);
  });

  // the session deadline lives in the database, the token itself may still look valid
  it('refuses a token past its session deadline and keeps it marked as used', async () => {
    const { refreshToken } = await login();
    const row = await asAdmin((tx) =>
      tx.userToken.findFirstOrThrow({
        where: { userId, type: 'REFRESH_TOKEN', usedAt: null },
        orderBy: { id: 'desc' },
        select: { id: true },
      }),
    );
    await asAdmin((tx) =>
      tx.userToken.update({
        where: { id: row.id },
        // a session that ended a second ago; the row may not expire before it was created
        data: {
          createdAt: new Date(Date.now() - 3_600_000),
          expiresAt: new Date(Date.now() - 1000),
        },
      }),
    );

    const res = await refresh({ refreshToken });

    expect(res.statusCode).toBe(401);
    expect(setCookies(res).refreshToken?.cleared).toBe(true);

    const stored = await asAdmin((tx) =>
      tx.userToken.findUniqueOrThrow({ where: { id: row.id }, select: { usedAt: true } }),
    );
    expect(stored.usedAt).not.toBeNull();
  });
});
