import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { startApp, stopApp } from '../../../helpers/app.js';

type Operation = { security?: Record<string, string[]>[] };
type Description = { description?: string };
type Document = {
  servers: { url: string }[];
  components: { securitySchemes: Record<string, { in: string; name: string }> };
  paths: Record<string, Record<string, Operation>>;
};

let app: FastifyInstance;
let doc: Document;

const operation = (method: string, path: string) => doc.paths[path]?.[method] ?? {};

beforeAll(async () => {
  app = await startApp();
  doc = (await app.inject({ method: 'GET', url: '/documentation/json' })).json();
});

afterAll(async () => {
  await stopApp();
});

describe('GET /documentation/json', () => {
  // another server would be another origin: cors and the cookies would not let requests through
  it('sends Swagger UI requests to the server it is served from', () => {
    expect(doc.servers).toEqual([expect.objectContaining({ url: '/' })]);
  });

  it('describes the csrf header', () => {
    expect(doc.components.securitySchemes.csrfTokenHeader).toMatchObject({
      in: 'header',
      name: 'x-csrf-token',
    });
  });

  it.each([
    ['post', '/api/auth/login'],
    ['post', '/api/auth/refresh'],
    ['delete', '/api/favorites/{productId}'],
    ['patch', '/api/users/me'],
  ])('asks the csrf header of %s %s', (method, path) => {
    const security = operation(method, path).security ?? [];

    expect(security.length).toBeGreaterThan(0);
    for (const requirement of security) expect(requirement).toHaveProperty('csrfTokenHeader');
  });

  it('lists the csrf refusal among the answers of a route that changes data', () => {
    const login = doc.paths['/api/auth/login']?.post as { responses: Record<string, Description> };
    const refresh = doc.paths['/api/auth/refresh']?.post as {
      responses: Record<string, Description>;
    };

    expect(login.responses['403']?.description).toContain('CSRF_TOKEN_INVALID');
    // a route with 403 reasons of its own keeps them
    expect(refresh.responses['403']?.description).toContain('REFRESH_TOKEN_REUSE_DETECTED');
    expect(refresh.responses['403']?.description).toContain('CSRF_TOKEN_INVALID');
  });

  it('keeps the cookie a route needs next to the csrf header', () => {
    expect(operation('post', '/api/auth/refresh').security).toEqual([
      { refreshTokenCookie: [], csrfTokenHeader: [] },
    ]);
  });

  it.each([
    ['get', '/api/favorites'],
    ['get', '/api/auth/csrf'],
    ['post', '/api/payments/webhook'],
  ])('asks no csrf header of %s %s', (method, path) => {
    const security = operation(method, path).security ?? [];

    for (const requirement of security) expect(requirement).not.toHaveProperty('csrfTokenHeader');
  });
});

describe('Swagger UI', () => {
  it('takes a csrf token before a request that changes data', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/documentation/static/swagger-initializer.js',
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('requestInterceptor');
    expect(res.body).toContain('/api/auth/csrf');
    expect(res.body).toContain('x-csrf-token');
  });
});
