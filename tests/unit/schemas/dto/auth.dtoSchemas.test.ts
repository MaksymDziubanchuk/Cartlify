import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import errorNormalizer from '@middlewares/errorNormalizer.js';
import { authDtoSchemas } from '@schemas/dto/auth.dtoSchemas.js';

// a bare fastify instance with the auth body schemas and the same ajv options as the app
const app = fastify({ logger: false, ajv: { customOptions: { coerceTypes: true } } });

beforeAll(async () => {
  for (const schema of authDtoSchemas) app.addSchema(schema);
  errorNormalizer(app);

  const ok = async () => ({ ok: true });
  app.post('/register', { schema: { body: { $ref: 'authRegisterBodySchema#' } } }, ok);
  app.post('/reset', { schema: { body: { $ref: 'authPasswordResetBodySchema#' } } }, ok);
  app.post('/login', { schema: { body: { $ref: 'authLoginBodySchema#' } } }, ok);

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const email = 'buyer@example.com';

// every printable ascii character from space to tilde, cut or repeated to the length
const ascii = (length: number) => {
  const all = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i));
  return all.join('').repeat(2).slice(0, length);
};

const send = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });

describe.each([
  ['registration', '/register', 'password', (password: string) => ({ email, password })],
  ['password reset', '/reset', 'newPassword', (newPassword: string) => ({ newPassword })],
])('the new password at %s', (_route, url, field, body) => {
  it.each([
    ['6 characters', 'abc123'],
    ['64 characters with spaces and every ascii symbol', ascii(64)],
  ])('is accepted with %s', async (_case, password) => {
    const res = await send(url, body(password));

    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['is shorter than 6 characters', 'abc12'],
    ['is longer than 64 characters', ascii(65)],
    // cyrillic letters, written as escapes
    ['has letters outside latin', 'жфщюяц'],
    ['has an accented latin letter', 'café-password'],
    ['has an emoji', 'password-\u{1F600}'],
    ['has a tab', 'pass\tword'],
  ])('is rejected when it %s', async (_case, password) => {
    const res = await send(url, body(password));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'VALIDATION_ERROR',
      details: [{ in: 'body', field }],
    });
  });
});

describe('the password at login', () => {
  // passwords set before the limit may be longer or not ascii, they still have to log in
  it.each([
    ['256 characters', 'p'.repeat(256)],
    ['letters outside latin', 'жфщюяц-123'],
  ])('is accepted with %s', async (_case, password) => {
    const res = await send('/login', { email, password });

    expect(res.statusCode).toBe(200);
  });

  it('is rejected when it is longer than 256 characters', async () => {
    const res = await send('/login', { email, password: 'p'.repeat(257) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ details: [{ in: 'body', field: 'password' }] });
  });
});
