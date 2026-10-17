import fastify from 'fastify';
import { fastifyCookie } from '@fastify/cookie';
import { describe, expect, it } from '@jest/globals';

import { importWithEnv } from '../../helpers/freshImport.js';

type CsrfPlugin = typeof import('../../../src/plugins/csrf.plugin.js');

// plugins have no path alias; importWithEnv resolves the path from tests/helpers
const load = (nodeEnv: string) =>
  importWithEnv<CsrfPlugin>('../../src/plugins/csrf.plugin.js', { NODE_ENV: nodeEnv });

// a bare fastify with the cookie parser and the plugin, the way app.ts registers them
async function appWith(plugin: CsrfPlugin) {
  const app = fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(plugin.default);

  app.get('/token', async (_req, reply) => ({ csrfToken: reply.generateCsrf() }));
  app.post('/change', async () => ({ ok: true }));
  app.post('/signed-elsewhere', { config: { csrf: false } }, async () => ({ ok: true }));

  await app.ready();
  return app;
}

describe('requiresCsrfToken', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post'])('asks a token of %s', async (method) => {
    const { requiresCsrfToken } = await load('test');

    expect(requiresCsrfToken(method)).toBe(true);
    expect(requiresCsrfToken(method, {})).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('asks no token of %s, it only reads', async (method) => {
    const { requiresCsrfToken } = await load('test');

    expect(requiresCsrfToken(method)).toBe(false);
  });

  it('lets a route opt out with config.csrf false', async () => {
    const { requiresCsrfToken } = await load('test');

    expect(requiresCsrfToken('POST', { csrf: false })).toBe(false);
    expect(requiresCsrfToken('POST', { csrf: true })).toBe(true);
  });
});

describe('csrf cookie', () => {
  it('is named csrf outside production', async () => {
    const { CSRF_COOKIE } = await load('development');

    expect(CSRF_COOKIE).toBe('csrf');
  });

  // a sibling subdomain cannot set a __Host- cookie, so it cannot plant a secret it knows
  it('is a __Host- cookie in production with everything the prefix demands', async () => {
    const plugin = await load('production');
    const app = await appWith(plugin);

    const res = await app.inject({ method: 'GET', url: '/token' });
    const cookie = String([res.headers['set-cookie']].flat()[0]);

    expect(plugin.CSRF_COOKIE).toBe('__Host-csrf');
    expect(cookie).toMatch(/^__Host-csrf=[^;]+/);
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/; Path=\//i);
    expect(cookie).not.toMatch(/; Domain=/i);

    await app.close();
  });
});

describe('csrf check', () => {
  it('refuses a request that changes data without a token, lets one with it through', async () => {
    const app = await appWith(await load('test'));
    const tokenRes = await app.inject({ method: 'GET', url: '/token' });
    const cookie = String([tokenRes.headers['set-cookie']].flat()[0]).split(';')[0]!;

    const refused = await app.inject({ method: 'POST', url: '/change', headers: { cookie } });
    const passed = await app.inject({
      method: 'POST',
      url: '/change',
      headers: { cookie, 'x-csrf-token': tokenRes.json().csrfToken },
    });

    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'FST_CSRF_INVALID_TOKEN' });
    expect(passed.statusCode).toBe(200);

    await app.close();
  });

  it('reads the token from the header only, not from the body', async () => {
    const app = await appWith(await load('test'));
    const tokenRes = await app.inject({ method: 'GET', url: '/token' });
    const cookie = String([tokenRes.headers['set-cookie']].flat()[0]).split(';')[0]!;

    const res = await app.inject({
      method: 'POST',
      url: '/change',
      headers: { cookie },
      payload: { _csrf: tokenRes.json().csrfToken },
    });

    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('skips a route that opts out', async () => {
    const app = await appWith(await load('test'));

    const res = await app.inject({ method: 'POST', url: '/signed-elsewhere' });

    expect(res.statusCode).toBe(200);

    await app.close();
  });
});
