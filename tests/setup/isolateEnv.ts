import { readFileSync } from 'node:fs';
import path from 'node:path';

// values src/config/{env,stripe,cloudinary}.ts require at import time, synthetic for tests;
// the cloudinary placeholders also keep uploads away from the real account
const REQUIRED_AT_IMPORT: Record<string, string> = {
  JWT_ACCESS_SECRET: 'test-access-secret',
  JWT_REFRESH_SECRET: 'test-refresh-secret',
  STRIPE_SECRET_KEY: 'sk_test_placeholder',
  CLOUDINARY_CLOUD_NAME: 'test-cloud',
  CLOUDINARY_API_KEY: 'test-api-key',
  CLOUDINARY_API_SECRET: 'test-api-secret',
};

// keys the app reads, .env.example lists all of them
function readEnvKeys(): string[] {
  const example = readFileSync(path.join(process.cwd(), '.env.example'), 'utf8');

  return [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!);
}

// keep the local .env (it points to the shared dev database) out of tests:
// dotenv never overwrites a variable that is already set, even to an empty string
export function isolateEnv(overrides: Record<string, string>): void {
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
