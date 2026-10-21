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
  parameters?: { in: string; name: string; required?: boolean }[];
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
    ['post', '/api/payments/stripe/webhook'],
  ])('asks no csrf header of %s %s', (method, path) => {
    const security = operation(method, path).security ?? [];

    for (const requirement of security) expect(requirement).not.toHaveProperty('csrfTokenHeader');
  });
});

describe('the users routes', () => {
  // an avatar is a file, it travels in a form; json has only the empty avatar that removes one
  it('lists the json body and the form of PATCH /api/users/me, the file only in the form', () => {
    const content = operation('patch', '/api/users/me').requestBody!.content;

    expect(Object.keys(content).sort()).toEqual(['application/json', 'multipart/form-data']);
    const json = propertiesOf(content['application/json']!.schema);
    expect(Object.keys(json).sort()).toEqual(['avatar', 'locale', 'name', 'phone']);
    expect(json.avatar).toMatchObject({ type: 'string', maxLength: 0 });
    expect(json.avatar).not.toHaveProperty('format');
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
    ['get', '/api/users/', ['200', '400', '401', '403', '500']],
    ['get', '/api/users/me', ['200', '401', '403', '500']],
    ['patch', '/api/users/me', ['200', '400', '401', '403', '404', '413', '500']],
    ['get', '/api/users/{userId}', ['200', '400', '401', '403', '404', '500']],
    ['delete', '/api/users/{userId}', ['200', '400', '401', '403', '404', '409', '500']],
    ['delete', '/api/users/{userId}/avatar', ['200', '400', '401', '403', '404', '500']],
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

  // the checkboxes and the period of the admin page
  it('lists the optional query of GET /api/users/{userId}: include, from and to', () => {
    const query = (operation('get', '/api/users/{userId}').parameters ?? []).filter(
      (parameter) => parameter.in === 'query',
    );

    expect(query.map((parameter) => parameter.name).sort()).toEqual(['from', 'include', 'to']);
    expect(query.filter((parameter) => parameter.required)).toEqual([]);
  });

  // the filters, the search and the order of the admin table of users
  it('lists the optional query of GET /api/users/', () => {
    const query = (operation('get', '/api/users/').parameters ?? []).filter(
      (parameter) => parameter.in === 'query',
    );

    expect(query.map((parameter) => parameter.name).sort()).toEqual([
      'authProvider',
      'cursor',
      'deleted',
      'email',
      'isVerified',
      'limit',
      'role',
      'sortBy',
      'sortOrder',
    ]);
    expect(query.filter((parameter) => parameter.required)).toEqual([]);
  });

  it('shows the answer DELETE /api/users/{userId} really gives as its example', () => {
    const ok = operation('delete', '/api/users/{userId}').responses?.['200'];

    expect(ok?.content?.['application/json']?.example).toEqual({ message: 'user deleted' });
  });
});

describe('the product routes', () => {
  // the create route takes only a form: its images are files, a json body never had them
  it('lists only the form of POST /api/products/, with its image files', () => {
    const content = operation('post', '/api/products/').requestBody!.content;

    expect(Object.keys(content)).toEqual(['multipart/form-data']);
    const form = propertiesOf(content['multipart/form-data']!.schema);
    expect(Object.keys(form).sort()).toEqual([
      'categoryId',
      'description',
      'images',
      'name',
      'price',
      'stock',
    ]);
    expect(form.images).toMatchObject({
      type: 'array',
      items: { type: 'string', format: 'binary' },
    });
  });

  it('lists the json body and the form of PATCH /api/products/{productId}, images only in the form', () => {
    const content = operation('patch', '/api/products/{productId}').requestBody!.content;

    expect(Object.keys(content).sort()).toEqual(['application/json', 'multipart/form-data']);
    expect(propertiesOf(content['application/json']!.schema)).not.toHaveProperty('images');
    expect(propertiesOf(content['multipart/form-data']!.schema).images).toMatchObject({
      type: 'array',
      items: { type: 'string', format: 'binary' },
    });
  });

  it.each([
    ['post', '/api/products/', ['201', '400', '401', '403', '413', '500']],
    [
      'patch',
      '/api/products/{productId}',
      ['200', '400', '401', '403', '404', '409', '413', '500'],
    ],
  ])('lists only the answers %s %s can give', (method, path, statuses) => {
    expect(Object.keys(operation(method, path).responses ?? {}).sort()).toEqual(statuses);
  });
});

// a schema with its references followed
type Resolved = Schema & { required?: string[] };
const resolve = (schema: Schema): Resolved =>
  schema.$ref ? resolve(doc.components.schemas[schema.$ref.split('/').pop()!]!) : schema;

// the required properties of a schema, references and allOf followed
const requiredOf = (schema: Schema): string[] => {
  const resolved = resolve(schema);
  return [...(resolved.required ?? []), ...(resolved.allOf ?? []).flatMap(requiredOf)];
};

describe('the payments routes', () => {
  // there is no main provider: the body names one of the providers of the server
  it('asks the order and the provider in the body of POST /api/payments/checkout/sessions', () => {
    const body = resolve(
      operation('post', '/api/payments/checkout/sessions').requestBody!.content['application/json']!
        .schema,
    );

    expect(requiredOf(body).sort()).toEqual(['orderId', 'provider']);
    expect(propertiesOf(body).provider).toMatchObject({ type: 'string', enum: ['stripe'] });
  });

  it('names the provider of the page in the answer', () => {
    const answer = operation('post', '/api/payments/checkout/sessions').responses?.['201'] as {
      content: Record<string, { schema: Schema }>;
    };
    const page = resolve(
      propertiesOf(resolve(answer.content['application/json']!.schema)).checkoutSession as Schema,
    );

    expect(requiredOf(page)).toContain('provider');
    expect(propertiesOf(page).provider).toMatchObject({ enum: ['stripe'] });
  });

  // stripe is one provider: its routes are under its name, the paths of a main provider are gone
  it('keeps the routes of stripe under its name only', () => {
    expect(doc.paths).not.toHaveProperty(['/api/payments/webhook']);
    expect(doc.paths).not.toHaveProperty(['/api/payments/checkout/sessions/{sessionId}']);
    expect(doc.paths).toHaveProperty(['/api/payments/stripe/webhook']);
    expect(doc.paths).toHaveProperty(['/api/payments/stripe/checkout/sessions/{sessionId}']);
  });

  it('asks the csrf header of POST /api/payments/checkout/sessions', () => {
    const security = operation('post', '/api/payments/checkout/sessions').security ?? [];

    expect(security.length).toBeGreaterThan(0);
    for (const requirement of security) expect(requirement).toHaveProperty('csrfTokenHeader');
  });

  // 503: redis or Stripe out of reach; a body that fails its schema is a 400, never a 422
  it.each([
    [
      'post',
      '/api/payments/checkout/sessions',
      ['201', '400', '401', '403', '404', '409', '500', '503'],
    ],
    [
      'get',
      '/api/payments/stripe/checkout/sessions/{sessionId}',
      ['200', '400', '401', '403', '404', '500', '503'],
    ],
    ['post', '/api/payments/stripe/webhook', ['200', '400', '401', '500']],
  ])('lists only the answers %s %s can give', (method, path, statuses) => {
    expect(Object.keys(operation(method, path).responses ?? {}).sort()).toEqual(statuses);
  });
});

describe('every route', () => {
  // a body that fails its schema is a 400 VALIDATION_ERROR everywhere; the one 422 the app gives
  // is a category whose parent does not exist (CATEGORY_PARENT_NOT_FOUND)
  it('lists 422 only for a category whose parent may be missing', () => {
    const with422 = Object.entries(doc.paths).flatMap(([path, operations]) =>
      Object.entries(operations)
        .filter(([, op]) => op.responses?.['422'])
        .map(([method]) => `${method} ${path}`),
    );

    expect(with422.sort()).toEqual(['patch /api/categories/{categoryId}', 'post /api/categories/']);
  });

  it('lists only the answers the confirmation of an order can give', () => {
    expect(
      Object.keys(operation('post', '/api/orders/current/confirm').responses ?? {}).sort(),
    ).toEqual(['200', '400', '401', '403', '404', '409', '500', '503']);
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
