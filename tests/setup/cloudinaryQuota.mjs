import { existsSync, readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import path from 'node:path';

import { parse } from 'dotenv';

// the admin api of Cloudinary answers a few hundred calls an hour (the plan of the account), and the
// tests read the files they check through it (tests/helpers/cloudinary.ts): tests/run.mjs asks what
// is left before a run with the real service and after it. The keys are the ones the tests take
// (tests/setup/integration.setup.ts): a value of the environment first, then the local .env. No
// value of them is printed, the text of an error goes out with each of them hidden

const KEYS = [
  'CLOUDINARY_URL',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

function readKeys(rootDir) {
  const file = path.join(rootDir, '.env');
  const local = existsSync(file) ? parse(readFileSync(file)) : {};

  return Object.fromEntries(
    KEYS.map((key) => [
      key,
      (process.env[key] !== undefined ? process.env[key] : local[key]) ?? '',
    ]),
  );
}

// cloudinary://<api_key>:<api_secret>@<cloud_name>, or the three keys
function credentialsOf(keys) {
  const raw = keys.CLOUDINARY_URL.trim();
  if (raw) {
    try {
      const url = new URL(raw);
      return {
        cloud_name: url.hostname,
        api_key: decodeURIComponent(url.username),
        api_secret: decodeURIComponent(url.password),
      };
    } catch {
      return null;
    }
  }

  const creds = {
    cloud_name: keys.CLOUDINARY_CLOUD_NAME.trim(),
    api_key: keys.CLOUDINARY_API_KEY.trim(),
    api_secret: keys.CLOUDINARY_API_SECRET.trim(),
  };
  return creds.cloud_name && creds.api_key && creds.api_secret ? creds : null;
}

const hide = (text, secrets) =>
  secrets.filter(Boolean).reduce((out, secret) => out.replaceAll(secret, '[hidden]'), text);

// { allowed, remaining, resetAt } of the admin api now (the ping that asks takes none of it), or
// { error } with a text that is safe to print
export async function cloudinaryQuota(rootDir) {
  const keys = readKeys(rootDir);
  const creds = credentialsOf(keys);
  if (!creds) return { error: 'no keys of Cloudinary in the environment or in .env' };

  const secrets = [...Object.values(creds), keys.CLOUDINARY_URL.trim()];
  try {
    // loaded here, the way src/config/cloudinary.ts does it: the sdk reads CLOUDINARY_URL when it
    // loads, and its errors may quote it
    const { v2: cloudinary } = await import('cloudinary');
    cloudinary.config({ ...creds, secure: true });
    // a connection of its own: node keeps the one of the ping before the run open, and after a run
    // of twenty minutes the other side has closed it (write ECONNABORTED)
    const res = await cloudinary.api.ping({ agent: new Agent({ keepAlive: false }) });
    const resetAt = res.rate_limit_reset_at;
    if (
      !Number.isInteger(res.rate_limit_remaining) ||
      !(resetAt instanceof Date) ||
      Number.isNaN(resetAt.getTime())
    ) {
      return { error: 'the answer of Cloudinary named no limit of its admin api' };
    }

    return {
      allowed: res.rate_limit_allowed,
      remaining: res.rate_limit_remaining,
      resetAt,
    };
  } catch (err) {
    const e = err?.error ?? err;
    return { error: hide(`${e?.http_code ?? ''} ${e?.message ?? String(err)}`.trim(), secrets) };
  }
}
