import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';

import { newsletterWebhookPublicKey } from '../helpers/newsletterWebhookKey.js';

// The dummy secret keys Cloudflare publishes for Turnstile (developers.cloudflare.com/turnstile/
// troubleshooting/testing): siteverify answers each the same way for any response, so the tests need
// no widget and no account. The first is the secret of the app in the tests
export const TURNSTILE_TEST_SECRETS = {
  // always passes
  pass: '1x0000000000000000000000000000000AA',
  // always fails with invalid-input-response
  fail: '2x0000000000000000000000000000000AA',
  // always fails with timeout-or-duplicate, a response that was used before
  spent: '3x0000000000000000000000000000000AA',
} as const;

// the settings of the newsletters src/config/env.ts requires outside the tests; synthetic, and the
// same for every run: the SendGrid key and the secrets are no real ones (the secrets are the bytes
// of a sentence, they differ), the Event Webhook key is the public half of a pair the tests make
// (tests/helpers/newsletterWebhookKey.ts), the secret of Turnstile is the dummy one that passes
function newsletterTestEnv(): Record<string, string> {
  const secret = (sentence: string) => Buffer.from(sentence).toString('base64url');

  return {
    SENDGRID_NEWSLETTER_API_KEY: 'SG.cartlify-tests-newsletter-mock',
    SENDGRID_NEWSLETTER_WEBHOOK_KEY: newsletterWebhookPublicKey(),
    NEWSLETTER_EMAIL_FROM: 'news@shop.example.com',
    NEWSLETTER_BLOCK_SECRET: secret('cartlify-tests-newsletter-block-secret'),
    NEWSLETTER_LINK_SECRET: secret('cartlify-tests-newsletter-link-secret'),
    NEWSLETTER_DAILY_LIMIT: '100',
    TURNSTILE_SECRET_KEY: TURNSTILE_TEST_SECRETS.pass,
  };
}

// values src/config/{env,stripe,cloudinary}.ts require at import time, synthetic for tests;
// without real cloudinary keys the placeholders keep uploads away from the account
export const CLOUDINARY_PLACEHOLDERS = {
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-api-key',
  CLOUDINARY_API_SECRET: 'test-api-secret',
};

// a key of the right form that Stripe does not know: the key of the Stripe mock of the tests, so
// nothing reaches Stripe unless a run takes it for real with its test key
export const STRIPE_PLACEHOLDER_KEY = 'sk_test_placeholder';

const REQUIRED_AT_IMPORT: Record<string, string> = {
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  STRIPE_SECRET_KEY: STRIPE_PLACEHOLDER_KEY,
  // required when a test loads a module in production; a test without it sets it empty itself
  STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
  // signs the codes of the links of withdrawal
  WITHDRAWAL_CODE_SECRET: 'test-withdrawal-code-secret-of-the-integration-tests',
  // required when a test loads a module in development or production: the address of the API itself,
  // the one the tests fall back to without it (src/helpers/apiOrigin.ts)
  API_ORIGIN: 'http://localhost:4000',
  ...CLOUDINARY_PLACEHOLDERS,
};

// keys the app reads, .env.example lists all of them
function readEnvKeys(): string[] {
  const example = readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');

  return [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!);
}

// only the named keys of the local .env; its values are never printed
function readLocalEnv(keys: readonly string[]): Record<string, string> {
  const file = path.join(process.cwd(), '.env');
  if (!keys.length || !existsSync(file)) return {};

  const all = parse(readFileSync(file));
  return Object.fromEntries(keys.filter((key) => all[key]).map((key) => [key, all[key]!]));
}

// keep the local .env (it points to the shared dev database) out of tests:
// dotenv never overwrites a variable that is already set, even to an empty string.
// fromLocalEnv names the few keys tests may still take from it (a service without a test mode
// of its own); a value passed from the real environment wins over the file
export function isolateEnv(
  overrides: Record<string, string>,
  opts: { fromLocalEnv?: readonly string[] } = {},
): void {
  for (const [key, value] of Object.entries(readLocalEnv(opts.fromLocalEnv ?? []))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  for (const key of readEnvKeys()) {
    // values passed from the real environment (for example ci secrets) stay
    if (process.env[key] === undefined) process.env[key] = '';
  }

  for (const [key, value] of Object.entries(REQUIRED_AT_IMPORT)) {
    if (!process.env[key]) process.env[key] = value;
  }

  // never from the shell: a key of a real account must not reach a test
  Object.assign(process.env, newsletterTestEnv());

  process.env.NODE_ENV = 'test';

  Object.assign(process.env, overrides);
}
