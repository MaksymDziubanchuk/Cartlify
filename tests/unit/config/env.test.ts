import { describe, expect, it } from '@jest/globals';

import { rejectedBy } from '../../helpers/errors.js';
import { importWithEnv } from '../../helpers/freshImport.js';

type Env = (typeof import('@config/env.js'))['default'];

const loadEnv = async (values: Record<string, string> = {}) =>
  (await importWithEnv<typeof import('@config/env.js')>('@config/env.js', values)).default as Env;

// every setting with a default, given as unset
const UNSET = Object.fromEntries(
  [
    'NODE_ENV',
    'PORT',
    'HOST',
    'JWT_ACCESS_TTL_SHORT',
    'JWT_ACCESS_TTL_LONG',
    'JWT_REFRESH_TTL_SHORT',
    'JWT_REFRESH_TTL_LONG',
    'GUEST_ID_TTL',
    'RESET_TTL_MS',
    'BCRYPT_ROUNDS',
    'OPENAI_MODEL',
    'OPENAI_TIMEOUT_MS',
    'OPENAI_MAX_OUTPUT_TOKENS',
    'REDIS_ORDER_TIMEOUT_WORKER_MS',
    'STRIPE_CURRENCY',
    'WEB_ORIGIN',
    'SENDGRID_API_KEY',
  ].map((key) => [key, '']),
);

describe('env', () => {
  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'])(
    'stops the start when %s is missing, naming the setting and not any value',
    async (key) => {
      const err = await rejectedBy(() => loadEnv({ [key]: '' }));

      expect((err as Error).message).toBe(`Missing required env variable: ${key}`);
    },
  );

  it('uses the defaults for every setting that is not set', async () => {
    expect(await loadEnv(UNSET)).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      HOST: '0.0.0.0',
      JWT_ACCESS_TTL_SHORT: '1200',
      JWT_ACCESS_TTL_LONG: '3600',
      JWT_REFRESH_TTL_SHORT: '86400',
      JWT_REFRESH_TTL_LONG: '2592000',
      GUEST_ID_TTL: '157680000',
      RESET_TTL_MS: 3600000,
      BCRYPT_ROUNDS: 12,
      OPENAI_MODEL: 'gpt-4.1-mini',
      OPENAI_TIMEOUT_MS: 12000,
      OPENAI_MAX_OUTPUT_TOKENS: 450,
      REDIS_ORDER_TIMEOUT_WORKER_MS: 3000,
      STRIPE_CURRENCY: 'eur',
      WEB_ORIGIN: '',
      SENDGRID_API_KEY: '',
    });
  });

  it('reads the values that are set, numbers as numbers', async () => {
    expect(
      await loadEnv({
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '127.0.0.1',
        RESET_TTL_MS: '900000',
        BCRYPT_ROUNDS: '10',
        REDIS_ORDER_TIMEOUT_WORKER_MS: '5000',
        STRIPE_CURRENCY: 'usd',
        WEB_ORIGIN: 'https://shop.example.com',
      }),
    ).toMatchObject({
      NODE_ENV: 'production',
      PORT: 8080,
      HOST: '127.0.0.1',
      RESET_TTL_MS: 900000,
      BCRYPT_ROUNDS: 10,
      REDIS_ORDER_TIMEOUT_WORKER_MS: 5000,
      STRIPE_CURRENCY: 'usd',
      WEB_ORIGIN: 'https://shop.example.com',
    });
  });

  // a typo must stop the start: a port of NaN fails only at listen, a reset ttl of NaN
  // breaks every reset request, a worker interval of NaN or 0 makes node run it every 1 ms
  it.each([
    ['PORT', 'eighty'],
    ['PORT', '80.5'],
    ['RESET_TTL_MS', 'one hour'],
    ['RESET_TTL_MS', '-1'],
    ['RESET_TTL_MS', '1e6'],
    ['REDIS_ORDER_TIMEOUT_WORKER_MS', 'fast'],
    ['REDIS_ORDER_TIMEOUT_WORKER_MS', '0'],
  ])('stops the start when %s is %p, not a positive whole number', async (key, value) => {
    const err = await rejectedBy(() => loadEnv({ [key]: value }));

    expect((err as Error).message).toContain(key);
    // the start error lands in the hosting logs, the value stays out of it
    expect((err as Error).message).not.toContain(value);
  });

  it('reads a number with spaces around it', async () => {
    expect(
      (await loadEnv({ REDIS_ORDER_TIMEOUT_WORKER_MS: ' 5000 ' })).REDIS_ORDER_TIMEOUT_WORKER_MS,
    ).toBe(5000);
  });
});
