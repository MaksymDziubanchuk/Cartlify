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
    ['delete', '/api/favorites/{variantId}'],
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
    ['post', '/api/newsletters/sendgrid/webhook'],
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
    // 429 is the rate limit and 503 the session check of every such route, 409 a busy
    // database, 413 and 415 the json body, see 'the refusals every route shares' below
    ['get', '/api/users/', ['200', '400', '401', '403', '409', '429', '500', '503']],
    ['get', '/api/users/me', ['200', '401', '403', '409', '429', '500', '503']],
    [
      'patch',
      '/api/users/me',
      ['200', '400', '401', '403', '404', '409', '413', '415', '429', '500', '503'],
    ],
    ['get', '/api/users/{userId}', ['200', '400', '401', '403', '404', '409', '429', '500', '503']],
    [
      'delete',
      '/api/users/{userId}',
      ['200', '400', '401', '403', '404', '409', '429', '500', '503'],
    ],
    [
      'delete',
      '/api/users/{userId}/avatar',
      ['200', '400', '401', '403', '404', '409', '429', '500', '503'],
    ],
    [
      'delete',
      '/api/users/me',
      ['204', '400', '401', '403', '404', '409', '413', '415', '429', '500', '503'],
    ],
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
  // the create route takes only a form: its images are files, a json body never had them; the
  // variants are a JSON text in a field of it
  it('lists only the form of POST /api/products/, with its image files and its variants', () => {
    const content = operation('post', '/api/products/').requestBody!.content;

    expect(Object.keys(content)).toEqual(['multipart/form-data']);
    const form = propertiesOf(content['multipart/form-data']!.schema);
    expect(Object.keys(form).sort()).toEqual([
      'categoryId',
      'description',
      'documentIds',
      'euResponsible.address',
      'euResponsible.country',
      'euResponsible.email',
      'euResponsible.name',
      'euResponsibleId',
      'images',
      'manufacturer.address',
      'manufacturer.country',
      'manufacturer.email',
      'manufacturer.name',
      'manufacturerId',
      'name',
      'stock',
      'variants',
      'warnings',
      'withdrawal',
    ]);
    expect(form.images).toMatchObject({
      type: 'array',
      items: { type: 'string', format: 'binary' },
    });
  });

  // the pictures of a product are its gallery (POST /api/products/{productId}/images); the price,
  // the article number and the weight are the variant's
  it('lists the json body and the form of PATCH /api/products/{productId}, no pictures in either, no field of a variant', () => {
    const content = operation('patch', '/api/products/{productId}').requestBody!.content;

    expect(Object.keys(content).sort()).toEqual(['application/json', 'multipart/form-data']);
    for (const type of ['application/json', 'multipart/form-data']) {
      const fields = propertiesOf(content[type]!.schema);

      for (const field of ['images', 'price', 'sku', 'weightGrams', 'sale']) {
        expect(fields).not.toHaveProperty(field);
      }
      expect(fields).toHaveProperty('name');
    }
  });

  it('lists the form of POST /api/products/{productId}/images with its image files', () => {
    const content = operation('post', '/api/products/{productId}/images').requestBody!.content;

    expect(Object.keys(content)).toEqual(['multipart/form-data']);
    expect(propertiesOf(content['multipart/form-data']!.schema).images).toMatchObject({
      type: 'array',
      items: { type: 'string', format: 'binary' },
    });
  });

  it.each([
    [
      'post',
      '/api/products/',
      ['201', '400', '401', '403', '404', '409', '413', '429', '500', '503'],
    ],
    [
      'patch',
      '/api/products/{productId}',
      ['200', '400', '401', '403', '404', '409', '413', '415', '429', '500', '503'],
    ],
    [
      'post',
      '/api/products/{productId}/images',
      ['201', '400', '401', '403', '404', '409', '413', '429', '500', '503'],
    ],
    [
      'patch',
      '/api/products/{productId}/sale',
      ['200', '400', '401', '403', '404', '409', '413', '415', '429', '500', '503'],
    ],
  ])('lists only the answers %s %s can give', (method, path, statuses) => {
    expect(Object.keys(operation(method, path).responses ?? {}).sort()).toEqual(statuses);
  });

  // a discount by a percent or by an amount, or null to take the sale off
  it('asks a sale or null in the body of PATCH /api/products/{productId}/sale', () => {
    const body = resolve(
      operation('patch', '/api/products/{productId}/sale').requestBody!.content['application/json']!
        .schema,
    );

    expect(requiredOf(body)).toEqual(['sale']);
    // openapi 3.0 has no null type: swagger shows the null shape as a nullable one
    const sale = propertiesOf(body).sale as { anyOf?: (Schema & { nullable?: boolean })[] };
    const shapes = (sale.anyOf ?? []).map((shape) =>
      shape.nullable ? 'null' : Object.keys(propertiesOf(shape)).sort().join(','),
    );
    expect(shapes.sort()).toEqual(['amount,endsAt', 'endsAt,percent', 'null']);
  });

  // the variants named are the ones of the product; without them every variant for sale
  it('takes the variants to put on sale in the body of PATCH /api/products/{productId}/sale', () => {
    const body = resolve(
      operation('patch', '/api/products/{productId}/sale').requestBody!.content['application/json']!
        .schema,
    );

    expect(Object.keys(propertiesOf(body)).sort()).toEqual(['sale', 'variantIds']);
    expect(requiredOf(body)).toEqual(['sale']);
  });

  it('answers the state of each variant to the routes of a sale', () => {
    for (const [method, path] of [
      ['patch', '/api/products/{productId}/sale'],
      ['post', '/api/products/sales'],
    ] as const) {
      const answer = resolve(
        (
          operation(method, path).responses?.['200']?.content?.['application/json'] as {
            schema: Schema;
          }
        ).schema,
      );
      const variants = propertiesOf(answer).variants as unknown as { items: Schema };

      expect(Object.keys(propertiesOf(answer))).toEqual(['variants']);
      expect(Object.keys(propertiesOf(variants.items)).sort()).toEqual(
        [
          'id',
          'name',
          'price',
          'productId',
          'salePriorPrice',
          'salePrice',
          'saleEndsAt',
          'status',
        ].sort(),
      );
    }
  });

  it('takes a variant or a product in each item of POST /api/products/sales', () => {
    const body = resolve(
      operation('post', '/api/products/sales').requestBody!.content['application/json']!.schema,
    );
    const items = propertiesOf(body).items as unknown as { items: Schema };

    expect(Object.keys(propertiesOf(items.items)).sort()).toEqual([
      'productId',
      'sale',
      'variantId',
    ]);
    expect(requiredOf(items.items)).toEqual(['sale']);
  });

  describe('the change of the price of variants', () => {
    it('takes the price and the word on the sale in the body of the change of a variant', () => {
      const body = resolve(
        operation('patch', '/api/products/{productId}/variants/{variantId}').requestBody!.content[
          'application/json'
        ]!.schema,
      );

      expect(Object.keys(propertiesOf(body))).toEqual(
        expect.arrayContaining(['price', 'sale', 'sku', 'weightGrams', 'position', 'images']),
      );
      expect(requiredOf(body)).toEqual([]);
    });

    // the pictures are one list for every variant named (the plan: pictures for the whole product or
    // the variants chosen); an article number, a barcode and a place are of one variant alone
    it('lists PATCH /api/products/{productId}/variants with the names of the variants and no field of one variant alone', () => {
      const route = operation('patch', '/api/products/{productId}/variants');
      const body = resolve(route.requestBody!.content['application/json']!.schema);

      expect(Object.keys(propertiesOf(body)).sort()).toEqual(
        [
          'variantIds',
          'price',
          'sale',
          'weightGrams',
          'lengthMm',
          'widthMm',
          'heightMm',
          'withoutShippingData',
          'attributes',
          'images',
          'stock',
        ].sort(),
      );
      expect(Object.keys(route.responses ?? {})).toEqual(
        expect.arrayContaining(['200', '400', '401', '403', '404', '409', '500']),
      );
    });

    it('lists PATCH /api/products/variants/batch with up to 100 items and the variant of each', () => {
      const route = operation('patch', '/api/products/variants/batch');
      const body = resolve(route.requestBody!.content['application/json']!.schema);
      const items = propertiesOf(body).items as unknown as { items: Schema; maxItems: number };

      expect(requiredOf(body)).toEqual(['items']);
      expect(items.maxItems).toBe(100);
      expect(requiredOf(items.items)).toEqual(['variantId']);
      expect(Object.keys(propertiesOf(items.items))).toEqual(
        expect.arrayContaining(['variantId', 'price', 'sale', 'weightGrams']),
      );
      expect(route.security).toEqual([{ accessTokenCookie: [], csrfTokenHeader: [] }]);
    });

    it.each([
      ['patch', '/api/products/{productId}/variants'],
      ['patch', '/api/products/variants/batch'],
    ])('names VARIANTS_INVALID among the refusals of %s %s', (method, path) => {
      const responses = (operation(method, path).responses ?? {}) as Record<string, Description>;

      for (const status of ['400', '404', '409']) {
        expect(responses[status]?.description).toContain('VARIANTS_INVALID');
      }
    });
  });

  it('asks the variant in the query of the price history of a product', () => {
    const query = operation('get', '/api/products/{productId}/price-history').parameters ?? [];

    expect(
      query
        .filter((parameter) => parameter.in === 'query')
        .map((p) => p.name)
        .sort(),
    ).toEqual(['cursor', 'limit', 'variantId']);
  });

  it('shows the sale of a variant next to its price, only while it lasts', () => {
    const answerOf = (path: string) =>
      resolve(
        (
          operation('get', path).responses?.['200']?.content?.['application/json'] as {
            schema: Schema;
          }
        ).schema,
      );
    const cardVariant = resolve(
      propertiesOf(answerOf('/api/products/{productId}')).variant as Schema,
    );
    const variantOnItsOwn = answerOf('/api/products/{productId}/variants/{variantId}');
    // the rows of the list carry the short form of the variant the same way
    const listRow = resolve(
      (propertiesOf(answerOf('/api/products/')).items as unknown as { items: Schema }).items,
    );
    const rowVariant = resolve(propertiesOf(listRow).variant as Schema);

    for (const schema of [cardVariant, variantOnItsOwn, rowVariant]) {
      // a buyer gets them while the sale lasts, an admin always, null without a sale
      expect(Object.keys(propertiesOf(schema))).toEqual(
        expect.arrayContaining(['salePrice', 'saleEndsAt']),
      );
      expect(requiredOf(schema)).not.toContain('salePrice');
      expect(requiredOf(schema)).not.toContain('saleEndsAt');
    }
  });

  // a buyer and an admin get other fields of a product: the fields of an admin are optional, and
  // the card of a buyer has no popularity. The price, the stock and the picture are the variant's
  it('requires of the product of the card only the fields every role gets, with its category', () => {
    const card = resolve(
      propertiesOf(
        resolve(
          (
            operation('get', '/api/products/{productId}').responses?.['200']?.content?.[
              'application/json'
            ] as { schema: Schema }
          ).schema,
        ),
      ).product as Schema,
    );

    expect(requiredOf(card).sort()).toEqual([
      'avgRating',
      'category',
      'createdAt',
      'documents',
      'euResponsible',
      'id',
      'manufacturer',
      'name',
      'reviewsCount',
      'warnings',
      'withdrawal',
    ]);
    expect(propertiesOf(card)).not.toHaveProperty('categoryId');
    for (const field of ['price', 'stock', 'sku', 'images']) {
      expect(propertiesOf(card)).not.toHaveProperty(field);
    }
    expect(Object.keys(propertiesOf(card))).toEqual(
      expect.arrayContaining([
        'popularity',
        'views',
        'updatedAt',
        'popularityOverride',
        'popularityOverrideUntil',
        'deletedAt',
        'gallery',
      ]),
    );
  });

  it('requires of the variant of the card only the fields every role gets', () => {
    const variant = resolve(
      propertiesOf(
        resolve(
          (
            operation('get', '/api/products/{productId}').responses?.['200']?.content?.[
              'application/json'
            ] as { schema: Schema }
          ).schema,
        ),
      ).variant as Schema,
    );

    expect(requiredOf(variant).sort()).toEqual([
      'attributes',
      'heightMm',
      'id',
      'image',
      'images',
      'lengthMm',
      'name',
      'position',
      'price',
      'sku',
      'stock',
      'values',
      'weightGrams',
      'widthMm',
    ]);
    expect(Object.keys(propertiesOf(variant))).toEqual(
      expect.arrayContaining([
        'barcode',
        'totalStock',
        'reservedStock',
        'expiredStock',
        'lastUnitCost',
        'visible',
        'deletedAt',
      ]),
    );
  });

  it('lists the flags of an admin among the query of GET /api/products/', () => {
    const query = (operation('get', '/api/products/').parameters ?? [])
      .filter((parameter) => parameter.in === 'query')
      .map((parameter) => parameter.name);

    expect(query).toEqual(expect.arrayContaining(['deleted', 'onSale', 'popularityOverridden']));
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
      ['201', '400', '401', '403', '404', '409', '413', '415', '429', '500', '503'],
    ],
    [
      'get',
      '/api/payments/stripe/checkout/sessions/{sessionId}',
      ['200', '400', '401', '403', '404', '409', '429', '500', '503'],
    ],
    // 503: Stripe out of reach while the event is read (a dispute, a refund made in the dashboard)
    ['post', '/api/payments/stripe/webhook', ['200', '400', '401', '409', '500', '503']],
    // the Event Webhook of SendGrid: 413 and 415 for a body it does not take, 401 for a signature
    // that fails, 503 for a server without its key
    [
      'post',
      '/api/newsletters/sendgrid/webhook',
      ['200', '400', '401', '409', '413', '415', '500', '503'],
    ],
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
    ).toEqual(['200', '400', '401', '403', '404', '409', '413', '415', '429', '500', '503']);
  });
});

// the refusals that come from the shared parts of a route (the schema, the guards, the rate limit,
// the error handler) are written into the document in one place, src/plugins/openapi.plugin.ts
describe('the refusals every route shares', () => {
  const operations = () =>
    Object.entries(doc.paths).flatMap(([path, byMethod]) =>
      Object.entries(byMethod).map(([method, op]) => ({ method, path, op })),
    );
  const said = (op: Operation, status: string) =>
    ((op.responses?.[status] as Description | undefined)?.description ?? '').toString();

  it('names INTERNAL_ERROR among the answers of every route', () => {
    const without = operations()
      .filter(({ op }) => !said(op, '500').includes('INTERNAL_ERROR'))
      .map(({ method, path }) => `${method} ${path}`);

    expect(without).toEqual([]);
  });

  // a transaction whose time ran out: the database was busy, the client repeats the request
  it('names RESOURCE_BUSY among the answers of every route of the api', () => {
    const without = operations()
      .filter(({ path }) => path.startsWith('/api/'))
      .filter(({ op }) => !said(op, '409').includes('RESOURCE_BUSY'))
      .map(({ method, path }) => `${method} ${path}`);

    expect(without).toEqual([]);
  });

  // the routes that take an image file put it at Cloudinary
  it('names IMAGE_STORAGE_UNAVAILABLE for the routes that take an image file, and only for them', () => {
    const naming = operations()
      .filter(({ op }) => said(op, '503').includes('IMAGE_STORAGE_UNAVAILABLE'))
      .map(({ method, path }) => `${method} ${path}`);

    expect(naming.sort()).toEqual([
      'patch /api/users/me',
      'post /api/admin/documents/',
      'post /api/products/',
      'post /api/products/{productId}/images',
      'post /api/root/shop-settings/logo',
      'put /api/categories/{categoryId}/image',
    ]);
  });

  // the health checks and the events of the payment and mail providers are outside the limit
  it('names RATE_LIMITED for every route the rate limit counts', () => {
    const free = [
      '/health/',
      '/ready/',
      '/api/payments/stripe/webhook',
      '/api/newsletters/sendgrid/webhook',
    ];
    const counted = operations().filter(({ path }) => !free.includes(path));

    expect(
      counted
        .filter(({ op }) => !said(op, '429').includes('RATE_LIMITED'))
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual([]);
    for (const path of free) {
      for (const op of Object.values(doc.paths[path] ?? {}))
        expect(op.responses?.['429']).toBeUndefined();
    }
  });

  it('names INSUFFICIENT_ROLE and the roles of a route that checks them', () => {
    expect(said(operation('get', '/api/admin/stats'), '403')).toContain('INSUFFICIENT_ROLE');
    expect(said(operation('get', '/api/admin/stats'), '403')).toContain('ADMIN, ROOT');
    expect(said(operation('post', '/api/auth/login'), '403')).toContain('GUEST');
  });

  it('names INVALID_ID_PARAM for an id in the path', () => {
    expect(said(operation('get', '/api/orders/{orderId}'), '400')).toContain('INVALID_ID_PARAM');
    expect(said(operation('get', '/api/orders/{orderId}'), '400')).toContain('`orderId`');
  });

  it('names VALIDATION_ERROR for a route with a schema of its request', () => {
    expect(said(operation('post', '/api/auth/login'), '400')).toContain('VALIDATION_ERROR');
    expect(said(operation('get', '/api/admin/stats'), '400')).toContain('VALIDATION_ERROR');
  });

  it('names LOGIN_REQUIRED and AUTH_TEMPORARILY_UNAVAILABLE for a route that reads the session', () => {
    expect(said(operation('get', '/api/orders/current'), '401')).toContain('LOGIN_REQUIRED');
    expect(said(operation('get', '/api/orders/current'), '503')).toContain(
      'AUTH_TEMPORARILY_UNAVAILABLE',
    );
  });

  // a json body: not json, too big or of another type never reaches the route
  it('names the refusals of a json body', () => {
    const login = operation('post', '/api/auth/login');

    expect(said(login, '400')).toContain('BAD_REQUEST');
    expect(said(login, '413')).toContain('PAYLOAD_TOO_LARGE');
    expect(said(login, '415')).toContain('UNSUPPORTED_MEDIA_TYPE');
  });

  it('gives a csv report as text/csv next to its json', () => {
    for (const path of [
      '/api/admin/reports/accounting/products',
      '/api/admin/reports/accounting/variants',
      '/api/admin/reports/accounting/categories',
      '/api/admin/reports/accounting/timeline',
    ]) {
      const content = operation('get', path).responses?.['200']?.content ?? {};

      expect(Object.keys(content).sort()).toEqual(['application/json', 'text/csv']);
    }
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
