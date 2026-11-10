import type { FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import env from '@config/env.js';
import requireCaptcha from '@middlewares/requireCaptcha.js';

import { rejectedBy } from '../../helpers/errors.js';
import { jsonResponse, stubFetch } from '../../helpers/fetchStub.js';

// The hook of the routes with a captcha: it reads captchaToken from the body (the body schema of the
// route has checked it by now) and the address of the visitor from the request, and asks Cloudflare
const TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';

afterEach(() => {
  jest.restoreAllMocks();
});

const requestOf = (body: unknown, ip = '203.0.113.7') => {
  const log = { warn: jest.fn() };
  return { req: { body, ip, log } as unknown as FastifyRequest, log };
};

describe('requireCaptcha', () => {
  it('asks Cloudflare about the token of the body and the address of the request', async () => {
    const calls = stubFetch(() => jsonResponse({ success: true, 'error-codes': [] }));
    const { req } = requestOf({ email: 'a@shop.example.com', captchaToken: TOKEN });

    await expect(requireCaptcha(req)).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(Object.fromEntries(new URLSearchParams(calls[0]!.body))).toEqual({
      secret: env.TURNSTILE_SECRET_KEY,
      response: TOKEN,
      remoteip: '203.0.113.7',
    });
  });

  it('refuses a token Cloudflare does not take', async () => {
    stubFetch(() => jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] }));
    const { req } = requestOf({ captchaToken: TOKEN });

    expect(await rejectedBy(() => requireCaptcha(req))).toMatchObject({
      statusCode: 400,
      errorCode: 'CAPTCHA_INVALID',
    });
  });

  it('logs a failure of Cloudflare with the logger of the request', async () => {
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    const { req, log } = requestOf({ captchaToken: TOKEN });

    expect(await rejectedBy(() => requireCaptcha(req))).toMatchObject({
      statusCode: 503,
      errorCode: 'CAPTCHA_UNAVAILABLE',
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  // a route that has the hook has the field in its schema; a body without it gets here only
  // by a mistake of the route, and must not pass
  it.each([
    ['no body', undefined],
    ['a null body', null],
    ['a body that is no object', 'captchaToken'],
    ['a body without the field', { email: 'a@shop.example.com' }],
    ['a field that is no text', { captchaToken: 7 }],
  ])('refuses %s without asking Cloudflare', async (_case, body) => {
    const calls = stubFetch(() => jsonResponse({ success: true }));
    const { req } = requestOf(body);

    expect(await rejectedBy(() => requireCaptcha(req))).toMatchObject({
      errorCode: 'CAPTCHA_INVALID',
    });
    expect(calls).toHaveLength(0);
  });
});
