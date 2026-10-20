import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';
import { getCsrf, withCsrf, type Csrf } from '../../../helpers/csrf.js';

let app: FastifyInstance;
let csrf: Csrf;

// a login for nobody: 401 from the handler means the csrf check let the request through
const login = (headers: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers,
    payload: { email: 'nobody@example.com', password: 'password123' },
  });

const expectRefused = (res: { statusCode: number; json: () => unknown }) => {
  expect(res.statusCode).toBe(403);
  expect(res.json()).toMatchObject({ code: 403, errorCode: 'CSRF_TOKEN_INVALID' });
};

beforeAll(async () => {
  app = await startApp();
  csrf = await getCsrf(app);
});

afterAll(async () => {
  await stopApp();
});

describe('GET /api/auth/csrf', () => {
  it('gives a token and keeps its secret in an httpOnly lax cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/csrf' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ csrfToken: expect.any(String) });
    expect(res.headers['cache-control']).toBe('no-store');

    const cookie = String([res.headers['set-cookie']].flat()[0]);
    expect(cookie).toMatch(/^csrf=[^;]+/);
    expect(cookie).toMatch(/; HttpOnly/i);
    expect(cookie).toMatch(/; SameSite=Lax/i);
    expect(cookie).toMatch(/; Path=\//i);
  });

  it('keeps the secret of a browser that already has one, every token of it works', async () => {
    const again = await app.inject({
      method: 'GET',
      url: '/api/auth/csrf',
      headers: { cookie: csrf.cookie },
    });

    expect(again.headers['set-cookie']).toBeUndefined();

    const second = { ...csrf, token: again.json().csrfToken };
    expect(second.token).not.toBe(csrf.token);
    expect((await login(withCsrf(csrf))).statusCode).toBe(401);
    expect((await login(withCsrf(second))).statusCode).toBe(401);
  });
});

describe('csrf check', () => {
  it('lets a request with the token and its cookie reach the handler', async () => {
    expect((await login(withCsrf(csrf))).statusCode).toBe(401);
  });

  // a forged form or fetch from another site has no token: the handler never runs
  it('refuses a request without the token', async () => {
    expectRefused(await login({ cookie: csrf.cookie }));
  });

  it('refuses a token without its secret cookie', async () => {
    expectRefused(await login({ 'x-csrf-token': csrf.token }));
  });

  it('refuses a token of another browser', async () => {
    const other = await getCsrf(app);

    expectRefused(await login({ cookie: csrf.cookie, 'x-csrf-token': other.token }));
  });

  it('refuses a made-up token', async () => {
    expectRefused(await login(withCsrf({ ...csrf, token: 'not-a-token' })));
  });

  it.each([
    ['DELETE', '/api/favorites/1'],
    ['PATCH', '/api/users/me'],
  ])('checks %s requests as well', async (method, url) => {
    expectRefused(await app.inject({ method: method as 'DELETE' | 'PATCH', url, payload: {} }));

    const res = await app.inject({
      method: method as 'DELETE' | 'PATCH',
      url,
      headers: withCsrf(csrf),
      payload: {},
    });
    expect(res.json()).not.toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
  });

  it('lets reading requests through without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/favorites' });

    expect(res.statusCode).toBe(200);
  });

  // stripe calls the webhook server to server and signs it, there is no token to send
  it('leaves the stripe webhook to its own signature check', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/payments/stripe/webhook',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).not.toMatchObject({ errorCode: 'CSRF_TOKEN_INVALID' });
  });

  it('keeps 404 for a route that does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/no-such-route' });

    expect(res.statusCode).toBe(404);
  });
});
