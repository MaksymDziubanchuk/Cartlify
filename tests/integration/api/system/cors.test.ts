import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';

// WEB_ORIGIN from tests/setup/integration.setup.ts
const WEB_ORIGIN = 'https://shop.example.com';

let app: FastifyInstance;

beforeAll(async () => {
  app = await startApp();
});

afterAll(async () => {
  await stopApp();
});

describe('CORS', () => {
  it('lets the frontend read an answer and send cookies', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: WEB_ORIGIN },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers.vary).toMatch(/origin/i);
  });

  it('answers the preflight of the frontend', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/favorites/1',
      headers: {
        origin: WEB_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it.each([
    'https://evil.test',
    'https://shop.example.com.evil.test',
    'http://shop.example.com',
    'null',
  ])('gives a page from %s no permission', async (origin) => {
    const res = await app.inject({ method: 'GET', url: '/health', headers: { origin } });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('gives the preflight of a foreign page no permission', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/api/favorites/1',
      headers: {
        origin: 'https://evil.test',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('serves a request without an Origin header as before', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
