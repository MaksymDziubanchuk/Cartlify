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
    'AVATAR_REMOVALS_LIMIT',
    'RATE_LIMIT_MAX',
    'SHOP_TIME_ZONE',
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
      JWT_ACCESS_TTL_SHORT: 1200,
      JWT_ACCESS_TTL_LONG: 3600,
      JWT_REFRESH_TTL_SHORT: 86400,
      JWT_REFRESH_TTL_LONG: 2592000,
      GUEST_ID_TTL: 157680000,
      RESET_TTL_MS: 3600000,
      BCRYPT_ROUNDS: 12,
      AVATAR_REMOVALS_LIMIT: 5,
      RATE_LIMIT_MAX: 100,
      SHOP_TIME_ZONE: 'Europe/Madrid',
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
        JWT_ACCESS_TTL_SHORT: '900',
        JWT_ACCESS_TTL_LONG: '1800',
        JWT_REFRESH_TTL_SHORT: '43200',
        JWT_REFRESH_TTL_LONG: '604800',
        GUEST_ID_TTL: '31536000',
        RESET_TTL_MS: '900000',
        BCRYPT_ROUNDS: '10',
        AVATAR_REMOVALS_LIMIT: '3',
        RATE_LIMIT_MAX: '300',
        SHOP_TIME_ZONE: ' Europe/Kyiv ',
        REDIS_ORDER_TIMEOUT_WORKER_MS: '5000',
        STRIPE_CURRENCY: 'usd',
        WEB_ORIGIN: 'https://shop.example.com',
      }),
    ).toMatchObject({
      NODE_ENV: 'production',
      PORT: 8080,
      HOST: '127.0.0.1',
      JWT_ACCESS_TTL_SHORT: 900,
      JWT_ACCESS_TTL_LONG: 1800,
      JWT_REFRESH_TTL_SHORT: 43200,
      JWT_REFRESH_TTL_LONG: 604800,
      GUEST_ID_TTL: 31536000,
      RESET_TTL_MS: 900000,
      BCRYPT_ROUNDS: 10,
      AVATAR_REMOVALS_LIMIT: 3,
      RATE_LIMIT_MAX: 300,
      SHOP_TIME_ZONE: 'Europe/Kyiv',
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
    ['AVATAR_REMOVALS_LIMIT', 'five'],
    ['AVATAR_REMOVALS_LIMIT', '0'],
    ['RATE_LIMIT_MAX', 'many'],
    ['RATE_LIMIT_MAX', '0'],
    // a lifetime that is not seconds used to fail only when the first token was signed, and a
    // guest lifetime of NaN broke the cookie of every request without one
    ['JWT_ACCESS_TTL_SHORT', '15m'],
    ['JWT_ACCESS_TTL_LONG', '0'],
    ['JWT_REFRESH_TTL_SHORT', '-60'],
    ['JWT_REFRESH_TTL_LONG', '1.5'],
    ['GUEST_ID_TTL', '5y'],
    ['GUEST_ID_TTL', '0'],
  ])('stops the start when %s is %p, not a positive whole number', async (key, value) => {
    const err = await rejectedBy(() => loadEnv({ [key]: value }));

    expect((err as Error).message).toContain(key);
    // the start error lands in the hosting logs, the value stays out of it
    expect((err as Error).message).not.toContain(value);
  });

  // the days and months of the reports are the days of the shop; a zone the database would not
  // know, or an offset that reads the other way round in it, must stop the start
  it.each(['Mars/Olympus', 'Europe/Nowhere', '+03:00', 'UTC+3'])(
    'stops the start when SHOP_TIME_ZONE is %p, not a time zone of the iana list',
    async (value) => {
      const err = await rejectedBy(() => loadEnv({ SHOP_TIME_ZONE: value }));

      expect((err as Error).message).toContain('SHOP_TIME_ZONE');
      expect((err as Error).message).not.toContain(value);
    },
  );

  it('reads a number with spaces around it', async () => {
    expect(
      (await loadEnv({ REDIS_ORDER_TIMEOUT_WORKER_MS: ' 5000 ' })).REDIS_ORDER_TIMEOUT_WORKER_MS,
    ).toBe(5000);
  });

  // stripe and the prices of the catalog count money in cents; a currency of the shop without
  // cents (jpy) or with three digits (kwd) would be charged a hundred times off
  it('reads the currency of the shop in lower case', async () => {
    expect((await loadEnv({ STRIPE_CURRENCY: ' EUR ' })).STRIPE_CURRENCY).toBe('eur');
  });

  it.each(['jpy', 'KRW', 'kwd', 'bhd', 'euro', 'e1'])(
    'stops the start when STRIPE_CURRENCY is %p, not a currency with cents',
    async (value) => {
      const err = await rejectedBy(() => loadEnv({ STRIPE_CURRENCY: value }));

      expect((err as Error).message).toBe(
        'Invalid env variable: STRIPE_CURRENCY must be a three letter code of a currency with cents',
      );
    },
  );

  it.each(['development', 'test', 'production'])('takes NODE_ENV %p as it is', async (value) => {
    expect((await loadEnv({ NODE_ENV: value })).NODE_ENV).toBe(value);
  });

  // any other value used to switch on the development behaviour silently: cookies without
  // Secure, the csrf cookie without __Host-, stacks in the answers of a 500
  it.each(['prod', 'Production', 'staging', 'dev'])(
    'stops the start when NODE_ENV is %p, not one of the three modes',
    async (value) => {
      const err = await rejectedBy(() => loadEnv({ NODE_ENV: value }));

      // the message names the setting and the allowed modes, never the value it got
      expect((err as Error).message).toBe(
        'Invalid env variable: NODE_ENV must be development, test or production',
      );
    },
  );

  // without the secret every stripe event is refused and no order ever becomes paid
  it('stops the start in production when STRIPE_WEBHOOK_SECRET is missing', async () => {
    const err = await rejectedBy(() =>
      loadEnv({ NODE_ENV: 'production', STRIPE_WEBHOOK_SECRET: '' }),
    );

    expect((err as Error).message).toBe('Missing required env variable: STRIPE_WEBHOOK_SECRET');
  });

  it('starts without STRIPE_WEBHOOK_SECRET outside production', async () => {
    const loaded = await loadEnv({ NODE_ENV: 'development', STRIPE_WEBHOOK_SECRET: '' });

    expect(loaded.STRIPE_WEBHOOK_SECRET).toBe('');
  });
});
