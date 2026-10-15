import fastify, { type FastifyPluginAsync } from 'fastify';
import { afterEach, describe, expect, it } from '@jest/globals';

import requestResponseLogger from '@middlewares/requestResponseLogger.js';
import type { User } from 'types/user.js';

import { importWithEnv } from '../../helpers/freshImport.js';

type LogRecord = Record<string, unknown>;

const apps: Array<ReturnType<typeof fastify>> = [];

// a bare fastify instance with the logger plugin, its log lines land in an array
async function buildApp(plugin: FastifyPluginAsync) {
  const lines: LogRecord[] = [];
  const app = fastify({
    logger: {
      level: 'info',
      stream: { write: (line: string) => lines.push(JSON.parse(line) as LogRecord) },
    },
    disableRequestLogging: true,
  });
  apps.push(app);

  await app.register(plugin);

  // stands in for the auth middleware, which puts the user on every request
  app.addHook('preHandler', async (req) => {
    const header = req.headers['x-test-user'];
    if (typeof header === 'string') req.user = JSON.parse(header) as User;
  });

  app.get('/api/products', async () => ({ ok: true }));
  app.get('/api/auth/verify-email', async () => ({ ok: true }));
  app.get('/api/broken', async () => {
    throw new Error('boom');
  });

  // silent handlers, so every log line comes from the plugin under test
  app.setErrorHandler((_err, _req, reply) => reply.status(500).send({ code: 500 }));
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ code: 404 }));

  await app.ready();

  return { app, lines: () => lines };
}

const asUser = { 'x-test-user': JSON.stringify({ id: 7, role: 'USER' }) };

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('requestResponseLogger outside development', () => {
  it('writes one structured line per response', async () => {
    const { app, lines } = await buildApp(requestResponseLogger);

    await app.inject({ method: 'GET', url: '/api/products', headers: asUser });

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      level: 30,
      reqId: expect.any(String),
      method: 'GET',
      statusCode: 200,
      userId: 7,
      role: 'USER',
      responseTime: expect.any(Number),
    });
    expect(lines()[0]!.responseTime as number).toBeGreaterThanOrEqual(0);
  });

  it('logs the url with its query, so the search and filters stay visible', async () => {
    const { app, lines } = await buildApp(requestResponseLogger);

    await app.inject({ method: 'GET', url: '/api/products?search=phone&limit=20' });

    expect(lines()[0]).toMatchObject({ url: '/api/products?search=phone&limit=20' });
  });

  it('logs failed requests too, with their status', async () => {
    const { app, lines } = await buildApp(requestResponseLogger);

    await app.inject({ method: 'GET', url: '/api/broken' });
    await app.inject({ method: 'GET', url: '/nowhere' });

    expect(lines().map((line) => line.statusCode)).toEqual([500, 404]);
  });

  it('logs a request that has no user without failing', async () => {
    const { app, lines } = await buildApp(requestResponseLogger);

    const res = await app.inject({ method: 'GET', url: '/api/products' });

    expect(res.statusCode).toBe(200);
    expect(lines()).toHaveLength(1);
  });

  // reset password, email verification and the oauth callbacks carry tokens and codes in the query
  it('hides tokens in the query, it may carry them', async () => {
    const { app, lines } = await buildApp(requestResponseLogger);

    await app.inject({ method: 'GET', url: '/api/auth/verify-email?token=secret-token-value' });

    expect(lines()[0]).toMatchObject({ url: '/api/auth/verify-email?token=[hidden]' });
    expect(JSON.stringify(lines())).not.toContain('secret-token-value');
  });
});

describe('requestResponseLogger in development', () => {
  const devPlugin = async () =>
    (
      await importWithEnv<{ default: FastifyPluginAsync }>(
        '@middlewares/requestResponseLogger.js',
        {
          NODE_ENV: 'development',
        },
      )
    ).default;

  it('writes one readable line with method, path, status, user and time', async () => {
    const { app, lines } = await buildApp(await devPlugin());

    await app.inject({ method: 'GET', url: '/api/products', headers: asUser });

    expect(lines()).toHaveLength(1);
    expect(lines()[0]!.msg).toMatch(/GET \/api\/products 200 USER\(id=7\) - \d+ms/);
  });

  it('hides tokens in the query and keeps the other parameters', async () => {
    const { app, lines } = await buildApp(await devPlugin());

    await app.inject({
      method: 'GET',
      url: '/api/auth/google/callback?code=secret-code-value&state=secret-state-value&scope=email',
    });

    expect(lines()[0]!.msg).toContain(
      'GET /api/auth/google/callback?code=[hidden]&state=[hidden]&scope=email 404',
    );
    expect(JSON.stringify(lines())).not.toMatch(/secret-(code|state)-value/);
  });
});
