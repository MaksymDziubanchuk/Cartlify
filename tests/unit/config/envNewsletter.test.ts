import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from '@jest/globals';

import { rejectedBy } from '../../helpers/errors.js';
import { importWithEnv } from '../../helpers/freshImport.js';
import { newsletterWebhookPublicKey } from '../../helpers/newsletterWebhookKey.js';
import { TURNSTILE_TEST_SECRETS } from '../../setup/isolateEnv.js';

type Env = (typeof import('@config/env.js'))['default'];

const loadEnv = async (values: Record<string, string> = {}) =>
  (await importWithEnv<typeof import('@config/env.js')>('@config/env.js', values)).default as Env;

// The settings of the newsletters and of the captcha: required outside the tests, in development as
// in production (the dev server is a copy of production); the tests take theirs from
// tests/setup/isolateEnv.ts. The message of a failed start names the setting and the rule, never the
// value (the start error lands in the hosting logs)
const KEYS = [
  'SENDGRID_NEWSLETTER_API_KEY',
  'SENDGRID_NEWSLETTER_WEBHOOK_KEY',
  'NEWSLETTER_EMAIL_FROM',
  'NEWSLETTER_BLOCK_SECRET',
  'NEWSLETTER_LINK_SECRET',
  'NEWSLETTER_DAILY_LIMIT',
  'TURNSTILE_SECRET_KEY',
] as const;

// the settings of the newsletters that may be left out (they have a value of their own)
const OPTIONAL_KEYS = ['NEWSLETTER_RETRY_MINUTES', 'NEWSLETTER_MAX_ATTEMPTS'] as const;

const secretOf = (sentence: string) => Buffer.from(sentence).toString('base64url');

const valid = {
  SENDGRID_NEWSLETTER_API_KEY: 'SG.made-up-newsletter-key',
  SENDGRID_NEWSLETTER_WEBHOOK_KEY: newsletterWebhookPublicKey(),
  NEWSLETTER_EMAIL_FROM: 'news@shop.example.com',
  NEWSLETTER_BLOCK_SECRET: secretOf('a block secret of thirty-six bytes!'),
  NEWSLETTER_LINK_SECRET: secretOf('a link secret of thirty-six bytes!!'),
  NEWSLETTER_DAILY_LIMIT: '1000',
  TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRETS.pass,
};

const ecKey = (namedCurve: string) =>
  generateKeyPairSync('ec', { namedCurve }).publicKey.export({ type: 'spki', format: 'der' });

// what is no public key of the curve SendGrid signs with
const NOT_A_P256_KEY: [string, () => string][] = [
  ['text that is no base64', () => 'not a key at all!'],
  [
    'base64 of bytes that are no key',
    () => Buffer.from('made-up bytes, no key').toString('base64'),
  ],
  ['a public key of another curve (secp256k1)', () => ecKey('secp256k1').toString('base64')],
  ['a public key of another curve (P-384)', () => ecKey('secp384r1').toString('base64')],
  [
    'a public key of RSA',
    () =>
      generateKeyPairSync('rsa', { modulusLength: 2048 })
        .publicKey.export({ type: 'spki', format: 'der' })
        .toString('base64'),
  ],
  [
    'a private key',
    () =>
      generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .privateKey.export({ type: 'pkcs8', format: 'der' })
        .toString('base64'),
  ],
];

describe('env: the settings of the newsletters and of the captcha', () => {
  it.each(['development', 'production'])(
    'starts in %s with every setting given, trimmed, the limit as a number',
    async (mode) => {
      const loaded = await loadEnv({
        NODE_ENV: mode,
        ...Object.fromEntries(Object.entries(valid).map(([key, value]) => [key, ` ${value} `])),
      });

      expect(loaded).toMatchObject({ ...valid, NEWSLETTER_DAILY_LIMIT: 1000 });
    },
  );

  describe.each(['development', 'production'])('in %s', (mode) => {
    it.each(KEYS)('stops the start when %s is missing or only spaces', async (key) => {
      for (const value of ['', '   ']) {
        const err = await rejectedBy(() => loadEnv({ NODE_ENV: mode, ...valid, [key]: value }));

        expect((err as Error).message).toBe(`Missing required env variable: ${key}`);
      }
    });
  });

  // the tests give every setting a value of their own (tests/setup/isolateEnv.ts); one that is
  // missing does not stop them
  it('lets the tests start without any of them, the limit being 100', async () => {
    const loaded = await loadEnv({
      NODE_ENV: 'test',
      ...Object.fromEntries(KEYS.map((key) => [key, ''])),
    });

    expect(loaded).toMatchObject({
      SENDGRID_NEWSLETTER_API_KEY: '',
      SENDGRID_NEWSLETTER_WEBHOOK_KEY: '',
      NEWSLETTER_EMAIL_FROM: '',
      NEWSLETTER_BLOCK_SECRET: '',
      NEWSLETTER_LINK_SECRET: '',
      NEWSLETTER_DAILY_LIMIT: 100,
      TURNSTILE_SECRET_KEY: '',
    });
  });

  it('gives the tests the values of the setup: a webhook key that parses, secrets that differ', async () => {
    const loaded = await loadEnv({ NODE_ENV: 'test' });

    expect(loaded.SENDGRID_NEWSLETTER_WEBHOOK_KEY).toBe(newsletterWebhookPublicKey());
    expect(loaded.NEWSLETTER_BLOCK_SECRET).not.toBe(loaded.NEWSLETTER_LINK_SECRET);
    expect(loaded.TURNSTILE_SECRET_KEY).toBe(TURNSTILE_TEST_SECRETS.pass);
  });

  // a value that is given is read by the same rules in the tests: a typo in the setup shows at once
  it('reads a value that is given in the tests by the same rules', async () => {
    const err = await rejectedBy(() => loadEnv({ NODE_ENV: 'test', NEWSLETTER_DAILY_LIMIT: '0' }));

    expect((err as Error).message).toBe(
      'Invalid env variable: NEWSLETTER_DAILY_LIMIT must be a positive whole number',
    );
  });

  describe('SENDGRID_NEWSLETTER_WEBHOOK_KEY', () => {
    it('takes the base64 of a DER public key of the curve P-256, the one SendGrid shows', async () => {
      const key = ecKey('prime256v1').toString('base64');
      const loaded = await loadEnv({
        NODE_ENV: 'production',
        ...valid,
        SENDGRID_NEWSLETTER_WEBHOOK_KEY: key,
      });

      expect(loaded.SENDGRID_NEWSLETTER_WEBHOOK_KEY).toBe(key);
    });

    it.each(NOT_A_P256_KEY)('stops the start with %s', async (_case, make) => {
      const value = make();
      const err = await rejectedBy(() =>
        loadEnv({ NODE_ENV: 'production', ...valid, SENDGRID_NEWSLETTER_WEBHOOK_KEY: value }),
      );

      expect((err as Error).message).toBe(
        'Invalid env variable: SENDGRID_NEWSLETTER_WEBHOOK_KEY must be the base64 of a DER public key of an EC P-256 curve',
      );
      expect((err as Error).message).not.toContain(value);
    });
  });

  describe('NEWSLETTER_EMAIL_FROM', () => {
    it.each([
      'news',
      'news@shop',
      'News <news@shop.example.com>',
      'a b@shop.example.com',
      '@shop.example.com',
    ])('stops the start when it is %p, not an email address', async (value) => {
      const err = await rejectedBy(() =>
        loadEnv({ NODE_ENV: 'production', ...valid, NEWSLETTER_EMAIL_FROM: value }),
      );

      expect((err as Error).message).toBe(
        'Invalid env variable: NEWSLETTER_EMAIL_FROM must be an email address',
      );
      expect((err as Error).message).not.toContain(value);
    });
  });

  describe.each(['NEWSLETTER_BLOCK_SECRET', 'NEWSLETTER_LINK_SECRET'] as const)('%s', (key) => {
    const other =
      key === 'NEWSLETTER_BLOCK_SECRET' ? 'NEWSLETTER_LINK_SECRET' : 'NEWSLETTER_BLOCK_SECRET';

    it('takes 32 bytes, the least there is, in base64url', async () => {
      const value = randomBytes(32).toString('base64url');

      const loaded = await loadEnv({ NODE_ENV: 'production', ...valid, [key]: value });

      expect(loaded[key]).toBe(value);
    });

    // openssl rand -base64 gives this form, with the padding and the signs + and /
    it('takes the padded base64 of 47 bytes as well', async () => {
      const value = Buffer.from(Array.from({ length: 47 }, (_, i) => 251 - i)).toString('base64');
      expect(value).toMatch(/[+/]/);
      expect(value).toMatch(/=$/);

      const loaded = await loadEnv({ NODE_ENV: 'production', ...valid, [key]: value });

      expect(loaded[key]).toBe(value);
    });

    it.each([
      ['31 bytes', () => randomBytes(31).toString('base64url')],
      ['a short word', () => 'secret'],
      ['letters that are no base64', () => '!'.repeat(64)],
      ['spaces inside', () => `${'a'.repeat(30)} ${'b'.repeat(30)}`],
    ])('stops the start with %s', async (_case, make) => {
      const value = make();
      const err = await rejectedBy(() =>
        loadEnv({ NODE_ENV: 'production', ...valid, [key]: value }),
      );

      expect((err as Error).message).toBe(
        `Invalid env variable: ${key} must be base64 or base64url of at least 32 bytes`,
      );
      expect((err as Error).message).not.toContain(value);
    });

    // a link or a blocked address of one stops working with the other: the two must not share
    it(`stops the start when it equals ${other}`, async () => {
      const same = randomBytes(40).toString('base64url');
      const err = await rejectedBy(() =>
        loadEnv({ NODE_ENV: 'production', ...valid, [key]: same, [other]: same }),
      );

      expect((err as Error).message).toBe(
        'Invalid env variable: NEWSLETTER_BLOCK_SECRET and NEWSLETTER_LINK_SECRET must differ',
      );
      expect((err as Error).message).not.toContain(same);
    });

    // the same bytes written another way are the same secret
    it(`stops the start when it holds the bytes of ${other} in another spelling`, async () => {
      const bytes = randomBytes(33);
      const err = await rejectedBy(() =>
        loadEnv({
          NODE_ENV: 'production',
          ...valid,
          [key]: bytes.toString('base64url'),
          [other]: bytes.toString('base64'),
        }),
      );

      expect((err as Error).message).toContain('must differ');
    });

    it('is checked against the other in the tests too', async () => {
      const same = randomBytes(40).toString('base64url');
      const err = await rejectedBy(() => loadEnv({ NODE_ENV: 'test', [key]: same, [other]: same }));

      expect((err as Error).message).toContain('must differ');
    });
  });

  describe('NEWSLETTER_DAILY_LIMIT', () => {
    it.each(['0', '-1', '1.5', 'many', '1e3', '10 000'])(
      'stops the start when it is %p, not a whole number from 1',
      async (value) => {
        const err = await rejectedBy(() =>
          loadEnv({ NODE_ENV: 'production', ...valid, NEWSLETTER_DAILY_LIMIT: value }),
        );

        expect((err as Error).message).toBe(
          'Invalid env variable: NEWSLETTER_DAILY_LIMIT must be a positive whole number',
        );
        expect((err as Error).message).not.toContain(value);
      },
    );

    it('takes 1, the least there is', async () => {
      const loaded = await loadEnv({
        NODE_ENV: 'production',
        ...valid,
        NEWSLETTER_DAILY_LIMIT: '1',
      });

      expect(loaded.NEWSLETTER_DAILY_LIMIT).toBe(1);
    });
  });

  // the pause before a mail the provider failed on is tried again (it is also how long the pass that
  // took the mail keeps it) and how many times a mail is tried: optional, with the bounds the
  // functions of the database keep (1 to 1440 minutes, 1 to 20 tries)
  describe.each([
    ['NEWSLETTER_RETRY_MINUTES', 10, 1440],
    ['NEWSLETTER_MAX_ATTEMPTS', 5, 20],
  ] as const)('%s', (key, fallback, max) => {
    it(`is ${fallback} unless given, in every mode`, async () => {
      for (const mode of ['test', 'development']) {
        const loaded = await loadEnv({ NODE_ENV: mode, ...valid, [key]: '' });
        expect(loaded[key]).toBe(fallback);
      }
      expect((await loadEnv({ NODE_ENV: 'production', ...valid, [key]: '  ' }))[key]).toBe(
        fallback,
      );
    });

    it('is read as given, from 1 to its bound', async () => {
      expect((await loadEnv({ NODE_ENV: 'production', ...valid, [key]: ' 1 ' }))[key]).toBe(1);
      expect((await loadEnv({ NODE_ENV: 'production', ...valid, [key]: String(max) }))[key]).toBe(
        max,
      );
    });

    it.each(['0', '-1', '1.5', 'many', '1e1'])(
      'stops the start when it is %p, not a whole number from 1',
      async (value) => {
        const err = await rejectedBy(() =>
          loadEnv({ NODE_ENV: 'production', ...valid, [key]: value }),
        );

        expect((err as Error).message).toBe(
          `Invalid env variable: ${key} must be a positive whole number`,
        );
      },
    );

    it('stops the start above its bound, naming the bound and not the value', async () => {
      const value = String(max + 1);
      const err = await rejectedBy(() =>
        loadEnv({ NODE_ENV: 'production', ...valid, [key]: value }),
      );

      expect((err as Error).message).toBe(`Invalid env variable: ${key} must be at most ${max}`);
      expect((err as Error).message).not.toContain(value);
    });
  });

  // the backup secret of the widget of dev is kept in the environment of the host for the person,
  // the app does not read it
  it('does not read TURNSTILE_SECRET_KEY_DEV_WIDGET', async () => {
    const widget = '0x4AAAAAAA-the-secret-of-the-widget-of-dev';
    const loaded = await loadEnv({
      NODE_ENV: 'production',
      ...valid,
      TURNSTILE_SECRET_KEY_DEV_WIDGET: widget,
    });

    expect(JSON.stringify(loaded)).not.toContain(widget);
    expect(loaded.TURNSTILE_SECRET_KEY).toBe(valid.TURNSTILE_SECRET_KEY);
  });
});

// the same keys in the example of the env file and in the configuration page of the docs (the rules
// of the project): left empty in the example, with a line of their own in the docs
describe('env: the newsletters and the captcha in the example and the docs', () => {
  const example = readFileSync('.env.example', 'utf8').split(/\r?\n/);
  const docs = readFileSync('docs/configuration.md', 'utf8').split(/\r?\n/);

  it.each(KEYS)('lists %s in .env.example, left empty, under a comment', (key) => {
    const at = example.indexOf(`${key}=`);

    expect(at).toBeGreaterThan(0);
    expect(example[at - 1]).toMatch(/^\/\/ \S/);
  });

  it.each(KEYS)('lists %s in docs/configuration.md under a comment', (key) => {
    const at = docs.findIndex((line) => line.startsWith(`${key}=`));

    expect(at).toBeGreaterThan(0);
    expect(docs[at - 1]).toMatch(/^# \S/);
  });

  it.each(OPTIONAL_KEYS)(
    'lists the optional %s in .env.example, left empty, under a comment',
    (key) => {
      const at = example.indexOf(`${key}=`);

      expect(at).toBeGreaterThan(0);
      expect(example[at - 1]).toMatch(/^\/\/ \S/);
    },
  );

  it.each(OPTIONAL_KEYS)(
    'lists the optional %s in docs/configuration.md under a comment',
    (key) => {
      const at = docs.findIndex((line) => line.startsWith(`${key}=`));

      expect(at).toBeGreaterThan(0);
      expect(docs[at - 1]).toMatch(/^# \S/);
    },
  );

  // the widget secret of dev is no setting: the app never reads it, so no file lists it as one
  it('lists TURNSTILE_SECRET_KEY_DEV_WIDGET in neither', () => {
    expect(example.some((line) => line.startsWith('TURNSTILE_SECRET_KEY_DEV_WIDGET'))).toBe(false);
    expect(docs.some((line) => line.startsWith('TURNSTILE_SECRET_KEY_DEV_WIDGET'))).toBe(false);
  });

  // changing either secret after the launch stops the links of the mails sent and the entries of
  // the blocklist from working: the docs say so in the comment of the key, and that the value
  // differs between the environments
  it.each(['NEWSLETTER_BLOCK_SECRET', 'NEWSLETTER_LINK_SECRET'])(
    'tells at %s that it differs between the environments and is never changed',
    (key) => {
      const at = docs.findIndex((line) => line.startsWith(`${key}=`));
      let start = at;
      while (start > 0 && docs[start - 1]!.startsWith('# ')) start -= 1;
      const comment = docs.slice(start, at).join(' ');

      expect(comment).toMatch(/differ/i);
      expect(comment).toMatch(/never changed|do not change|not be changed/i);
    },
  );
});
