import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import { strictValidatorCompiler } from '@helpers/strictValidator.js';
import errorNormalizer from '@middlewares/errorNormalizer.js';

// The validator of a route that must take a body exactly as it was sent. The validator of the app
// turns "5" into 5 and drops a field the schema does not name; this one does neither, so a block
// of a newsletter that is wrong in its type or has a field of its own is refused instead of being
// mended on the way to the database
const shared = {
  $id: 'strictSharedSchema',
  type: 'object',
  additionalProperties: false,
  properties: { n: { type: 'integer' } },
  required: ['n'],
} as const;

const app = fastify({ logger: false, ajv: { customOptions: { coerceTypes: true } } });
const strict = strictValidatorCompiler([shared]);

beforeAll(async () => {
  app.addSchema(shared);
  errorNormalizer(app);

  const echo = async (req: { body: unknown }) => ({ body: req.body });
  app.post(
    '/strict',
    { validatorCompiler: strict, schema: { body: { $ref: 'strictSharedSchema#' } } },
    echo,
  );
  app.post(
    '/inline',
    {
      validatorCompiler: strict,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            list: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
          },
        },
      },
    },
    echo,
  );
  app.post('/loose', { schema: { body: { $ref: 'strictSharedSchema#' } } }, echo);

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, payload });

describe('strictValidatorCompiler', () => {
  it('takes a body that fits and hands it over as it is', async () => {
    const res = await post('/strict', { n: 5 });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { n: 5 } });
  });

  it('does not turn a text into a number', async () => {
    const res = await post('/strict', { n: '5' });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
    // the app validator does turn it
    expect((await post('/loose', { n: '5' })).json()).toEqual({ body: { n: 5 } });
  });

  it('does not drop a field the schema does not name', async () => {
    const res = await post('/strict', { n: 5, extra: true });

    expect(res.statusCode).toBe(400);
    expect(res.json().errorCode).toBe('VALIDATION_ERROR');
    // the app validator drops it
    expect((await post('/loose', { n: 5, extra: true })).json()).toEqual({ body: { n: 5 } });
  });

  it('names the place of the fault the way the app does', async () => {
    const res = await post('/strict', {});

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([
      { in: 'body', field: 'n', message: "must have required property 'n'" },
    ]);
  });

  it('keeps the fields in a branch that does not match, so a branch cannot spoil the next one', async () => {
    const res = await post('/inline', { list: ['a', 'b'] });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ body: { list: ['a', 'b'] } });
  });

  it('checks a body again for every request', async () => {
    expect((await post('/strict', { n: 1 })).statusCode).toBe(200);
    expect((await post('/strict', { n: 'x' })).statusCode).toBe(400);
    expect((await post('/strict', { n: 2 })).statusCode).toBe(200);
  });
});
