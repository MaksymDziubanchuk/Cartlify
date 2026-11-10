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
  app.post('/resend', { schema: { body: { $ref: 'authResendVerifyBodySchema#' } } }, ok);
  app.post('/forgot', { schema: { body: { $ref: 'authPasswordForgotBodySchema#' } } }, ok);

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const email = 'buyer@example.com';
const captchaToken = 'XXXX.DUMMY.TOKEN.XXXX';
// the token of the link of a reset: the page reads it after the # of the address and posts it in the body
const RESET_TOKEN = 'reset-token-0123456789';

// every printable ascii character from space to tilde, cut or repeated to the length
const ascii = (length: number) => {
  const all = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i));
  return all.join('').repeat(2).slice(0, length);
};

const send = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });

describe.each([
  [
    'registration',
    '/register',
    'password',
    (password: string) => ({ email, password, captchaToken }),
  ],
  [
    'password reset',
    '/reset',
    'newPassword',
    (newPassword: string) => ({ token: RESET_TOKEN, newPassword }),
  ],
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

// the answer of the captcha (Cloudflare Turnstile) rides in the body of the three routes that send a
// mail or open an account for anybody: a token is up to 2048 characters, and always asked for
describe.each([
  ['registration', '/register', { email, password: 'abc123' }],
  ['the resend of the verification mail', '/resend', { email }],
  ['the request of a password reset', '/forgot', { email }],
])('the captcha token at %s', (_route, url, body) => {
  it.each([
    ['1 character', 'x'],
    ['the answer of a dummy widget', captchaToken],
    ['2048 characters', 'x'.repeat(2048)],
  ])('is accepted with %s', async (_case, token) => {
    const res = await send(url, { ...body, captchaToken: token });

    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['is missing', body],
    ['is empty', { ...body, captchaToken: '' }],
    ['is longer than 2048 characters', { ...body, captchaToken: 'x'.repeat(2049) }],
    ['is not a text', { ...body, captchaToken: { token: captchaToken } }],
  ])('is rejected when it %s', async (_case, payload) => {
    const res = await send(url, payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'VALIDATION_ERROR',
      details: [{ in: 'body', field: expect.stringContaining('captchaToken') }],
    });
  });
});

describe('the token at password reset', () => {
  it('is taken from the body', async () => {
    const res = await send('/reset', { token: RESET_TOKEN, newPassword: 'abc123' });

    expect(res.statusCode).toBe(200);
  });

  it.each([
    ['is missing', { newPassword: 'abc123' }],
    ['is shorter than 10 characters', { token: 'short', newPassword: 'abc123' }],
    ['is not a text', { token: { id: 1 }, newPassword: 'abc123' }],
  ])('is rejected when it %s', async (_case, payload) => {
    const res = await send('/reset', payload);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      errorCode: 'VALIDATION_ERROR',
      details: [{ in: 'body', field: 'token' }],
    });
  });
});
