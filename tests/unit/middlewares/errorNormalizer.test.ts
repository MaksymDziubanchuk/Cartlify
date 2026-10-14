import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import errorNormalizer from '@middlewares/errorNormalizer.js';
import { BadRequestError, InternalError, NotFoundError } from '@utils/errors.js';

// a bare fastify instance with one route per kind of error, nothing else is loaded
const app = fastify({ logger: false });

beforeAll(async () => {
  errorNormalizer(app);

  app.get('/bad', async () => {
    throw new BadRequestError('PRICE_INVALID', { field: 'price' });
  });
  app.get('/missing', async () => {
    throw new NotFoundError('PRODUCT_NOT_FOUND');
  });
  app.get('/internal', async () => {
    throw new InternalError({ query: 'select secret from users' }, new Error('db down'));
  });
  app.get('/crash', async () => {
    throw new Error('something broke inside');
  });
  app.get('/http-error', async () => {
    throw Object.assign(new Error('payload too big'), { statusCode: 413 });
  });
  app.get(
    '/validated',
    {
      schema: {
        querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string' } } },
      },
    },
    async () => ({ ok: true }),
  );
  app.post(
    '/validated-body',
    {
      schema: {
        body: {
          type: 'object',
          required: ['email'],
          additionalProperties: false,
          properties: {
            email: { type: 'string', format: 'email' },
            scope: { type: 'object', properties: { minPrice: { type: 'number' } } },
          },
        },
      },
    },
    async () => ({ ok: true }),
  );

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('errorNormalizer', () => {
  it('sends an app error with its status, code, message and details', async () => {
    const res = await app.inject({ method: 'GET', url: '/bad' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 400,
      errorCode: 'PRICE_INVALID',
      message: 'Bad Request',
      details: { field: 'price' },
    });
  });

  it('adds the request id so a client error can be found in the logs', async () => {
    const res = await app.inject({ method: 'GET', url: '/missing' });

    expect(res.json().reqId).toEqual(expect.any(String));
  });

  it('never sends the details or the cause of an internal error', async () => {
    const res = await app.inject({ method: 'GET', url: '/internal' });
    const body = res.json();

    expect(res.statusCode).toBe(500);
    expect(body).toMatchObject({ code: 500, errorCode: 'INTERNAL_ERROR' });
    expect(body.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('select secret');
    expect(JSON.stringify(body)).not.toContain('db down');
  });

  it('turns an unknown error into a generic 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/crash' });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      code: 500,
      errorCode: 'INTERNAL_ERROR',
      message: 'Internal Server Error',
    });
  });

  it('keeps the status of a plain http error from a plugin', async () => {
    const res = await app.inject({ method: 'GET', url: '/http-error' });

    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe(413);
  });

  it('answers a schema error with VALIDATION_ERROR and the failed field', async () => {
    const res = await app.inject({ method: 'GET', url: '/validated' });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 400,
      errorCode: 'VALIDATION_ERROR',
      message: 'Bad Request',
      details: [{ in: 'querystring', field: 'q', message: expect.any(String) }],
    });
  });

  it.each([
    ['a field has a wrong format', { email: 'not-an-email' }, 'email'],
    ['a required field is missing', {}, 'email'],
    [
      'a nested field has a wrong type',
      { email: 'a@b.co', scope: { minPrice: 'cheap' } },
      'scope.minPrice',
    ],
  ])('names the field when %s', async (_case, payload, field) => {
    const res = await app.inject({ method: 'POST', url: '/validated-body', payload });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'VALIDATION_ERROR',
      details: [{ in: 'body', field }],
    });
  });
});

describe('errorNormalizer logging', () => {
  // a second instance whose logger writes into an array instead of stdout
  const lines: Array<Record<string, any>> = [];
  const logged = fastify({
    logger: { level: 'info', stream: { write: (line: string) => lines.push(JSON.parse(line)) } },
    disableRequestLogging: true,
  });

  const lastRecord = () => lines.at(-1) ?? {};

  beforeAll(async () => {
    errorNormalizer(logged);

    logged.get('/missing', async () => {
      throw new NotFoundError('PRODUCT_NOT_FOUND');
    });
    logged.get('/internal', async () => {
      throw new InternalError({ reason: 'X' }, new Error('db down'));
    });
    logged.get(
      '/validated',
      { schema: { querystring: { type: 'object', required: ['q'] } } },
      async () => ({ ok: true }),
    );

    await logged.ready();
  });

  afterAll(async () => {
    await logged.close();
  });

  it('logs a client error as one info line without a stack', async () => {
    await logged.inject({ method: 'GET', url: '/missing?token=secret-value' });

    const record = lastRecord();

    expect(record).toMatchObject({
      level: 30,
      msg: 'request rejected',
      statusCode: 404,
      errorCode: 'PRODUCT_NOT_FOUND',
      method: 'GET',
      path: '/missing',
    });
    expect(record.err).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('stack');
  });

  it('keeps the query string out of the log, it may carry tokens', async () => {
    await logged.inject({ method: 'GET', url: '/missing?token=secret-value' });

    expect(JSON.stringify(lastRecord())).not.toContain('secret-value');
  });

  it('logs which fields failed for a schema error', async () => {
    await logged.inject({ method: 'GET', url: '/validated' });

    expect(lastRecord()).toMatchObject({
      level: 30,
      errorCode: 'VALIDATION_ERROR',
      details: [{ in: 'querystring', field: 'q' }],
    });
  });

  it('logs a server failure as an error with its stack and cause', async () => {
    await logged.inject({ method: 'GET', url: '/internal' });

    const record = lastRecord();

    expect(record).toMatchObject({ level: 50, msg: 'request failed' });
    expect(record.err.stack).toEqual(expect.any(String));
    // the cause is part of the error record itself, not an empty separate field
    expect(record.err.message).toContain('db down');
    expect(record.err.stack).toContain('db down');
    expect(record.cause).toBeUndefined();
  });
});
