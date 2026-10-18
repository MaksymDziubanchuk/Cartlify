import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';

import { startApp, stopApp } from '../../../helpers/app.js';

type Schema = {
  $ref?: string;
  allOf?: Schema[];
  properties?: Record<string, { type?: string; format?: string }>;
};
type Operation = {
  security?: Record<string, string[]>[];
  requestBody?: { content: Record<string, { schema: Schema; example?: unknown }> };
  responses?: Record<string, { content?: Record<string, { example?: unknown }> }>;
};
type Description = { description?: string };
type Document = {
  servers: { url: string }[];
  components: {
    securitySchemes: Record<string, { in: string; name: string }>;
    schemas: Record<string, Schema>;
  };
  paths: Record<string, Record<string, Operation>>;
};

let app: FastifyInstance;
let doc: Document;

const operation = (method: string, path: string): Operation => doc.paths[path]?.[method] ?? {};

// the properties of a schema, references and allOf followed
function propertiesOf(schema: Schema): Record<string, { type?: string; format?: string }> {
  if (schema.$ref) return propertiesOf(doc.components.schemas[schema.$ref.split('/').pop()!]!);

  return {
    ...(schema.properties ?? {}),
    ...Object.assign({}, ...(schema.allOf ?? []).map(propertiesOf)),
  };
}

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
    ['delete', '/api/users/me'],
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

describe('the users routes', () => {
  // an avatar is a file, it travels in a form and not in json
  it('lists the json body and the form of PATCH /api/users/me, the file only in the form', () => {
    const content = operation('patch', '/api/users/me').requestBody!.content;

    expect(Object.keys(content).sort()).toEqual(['application/json', 'multipart/form-data']);
    expect(Object.keys(propertiesOf(content['application/json']!.schema)).sort()).toEqual([
      'locale',
      'name',
      'phone',
    ]);
    const form = propertiesOf(content['multipart/form-data']!.schema);
    expect(Object.keys(form).sort()).toEqual(['avatar', 'locale', 'name', 'phone']);
    expect(form.avatar).toMatchObject({ type: 'string', format: 'binary' });
  });

  it('keeps the example of the json body', () => {
    const json = operation('patch', '/api/users/me').requestBody!.content['application/json'];

    expect(json?.example).toMatchObject({ name: expect.any(String), phone: expect.any(String) });
  });

  // a status a route never sends has no place in its answers
  it.each([
    ['get', '/api/users/me', ['200', '401', '403', '500']],
    ['patch', '/api/users/me', ['200', '400', '401', '403', '404', '413', '500']],
    ['get', '/api/users/{userId}', ['200', '400', '401', '403', '404', '500']],
    ['delete', '/api/users/{userId}', ['200', '400', '401', '403', '404', '409', '500']],
    ['delete', '/api/users/me', ['204', '400', '401', '403', '409', '500']],
  ])('lists only the answers %s %s can give', (method, path, statuses) => {
    expect(Object.keys(operation(method, path).responses ?? {}).sort()).toEqual(statuses);
  });

  // the page needs the code and the size to tell the user what to do
  it('names the code and the size of the answer to a file that is too big', () => {
    const answer = operation('patch', '/api/users/me').responses?.['413'] as
      { description?: string } | undefined;

    expect(answer?.description).toContain('PAYLOAD_TOO_LARGE');
    expect(answer?.description).toContain(`${MAX_UPLOAD_SIZE_BYTES / 1_000_000} MB`);
    const form = operation('patch', '/api/users/me').requestBody!.content['multipart/form-data']!;
    expect(propertiesOf(form.schema).avatar).toMatchObject({
      description: expect.stringContaining(`${MAX_UPLOAD_SIZE_BYTES / 1_000_000} MB`),
    });
  });

  it('shows the answer DELETE /api/users/{userId} really gives as its example', () => {
    const ok = operation('delete', '/api/users/{userId}').responses?.['200'];

    expect(ok?.content?.['application/json']?.example).toEqual({ message: 'user deleted' });
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
