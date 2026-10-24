import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';

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

  process.env.NODE_ENV = 'test';

  Object.assign(process.env, overrides);
}
