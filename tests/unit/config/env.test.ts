import { readFileSync } from 'node:fs';

import { describe, expect, it } from '@jest/globals';

import { rejectedBy } from '../../helpers/errors.js';
import { importWithEnv } from '../../helpers/freshImport.js';

type Env = (typeof import('@config/env.js'))['default'];

const loadEnv = async (values: Record<string, string> = {}) =>
  (await importWithEnv<typeof import('@config/env.js')>('@config/env.js', values)).default as Env;

// the settings a shop tunes for itself, with the values the code had before they were settings
const SHOP_DEFAULTS = {
  TRUST_PROXY_HOPS: 1,
  LIMIT_LOGIN_PER_ADDRESS: 30,
  LIMIT_LOGIN_PER_EMAIL: 10,
  LIMIT_REGISTER_PER_ADDRESS: 10,
  LIMIT_MAIL_PER_ADDRESS: 10,
  LIMIT_MAIL_PER_EMAIL: 1,
  LIMIT_CHECKOUT_PER_USER: 10,
  LIMIT_PASSWORD_CHANGE_PER_USER: 10,
  LIMIT_EXPORT_PER_USER: 1,
  LIMIT_REVIEW_PER_USER: 30,
  LIMIT_CHAT_CALL_ADMIN_PER_USER: 10,
  LIMIT_WITHDRAWAL_PER_USER: 10,
  LIMIT_WITHDRAWAL_FORM_PER_ADDRESS: 20,
  LIMIT_WITHDRAWAL_FORM_PER_ORDER: 5,
  LIMIT_WITHDRAWAL_FORM_PER_DATA: 5,
  LOGIN_FAILURES_BEFORE_PAUSE: 5,
  UPLOAD_MAX_BYTES: 5_000_000,
  PRODUCT_IMAGES_MAX: 50,
  PRODUCT_VARIANTS_MAX: 200,
  VARIANT_IMAGES_MAX: 10,
  DOCUMENT_MAX_BYTES: 20_000_000,
  PRODUCT_DOCUMENTS_MAX: 20,
  ATTRIBUTE_OPTIONS_MAX: 500,
  VERIFY_TTL_MS: 86_400_000,
  WEB_PAGE_OAUTH_CALLBACK: '/auth/callback',
  WEB_PAGE_LOGIN: '/web/login',
  WEB_PAGE_VERIFY_EMAIL: '/web/login',
  WEB_PAGE_PASSWORD_RESET: '/web/auth/reset',
  WEB_PAGE_CHECKOUT_SUCCESS: '/checkout/success',
  WEB_PAGE_CHECKOUT_CANCEL: '/checkout/cancel',
  WEB_PAGE_ORDER: '/orders/{id}',
  WEB_PAGE_WITHDRAWAL: '/orders/{id}/withdrawal',
  WEB_PAGE_PRODUCT_REVIEWS: '/products/{id}#reviews',
};

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
    'RATE_LIMIT_MAX',
    'SHOP_TIME_ZONE',
    'OPENAI_MODEL',
    'OPENAI_TIMEOUT_MS',
    'OPENAI_MAX_OUTPUT_TOKENS',
    'REDIS_ORDER_TIMEOUT_WORKER_MS',
    'STRIPE_CURRENCY',
    'WEB_ORIGIN',
    'SENDGRID_API_KEY',
    ...Object.keys(SHOP_DEFAULTS),
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

  // a value of spaces only is no secret: the start stops as if it were missing
  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'STRIPE_WEBHOOK_SECRET'])(
    'stops the start when %s is only spaces',
    async (key) => {
      const err = await rejectedBy(() => loadEnv({ NODE_ENV: 'production', [key]: '   ' }));

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
      RATE_LIMIT_MAX: 100,
      SHOP_TIME_ZONE: 'Europe/Madrid',
      OPENAI_MODEL: 'gpt-4.1-mini',
      OPENAI_TIMEOUT_MS: 12000,
      OPENAI_MAX_OUTPUT_TOKENS: 450,
      REDIS_ORDER_TIMEOUT_WORKER_MS: 3000,
      STRIPE_CURRENCY: 'eur',
      WEB_ORIGIN: '',
      SENDGRID_API_KEY: '',
      ...SHOP_DEFAULTS,
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

  // without the secret every stripe event is refused and no order ever becomes paid; the dev
  // server is a copy of production, so it stops the same way
  it.each(['development', 'production'])(
    'stops the start in %s when STRIPE_WEBHOOK_SECRET is missing',
    async (mode) => {
      const err = await rejectedBy(() => loadEnv({ NODE_ENV: mode, STRIPE_WEBHOOK_SECRET: '' }));

      expect((err as Error).message).toBe('Missing required env variable: STRIPE_WEBHOOK_SECRET');
    },
  );

  it.each(['development', 'production'])(
    'stops the start in %s when WITHDRAWAL_CODE_SECRET is missing',
    async (mode) => {
      const err = await rejectedBy(() => loadEnv({ NODE_ENV: mode, WITHDRAWAL_CODE_SECRET: ' ' }));

      expect((err as Error).message).toBe('Missing required env variable: WITHDRAWAL_CODE_SECRET');
    },
  );

  it.each(['development', 'production'])(
    'refuses a WITHDRAWAL_CODE_SECRET shorter than 32 characters in %s: a short one could be found by trying the code of a mail offline',
    async (mode) => {
      const err = await rejectedBy(() =>
        loadEnv({ NODE_ENV: mode, WITHDRAWAL_CODE_SECRET: 'a'.repeat(31) }),
      );

      expect((err as Error).message).toBe(
        'Invalid env variable: WITHDRAWAL_CODE_SECRET must be at least 32 characters',
      );
    },
  );

  it('takes a WITHDRAWAL_CODE_SECRET of 32 characters, trimmed', async () => {
    const loaded = await loadEnv({
      NODE_ENV: 'production',
      WITHDRAWAL_CODE_SECRET: ` ${'a'.repeat(32)} `,
    });

    expect(loaded.WITHDRAWAL_CODE_SECRET).toBe('a'.repeat(32));
  });

  it('lets the tests start without WITHDRAWAL_CODE_SECRET, with no secret', async () => {
    const loaded = await loadEnv({ NODE_ENV: 'test', WITHDRAWAL_CODE_SECRET: ' ' });

    expect(loaded.WITHDRAWAL_CODE_SECRET).toBe('');
  });

  it('lets the tests start without STRIPE_WEBHOOK_SECRET', async () => {
    const loaded = await loadEnv({ NODE_ENV: 'test', STRIPE_WEBHOOK_SECRET: '' });

    expect(loaded.STRIPE_WEBHOOK_SECRET).toBe('');
  });
});

// the settings a buyer of the shop tunes for it: each one unset keeps the value the code had
describe('the settings of the shop', () => {
  it('reads the values that are set', async () => {
    expect(
      await loadEnv({
        LIMIT_LOGIN_PER_ADDRESS: '60',
        LIMIT_LOGIN_PER_EMAIL: '20',
        LIMIT_REGISTER_PER_ADDRESS: '5',
        LIMIT_MAIL_PER_ADDRESS: '7',
        LIMIT_MAIL_PER_EMAIL: '2',
        LIMIT_CHECKOUT_PER_USER: '3',
        LIMIT_PASSWORD_CHANGE_PER_USER: '4',
        LIMIT_EXPORT_PER_USER: '6',
        LIMIT_REVIEW_PER_USER: '50',
        LIMIT_CHAT_CALL_ADMIN_PER_USER: '4',
        LIMIT_WITHDRAWAL_PER_USER: '7',
        LIMIT_WITHDRAWAL_FORM_PER_ADDRESS: '9',
        LIMIT_WITHDRAWAL_FORM_PER_ORDER: '3',
        LIMIT_WITHDRAWAL_FORM_PER_DATA: '2',
        LOGIN_FAILURES_BEFORE_PAUSE: '8',
        UPLOAD_MAX_BYTES: '10000000',
        PRODUCT_IMAGES_MAX: '20',
        PRODUCT_VARIANTS_MAX: '30',
        VARIANT_IMAGES_MAX: '4',
        DOCUMENT_MAX_BYTES: '30000000',
        PRODUCT_DOCUMENTS_MAX: '5',
        ATTRIBUTE_OPTIONS_MAX: '40',
        VERIFY_TTL_MS: '7200000',
        WEB_PAGE_OAUTH_CALLBACK: '/login/done',
        WEB_PAGE_LOGIN: '/sign-in',
        WEB_PAGE_VERIFY_EMAIL: '/account/verify',
        WEB_PAGE_PASSWORD_RESET: '/account/password?step=new',
        WEB_PAGE_CHECKOUT_SUCCESS: '/pay/ok',
        WEB_PAGE_CHECKOUT_CANCEL: '/pay/back',
        WEB_PAGE_ORDER: '/account/orders/{id}',
        WEB_PAGE_WITHDRAWAL: '/account/orders/{id}/leave',
        WEB_PAGE_PRODUCT_REVIEWS: '/p/{id}?tab=reviews#rate',
      }),
    ).toMatchObject({
      LIMIT_LOGIN_PER_ADDRESS: 60,
      LIMIT_LOGIN_PER_EMAIL: 20,
      LIMIT_REGISTER_PER_ADDRESS: 5,
      LIMIT_MAIL_PER_ADDRESS: 7,
      LIMIT_MAIL_PER_EMAIL: 2,
      LIMIT_CHECKOUT_PER_USER: 3,
      LIMIT_PASSWORD_CHANGE_PER_USER: 4,
      LIMIT_EXPORT_PER_USER: 6,
      LIMIT_REVIEW_PER_USER: 50,
      LIMIT_CHAT_CALL_ADMIN_PER_USER: 4,
      LIMIT_WITHDRAWAL_PER_USER: 7,
      LIMIT_WITHDRAWAL_FORM_PER_ADDRESS: 9,
      LIMIT_WITHDRAWAL_FORM_PER_ORDER: 3,
      LIMIT_WITHDRAWAL_FORM_PER_DATA: 2,
      LOGIN_FAILURES_BEFORE_PAUSE: 8,
      UPLOAD_MAX_BYTES: 10_000_000,
      PRODUCT_IMAGES_MAX: 20,
      PRODUCT_VARIANTS_MAX: 30,
      VARIANT_IMAGES_MAX: 4,
      DOCUMENT_MAX_BYTES: 30_000_000,
      PRODUCT_DOCUMENTS_MAX: 5,
      ATTRIBUTE_OPTIONS_MAX: 40,
      VERIFY_TTL_MS: 7_200_000,
      WEB_PAGE_OAUTH_CALLBACK: '/login/done',
      WEB_PAGE_LOGIN: '/sign-in',
      WEB_PAGE_VERIFY_EMAIL: '/account/verify',
      WEB_PAGE_PASSWORD_RESET: '/account/password?step=new',
      WEB_PAGE_CHECKOUT_SUCCESS: '/pay/ok',
      WEB_PAGE_CHECKOUT_CANCEL: '/pay/back',
      WEB_PAGE_ORDER: '/account/orders/{id}',
      WEB_PAGE_WITHDRAWAL: '/account/orders/{id}/leave',
      WEB_PAGE_PRODUCT_REVIEWS: '/p/{id}?tab=reviews#rate',
    });
  });

  // 0 trusts no proxy, the address of the connection counts; a host with two proxies sets 2
  it.each([
    ['0', 0],
    ['2', 2],
  ])('reads TRUST_PROXY_HOPS %p as %p', async (value, hops) => {
    expect((await loadEnv({ TRUST_PROXY_HOPS: value })).TRUST_PROXY_HOPS).toBe(hops);
  });

  it.each([
    ['TRUST_PROXY_HOPS', '-1'],
    ['TRUST_PROXY_HOPS', 'one'],
    ...[
      'LIMIT_LOGIN_PER_ADDRESS',
      'LIMIT_LOGIN_PER_EMAIL',
      'LIMIT_REGISTER_PER_ADDRESS',
      'LIMIT_MAIL_PER_ADDRESS',
      'LIMIT_MAIL_PER_EMAIL',
      'LIMIT_CHECKOUT_PER_USER',
      'LIMIT_PASSWORD_CHANGE_PER_USER',
      'LIMIT_EXPORT_PER_USER',
      'LIMIT_REVIEW_PER_USER',
      'LIMIT_CHAT_CALL_ADMIN_PER_USER',
      'LIMIT_WITHDRAWAL_PER_USER',
      'LIMIT_WITHDRAWAL_FORM_PER_ADDRESS',
      'LIMIT_WITHDRAWAL_FORM_PER_ORDER',
      'LIMIT_WITHDRAWAL_FORM_PER_DATA',
      'LOGIN_FAILURES_BEFORE_PAUSE',
      'UPLOAD_MAX_BYTES',
      'PRODUCT_IMAGES_MAX',
      'PRODUCT_VARIANTS_MAX',
      'VARIANT_IMAGES_MAX',
      'DOCUMENT_MAX_BYTES',
      'PRODUCT_DOCUMENTS_MAX',
      'ATTRIBUTE_OPTIONS_MAX',
      'VERIFY_TTL_MS',
    ].flatMap((key) => [
      [key, '0'],
      [key, 'many'],
    ]),
  ])('stops the start when %s is %p', async (key, value) => {
    const err = await rejectedBy(() => loadEnv({ [key]: value }));

    expect((err as Error).message).toContain(key);
    // the start error lands in the hosting logs, the value stays out of it
    expect((err as Error).message).not.toContain(`: ${value}`);
  });

  // a limit of the catalog or of its files with a zero too many would let a request write thousands
  // of rows or hold a transaction for minutes: the start stops above the bound, the bound itself is
  // let through
  it.each([
    ['UPLOAD_MAX_BYTES', 100_000_000],
    ['PRODUCT_IMAGES_MAX', 1_000],
    ['PRODUCT_VARIANTS_MAX', 10_000],
    ['VARIANT_IMAGES_MAX', 100],
    ['DOCUMENT_MAX_BYTES', 100_000_000],
    ['PRODUCT_DOCUMENTS_MAX', 100],
    ['ATTRIBUTE_OPTIONS_MAX', 10_000],
  ] as const)(
    'stops the start when %s is over %p, and takes the bound itself',
    async (key, max) => {
      const err = await rejectedBy(() => loadEnv({ [key]: String(max + 1) }));

      expect((err as Error).message).toBe(`Invalid env variable: ${key} must be at most ${max}`);
      // the start error lands in the hosting logs: the bound is named, the value is not
      expect((err as Error).message).not.toContain(String(max + 1));
      expect((await loadEnv({ [key]: String(max) }))[key]).toBe(max);
    },
  );

  // the links of the mails and the redirect after a login go to these pages: a value that leaves
  // the site would send the people and their tokens to another one
  it.each([
    ['WEB_PAGE_LOGIN', 'web/login'],
    ['WEB_PAGE_LOGIN', '//evil.example/login'],
    ['WEB_PAGE_LOGIN', '/\\evil.example/login'],
    ['WEB_PAGE_LOGIN', 'https://evil.example/login'],
    ['WEB_PAGE_LOGIN', '/sign in'],
    ['WEB_PAGE_OAUTH_CALLBACK', '//evil.example'],
    ['WEB_PAGE_VERIFY_EMAIL', 'javascript:alert(1)'],
    ['WEB_PAGE_PASSWORD_RESET', '/reset/{id}'],
    ['WEB_PAGE_CHECKOUT_SUCCESS', '/\tpay'],
    ['WEB_PAGE_CHECKOUT_CANCEL', '//pay/back'],
  ])('stops the start when %s is %p, not a path of the site', async (key, value) => {
    const err = await rejectedBy(() => loadEnv({ [key]: value }));

    expect((err as Error).message).toBe(
      `Invalid env variable: ${key} must be a path of the site starting with /, without {id}`,
    );
  });

  // the page of an order or of a product names it by its id
  it.each([
    ['WEB_PAGE_ORDER', '/orders'],
    ['WEB_PAGE_ORDER', '/orders/{id}/{id}'],
    ['WEB_PAGE_ORDER', '//evil.example/{id}'],
    ['WEB_PAGE_WITHDRAWAL', '/withdrawal'],
    ['WEB_PAGE_PRODUCT_REVIEWS', '/products#reviews'],
  ])('stops the start when %s is %p, not a path of the site with {id}', async (key, value) => {
    const err = await rejectedBy(() => loadEnv({ [key]: value }));

    expect((err as Error).message).toBe(
      `Invalid env variable: ${key} must be a path of the site starting with /, with {id} once`,
    );
  });
});

// the limits of the routes a shop can set: the example of the env file and the configuration page
// of the docs list each one with the default the code has (the same keys in both, as the rules of
// the project say)
describe('env: the limits of the routes in the example and the docs', () => {
  const limits = Object.entries(SHOP_DEFAULTS).filter(([key]) => key.startsWith('LIMIT_'));

  it('include the limit of the button "call an admin"', () => {
    expect(SHOP_DEFAULTS.LIMIT_CHAT_CALL_ADMIN_PER_USER).toBe(10);
    expect(limits.map(([key]) => key)).toContain('LIMIT_CHAT_CALL_ADMIN_PER_USER');
  });

  it.each(limits)('lists %s with its default %p in .env.example, left empty', (key, fallback) => {
    const lines = readFileSync('.env.example', 'utf8').split(/\r?\n/);
    const at = lines.indexOf(`${key}=`);

    expect(at).toBeGreaterThan(0);
    // the line before it says what the setting is and its default
    expect(lines[at - 1]).toContain(`(${fallback} unless given)`);
  });

  it.each(limits)('lists %s with its default %p in docs/configuration.md', (key, fallback) => {
    const lines = readFileSync('docs/configuration.md', 'utf8').split(/\r?\n/);

    expect(lines).toContain(`${key}=${fallback}`);
  });
});
