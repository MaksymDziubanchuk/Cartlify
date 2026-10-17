import { describe, expect, it } from '@jest/globals';
import type { FastifyRequest } from 'fastify';

import { importWithEnv } from '../../helpers/freshImport.js';

type Middleware = typeof import('@middlewares/requireWebOrigin.js');

// the middleware reads the allowed origin at import, so each case imports it with its own
const load = async (webOrigin: string) =>
  (
    await importWithEnv<Middleware>('@middlewares/requireWebOrigin.js', {
      NODE_ENV: 'production',
      WEB_ORIGIN: webOrigin,
    })
  ).default;

const requestFrom = (origin: string | undefined) =>
  ({ headers: origin === undefined ? {} : { origin } }) as unknown as FastifyRequest;

describe('requireWebOrigin', () => {
  it('lets the frontend origin through', async () => {
    const requireWebOrigin = await load('https://shop.example.com');

    await expect(
      requireWebOrigin(requestFrom('https://shop.example.com')),
    ).resolves.toBeUndefined();
  });

  it('lets a client without an Origin header through', async () => {
    const requireWebOrigin = await load('https://shop.example.com');

    await expect(requireWebOrigin(requestFrom(undefined))).resolves.toBeUndefined();
  });

  it.each(['https://evil.test', 'https://shop.example.com.evil.test', 'null', ''])(
    'forbids the origin %j',
    async (origin) => {
      const requireWebOrigin = await load('https://shop.example.com');

      await expect(requireWebOrigin(requestFrom(origin))).rejects.toMatchObject({
        statusCode: 403,
        errorCode: 'ORIGIN_NOT_ALLOWED',
      });
    },
  );

  it('forbids every page when WEB_ORIGIN is not set in production', async () => {
    const requireWebOrigin = await load('');

    await expect(requireWebOrigin(requestFrom('http://localhost:3000'))).rejects.toMatchObject({
      errorCode: 'ORIGIN_NOT_ALLOWED',
    });
  });
});
