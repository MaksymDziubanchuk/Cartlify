import fastify, { type FastifyInstance, type FastifySchema } from 'fastify';
import swagger from '@fastify/swagger';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { installContractCheck, takeContractViolations } from '../../../helpers/contract.js';

// the check of tests/helpers/contract.ts on a small app of its own: one route per kind of gap
let app: FastifyInstance;

const errorBody = (code: number, errorCode: string) => ({
  code,
  errorCode,
  message: 'Conflict',
});

beforeAll(async () => {
  app = fastify({ logger: false });
  await app.register(swagger, { openapi: { openapi: '3.0.3', info: { title: 't', version: '1' } } });

  app.addSchema({
    $id: 'contractErrorSchema',
    type: 'object',
    properties: {
      code: { type: 'integer' },
      errorCode: { type: 'string' },
      message: { type: 'string' },
    },
  });

  const shape = {
    type: 'object',
    properties: { amount: { type: 'number' }, note: { type: ['string', 'null'] } },
  };
  const strictName = { type: 'object', properties: { name: { type: 'string' } } };
  const conflict = {
    description: 'The thing is taken (THING_TAKEN).',
    $ref: 'contractErrorSchema#',
  };

  app.register(
    async (scope) => {
      scope.get('/', { schema: { response: { 200: shape } } }, async () => ({ amount: 2, note: 'n' }));
    },
    { prefix: '/api/list' },
  );
  app.get('/api/fits', { schema: { response: { 200: shape } } }, async () => ({
    amount: 5,
    note: null,
  }));
  app.get<{ Params: { id: string } }>(
    '/api/things/:id',
    { schema: { response: { 200: shape } } },
    async () => ({ amount: 1, note: 'x' }),
  );
  // a status the schema does not list, so the types of the route do not allow it either
  app.get('/api/teapot', { schema: { response: { 200: shape } } as FastifySchema }, async (_req, reply) =>
    reply.code(418).send({ amount: 1 }),
  );
  app.get('/api/named', { schema: { response: { 409: conflict } } }, async (_req, reply) =>
    reply.code(409).send(errorBody(409, 'THING_TAKEN')),
  );
  app.get('/api/unnamed', { schema: { response: { 409: conflict } } }, async (_req, reply) =>
    reply.code(409).send(errorBody(409, 'THING_LOCKED')),
  );
  app.get('/api/dropped', { schema: { response: { 200: strictName } } }, async () => ({
    name: 'a',
    passwordHash: 'x',
  }));
  app.get('/api/null', { schema: { response: { 200: strictName } } }, async () => ({ name: null }));
  app.get('/api/required', {
    schema: {
      response: {
        200: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      },
    },
  }, async (_req, reply) => reply.type('application/json').send('{}'));
  app.get('/api/csv', { schema: { response: { 200: strictName } } }, async (_req, reply) =>
    reply.type('text/csv').send('name\na'),
  );
  app.get('/api/hidden', { schema: { hide: true } }, async (_req, reply) =>
    reply.code(418).send({}),
  );

  installContractCheck(app);
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const gapsOf = async (url: string) => {
  takeContractViolations();
  await app.inject({ method: 'GET', url });
  return takeContractViolations();
};

describe('the contract check of the integration tests', () => {
  it('lets through an answer the document describes, with a null the schema allows', async () => {
    expect(await gapsOf('/api/fits')).toEqual([]);
  });

  it('finds the route of an address with a parameter', async () => {
    expect(await gapsOf('/api/things/7')).toEqual([]);
  });

  // the document names the root route of a prefix with its slash, it answers without it too
  it.each(['/api/list', '/api/list/'])('finds the root route of a prefix at %s', async (url) => {
    expect(await gapsOf(url)).toEqual([]);
  });

  it('finds a status the route does not list', async () => {
    expect(await gapsOf('/api/teapot')).toEqual([
      'GET /api/teapot 418: status 418 is not among the answers of the route',
    ]);
  });

  it('lets through an error whose code the description names', async () => {
    expect(await gapsOf('/api/named')).toEqual([]);
  });

  it('finds an error code the description does not name', async () => {
    expect(await gapsOf('/api/unnamed')).toEqual([
      'GET /api/unnamed 409: error code THING_LOCKED is not named in the description of 409',
    ]);
  });

  // the frontend never gets such a field, and a secret must not reach the serializer at all
  it('finds a field the schema drops', async () => {
    expect(await gapsOf('/api/dropped')).toEqual([
      'GET /api/dropped 200: field passwordHash is dropped by the schema',
    ]);
  });

  it('finds a null the serializer turns into a value', async () => {
    expect(await gapsOf('/api/null')).toEqual([
      'GET /api/null 200: field name is null but the schema has no null, it is sent as ""',
    ]);
  });

  it('finds a body that misses a required field', async () => {
    expect(await gapsOf('/api/required')).toEqual([
      "GET /api/required 200: the body does not pass the schema: / must have required property 'name'",
    ]);
  });

  it('finds a content type the document does not give', async () => {
    expect(await gapsOf('/api/csv')).toEqual([
      'GET /api/csv 200: the answer is text/csv, the document gives application/json',
    ]);
  });

  it('leaves a route hidden from the document alone', async () => {
    expect(await gapsOf('/api/hidden')).toEqual([]);
  });

  it('leaves an address without a route alone', async () => {
    expect(await gapsOf('/api/nowhere')).toEqual([]);
  });
});
