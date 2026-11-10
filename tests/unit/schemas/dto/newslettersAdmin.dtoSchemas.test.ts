import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import errorNormalizer from '@middlewares/errorNormalizer.js';
import { newslettersAdminDtoSchemas } from '@schemas/dto/newslettersAdmin.dtoSchemas.js';

// a bare fastify instance with the schemas of the routes of the people who run the newsletters and the
// same ajv options as the app
const app = fastify({ logger: false, ajv: { customOptions: { coerceTypes: true } } });

beforeAll(async () => {
  for (const schema of newslettersAdminDtoSchemas) app.addSchema(schema);
  errorNormalizer(app);

  const ok = async () => ({ ok: true });
  app.get('/list', { schema: { querystring: { $ref: 'newslettersSubscribersQuerySchema#' } } }, ok);
  app.get('/lookup', { schema: { querystring: { $ref: 'newslettersBlocklistQuerySchema#' } } }, ok);
  app.post('/block', { schema: { body: { $ref: 'newslettersBlocklistBodySchema#' } } }, ok);
  app.delete(
    '/subscribers/:subscriberId',
    { schema: { params: { $ref: 'newslettersSubscriberParamsSchema#' } } },
    ok,
  );
  app.delete(
    '/blocklist/:blockId',
    { schema: { params: { $ref: 'newslettersBlockParamsSchema#' } } },
    ok,
  );

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const get = (url: string, query: Record<string, string | number>) =>
  app.inject({
    method: 'GET',
    url,
    query: Object.fromEntries(Object.entries(query).map(([name, value]) => [name, String(value)])),
  });

describe('the query of the list of subscribers', () => {
  it.each([
    ['nothing', {}],
    ['one state', { status: 'pending' }],
    [
      'every state through commas',
      { status: 'pending,active,paused_complaint,stopped_bounce,ended' },
    ],
    ['both sources', { source: 'form,account' }],
    ['languages and none', { locale: 'uk,es,none' }],
    ['none alone', { locale: 'none' }],
    ['a limit of a hundred', { limit: 100 }],
    ['a cursor', { cursor: 'eyJpZCI6NDc5MCwidiI6bnVsbH0' }],
    ['a part of an address with the signs of like', { email: 'a_b%c' }],
    ['an address part of 254 characters', { email: 'a'.repeat(254) }],
  ])('takes %s', async (_what, query) => {
    expect((await get('/list', query)).statusCode).toBe(200);
  });

  it.each([
    ['a state that does not exist', { status: 'gone' }],
    ['a trailing comma', { status: 'active,' }],
    ['a space after a comma', { status: 'active, ended' }],
    ['a state in capitals', { status: 'ACTIVE' }],
    ['a source that does not exist', { source: 'import' }],
    ['a language in capitals', { locale: 'UK' }],
    ['a language of three letters', { locale: 'ukr' }],
    ['a language of one letter', { locale: 'u' }],
    ['a limit of zero', { limit: 0 }],
    ['a limit over a hundred', { limit: 101 }],
    ['a cursor with signs a cursor never has', { cursor: 'a b' }],
    ['an empty cursor', { cursor: '' }],
    ['an address part of 255 characters', { email: 'a'.repeat(255) }],
  ])('refuses %s', async (_what, query) => {
    const res = await get('/list', query);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe('the address of the blocklist', () => {
  const post = (payload: object) => app.inject({ method: 'POST', url: '/block', payload });

  it('takes an address with spaces around it in a query and in a body: the route cuts them', async () => {
    expect((await get('/lookup', { email: '  Reader@Example.com ' })).statusCode).toBe(200);
    expect((await post({ email: '  Reader@Example.com ' })).statusCode).toBe(200);
  });

  it('leaves the format of the address to the route, which cuts the spaces before it looks', async () => {
    expect((await get('/lookup', { email: 'not-an-address' })).statusCode).toBe(200);
    expect((await post({ email: 'not-an-address' })).statusCode).toBe(200);
  });

  it.each([
    ['no address', {}],
    ['an empty address', { email: '' }],
    ['an address of 321 characters', { email: 'a'.repeat(321) }],
    ['a reason of 1001 characters', { email: 'a@b.com', reason: 'x'.repeat(1001) }],
  ])('refuses %s in a body', async (_what, payload) => {
    const res = await post(payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it.each([
    ['a reason of 1000 characters', { email: 'a@b.com', reason: 'x'.repeat(1000) }],
    ['an empty reason', { email: 'a@b.com', reason: '' }],
    ['an address of 320 characters', { email: 'a'.repeat(320) }],
  ])('takes %s in a body', async (_what, payload) => {
    expect((await post(payload)).statusCode).toBe(200);
  });

  it('refuses a query without the address or with an empty one', async () => {
    for (const query of [{}, { email: '' }]) {
      const res = await get('/lookup', query);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
    }
  });
});

describe('the id in the path of a removal', () => {
  const remove = (url: string) => app.inject({ method: 'DELETE', url });

  it.each(['/subscribers/1', '/subscribers/2147483647', '/blocklist/31'])(
    'takes %s',
    async (url) => {
      expect((await remove(url)).statusCode).toBe(200);
    },
  );

  it.each([
    '/subscribers/0',
    '/subscribers/01',
    '/subscribers/-1',
    '/subscribers/1e3',
    '/subscribers/1.5',
    '/subscribers/abc',
    '/blocklist/0',
  ])('refuses %s', async (url) => {
    const res = await remove(url);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});
