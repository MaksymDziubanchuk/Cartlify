import { STATUS_CODES } from 'node:http';
import fastify, { LogController } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import errorNormalizer from '@middlewares/errorNormalizer.js';
import rateLimit from '@fastify/rate-limit';

import {
  AppError,
  BadRequestError,
  InternalError,
  NotFoundError,
  ResourceBusyError,
} from '@utils/errors.js';

// what tx() gives a busy error after its retries: for the log only
const BUSY_LOG_DETAILS = { attempts: 4, maxRetries: 3, pgCode: '40P01', prismaCode: 'P2010' };

// a bare fastify instance with one route per kind of error, nothing else is loaded
const app = fastify({ logger: false });

beforeAll(async () => {
  errorNormalizer(app);

  app.get('/busy', async () => {
    throw new ResourceBusyError(BUSY_LOG_DETAILS);
  });

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
  // an error with a status but not an app error, the way plugins throw them
  app.get<{ Params: { status: string } }>('/plugin-error/:status', async (req) => {
    throw Object.assign(new Error('from a plugin'), { statusCode: Number(req.params.status) });
  });
  // the errors @fastify/csrf-protection sends for a missing secret or a wrong token
  app.get<{ Params: { code: string } }>('/csrf-error/:code', async (req) => {
    throw Object.assign(new Error('csrf'), { statusCode: 403, code: req.params.code });
  });
  // an app error of our own whose message is not the phrase of its status
  app.get('/custom-message', async () => {
    throw new AppError({ statusCode: 409, errorCode: 'CART_LOCKED', message: 'cart is locked' });
  });
  app.post('/json-body', async () => ({ ok: true }));
  app.post('/small-body', { bodyLimit: 16 }, async () => ({ ok: true }));
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

  // the client only learns to try again; which database code and how many attempts is for us
  it('tells a busy client to try again without the codes of the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/busy' });
    const body = res.json();

    expect(res.statusCode).toBe(409);
    expect(body).toMatchObject({ code: 409, errorCode: 'RESOURCE_BUSY', message: 'Conflict' });
    expect(body.details).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('40P01');
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

  // the swagger contract: message is the standard http phrase for the status code,
  // errorCode of an error that is not ours comes from the status, the same as our own classes use
  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [405, 'METHOD_NOT_ALLOWED'],
    [409, 'CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [415, 'UNSUPPORTED_MEDIA_TYPE'],
    [422, 'UNPROCESSABLE_ENTITY'],
    [429, 'RATE_LIMITED'],
    [503, 'SERVICE_UNAVAILABLE'],
  ])('gives a %i error from a plugin its phrase and the code %s', async (status, errorCode) => {
    const res = await app.inject({ method: 'GET', url: `/plugin-error/${status}` });

    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ code: status, errorCode, message: STATUS_CODES[status] });
  });

  // the frontend takes a new token on this code and repeats the request
  it.each(['FST_CSRF_MISSING_SECRET', 'FST_CSRF_INVALID_TOKEN'])(
    'answers %s from the csrf plugin with 403 CSRF_TOKEN_INVALID',
    async (code) => {
      const res = await app.inject({ method: 'GET', url: `/csrf-error/${code}` });

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        code: 403,
        errorCode: 'CSRF_TOKEN_INVALID',
        message: 'Forbidden',
      });
    },
  );

  it('gives a client error status without a standard phrase the generic client answer', async () => {
    const res = await app.inject({ method: 'GET', url: '/plugin-error/499' });

    expect(res.statusCode).toBe(499);
    expect(res.json()).toMatchObject({
      code: 499,
      errorCode: 'BAD_REQUEST',
      message: 'Bad Request',
    });
  });

  it('keeps any other server failure from a plugin an INTERNAL_ERROR', async () => {
    const res = await app.inject({ method: 'GET', url: '/plugin-error/502' });

    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({
      code: 502,
      errorCode: 'INTERNAL_ERROR',
      message: 'Bad Gateway',
    });
  });

  it.each([
    ['a success status', 200],
    ['a redirect status', 302],
    ['a status past 599', 600],
  ])('treats an error carrying %s as a server failure', async (_case, status) => {
    const res = await app.inject({ method: 'GET', url: `/plugin-error/${status}` });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      code: 500,
      errorCode: 'INTERNAL_ERROR',
      message: 'Internal Server Error',
    });
  });

  it('sends the phrase of the status even when our own error carries another message', async () => {
    const res = await app.inject({ method: 'GET', url: '/custom-message' });

    expect(res.json()).toMatchObject({ code: 409, errorCode: 'CART_LOCKED', message: 'Conflict' });
  });

  it('answers a body of an unsupported type with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/validated-body',
      headers: { 'content-type': 'application/xml' },
      payload: '<email>a@b.co</email>',
    });

    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({
      code: 415,
      errorCode: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'Unsupported Media Type',
    });
  });

  it('answers a body over the limit with 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/small-body',
      payload: { text: 'longer than sixteen bytes' },
    });

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({
      code: 413,
      errorCode: 'PAYLOAD_TOO_LARGE',
      message: 'Payload Too Large',
    });
  });

  it('answers a body that is not valid json with 400 BAD_REQUEST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/json-body',
      headers: { 'content-type': 'application/json' },
      payload: '{"name": ',
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 400,
      errorCode: 'BAD_REQUEST',
      message: 'Bad Request',
    });
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

describe('errorNormalizer with the rate limit plugin', () => {
  // the same plugin the app uses, with a limit of one request so the second one is refused
  const limited = fastify({ logger: false });

  beforeAll(async () => {
    errorNormalizer(limited);
    await limited.register(rateLimit, { max: 1, timeWindow: '1 minute' });
    limited.get('/limited', async () => ({ ok: true }));
    await limited.ready();
  });

  afterAll(async () => {
    await limited.close();
  });

  it('answers a request over the limit with 429 RATE_LIMITED in the common error shape', async () => {
    await limited.inject({ method: 'GET', url: '/limited' });
    const res = await limited.inject({ method: 'GET', url: '/limited' });

    expect(res.statusCode).toBe(429);
    expect(res.json()).toMatchObject({
      code: 429,
      errorCode: 'RATE_LIMITED',
      message: 'Too Many Requests',
      reqId: expect.any(String),
    });
  });
});

describe('errorNormalizer logging', () => {
  // a second instance whose logger writes into an array instead of stdout
  const lines: Array<Record<string, any>> = [];
  const logged = fastify({
    logger: { level: 'info', stream: { write: (line: string) => lines.push(JSON.parse(line)) } },
    logController: new LogController({ disableRequestLogging: true }),
  });

  const lastRecord = () => lines.at(-1) ?? {};

  beforeAll(async () => {
    errorNormalizer(logged);

    logged.get('/missing', async () => {
      throw new NotFoundError('PRODUCT_NOT_FOUND');
    });
    logged.get('/busy', async () => {
      throw new ResourceBusyError(BUSY_LOG_DETAILS);
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
    await logged.inject({ method: 'GET', url: '/missing?search=phone&limit=20' });

    const record = lastRecord();

    expect(record).toMatchObject({
      level: 30,
      msg: 'request rejected',
      statusCode: 404,
      errorCode: 'PRODUCT_NOT_FOUND',
      method: 'GET',
      // the query shows which filters the request came with
      url: '/missing?search=phone&limit=20',
    });
    expect(record.err).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain('stack');
  });

  it('logs the details a client error keeps from the client', async () => {
    await logged.inject({ method: 'GET', url: '/busy' });

    expect(lastRecord()).toMatchObject({
      level: 30,
      msg: 'request rejected',
      statusCode: 409,
      errorCode: 'RESOURCE_BUSY',
      details: BUSY_LOG_DETAILS,
    });
  });

  it('hides tokens in the query, keeps the other parameters', async () => {
    await logged.inject({ method: 'GET', url: '/missing?token=secret-value&limit=20' });

    expect(lastRecord().url).toBe('/missing?token=[hidden]&limit=20');
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
