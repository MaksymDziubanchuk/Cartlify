import fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

import errorNormalizer from '@middlewares/errorNormalizer.js';
import { newslettersDtoSchemas } from '@schemas/dto/newsletters.dtoSchemas.js';

// a bare fastify instance with the newsletter schemas and the same ajv options as the app
const app = fastify({ logger: false, ajv: { customOptions: { coerceTypes: true } } });

const BODIES = {
  '/subscribe': 'newslettersSubscribeBodySchema',
  '/confirm': 'newslettersConfirmBodySchema',
  '/manage': 'newslettersManageBodySchema',
  '/manage-locale': 'newslettersManageLocaleBodySchema',
  '/profile-locale': 'newslettersProfileLocaleBodySchema',
  '/one-click': 'newslettersOneClickBodySchema',
} as const;

beforeAll(async () => {
  for (const schema of newslettersDtoSchemas) app.addSchema(schema);
  errorNormalizer(app);

  const ok = async (req: { body: unknown }) => ({ body: req.body });
  for (const [url, id] of Object.entries(BODIES)) {
    app.post(url, { schema: { body: { $ref: `${id}#` } } }, ok);
  }

  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const send = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });

const token = 'q3RkVZk0xW2e5pXb8nYgJ1sLhUo7aCtFdE4iMmBwP9A';

describe('the body of the subscription form', () => {
  it.each([
    ['nothing at all', {}],
    ['a signed-in user for their own address', { locale: 'uk' }],
    [
      'an address, a language and an answer of the captcha',
      { email: 'reader@example.com', locale: 'uk', captchaToken: 'XXXX.DUMMY.TOKEN.XXXX' },
    ],
    ['an address of 254 characters', { email: `${'a'.repeat(242)}@example.com` }],
    ['a language of 35 characters', { locale: 'e'.repeat(35) }],
  ])('takes %s', async (_case, body) => {
    expect((await send('/subscribe', body)).statusCode).toBe(200);
  });

  it.each([
    ['an address that is none', { email: 'reader' }],
    ['an empty address', { email: '' }],
    ['an address of 255 characters', { email: `${'a'.repeat(243)}@example.com` }],
    ['a language of 36 characters', { locale: 'e'.repeat(36) }],
    ['an empty answer of the captcha', { captchaToken: '' }],
    ['an answer of the captcha over 2048 characters', { captchaToken: 'x'.repeat(2049) }],
  ])('refuses %s', async (_case, body) => {
    const res = await send('/subscribe', body);

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe.each([
  ['the confirmation', '/confirm', { token }],
  ['the page of management', '/manage', { token }],
  ['the language on the page of management', '/manage-locale', { token, locale: 'uk' }],
])('the body of %s', (_name, url, good) => {
  it('takes the token in the body', async () => {
    expect((await send(url, good)).statusCode).toBe(200);
  });

  it.each([
    ['no token', (body: object) => ({ ...body, token: undefined })],
    ['an empty token', (body: object) => ({ ...body, token: '' })],
    ['a token over 512 characters', (body: object) => ({ ...body, token: 'x'.repeat(513) })],
  ])('refuses %s', async (_case, spoil) => {
    const res = await send(url, spoil(good));

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });
});

describe.each([
  ['the language on the page of management', '/manage-locale', { token }],
  ['the language in the profile', '/profile-locale', {}],
])('the body of %s', (_name, url, rest) => {
  it.each([
    ['no language', undefined],
    ['a language of 36 characters', 'e'.repeat(36)],
  ])('refuses %s', async (_case, locale) => {
    const res = await send(url, { ...rest, ...(locale ? { locale } : {}) });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ errorCode: 'VALIDATION_ERROR' });
  });

  it('takes a language', async () => {
    expect((await send(url, { ...rest, locale: 'uk' })).statusCode).toBe(200);
  });
});

describe('the body of the one-click unsubscribe', () => {
  it.each([
    ['the form of RFC 8058', { 'List-Unsubscribe': 'One-Click' }],
    ['an empty form', {}],
  ])('takes %s', async (_case, body) => {
    expect((await send('/one-click', body)).statusCode).toBe(200);
  });

  it('drops a field it does not know, so nothing else reaches the route', async () => {
    const res = await send('/one-click', { 'List-Unsubscribe': 'One-Click', utm: 'x' });

    expect(res.json()).toEqual({ body: { 'List-Unsubscribe': 'One-Click' } });
  });
});

describe('the body of the subscription form, unknown fields', () => {
  it('drops a field it does not know, so a body cannot reach the database with one', async () => {
    const res = await send('/subscribe', { locale: 'uk', status: 'active', userId: 1 });

    expect(res.json()).toEqual({ body: { locale: 'uk' } });
  });
});
