import Stripe from 'stripe';

import env from '@config/env.js';
import { InternalError } from '@utils/errors.js';

// reads non-empty string from env
function readEnvString(key: string): string | undefined {
  const raw = (env as Record<string, unknown>)[key];
  if (typeof raw !== 'string') return undefined;

  const value = raw.trim();
  return value.length > 0 ? value : undefined;
}

// gets stripe secret key from env
function getStripeSecretKey(): string {
  const secretKey = readEnvString('STRIPE_SECRET_KEY');

  if (!secretKey) {
    throw new InternalError({
      key: 'STRIPE_SECRET_KEY',
      reason: 'missing_env_var',
    });
  }

  if (!secretKey.startsWith('sk_')) {
    throw new InternalError({
      key: 'STRIPE_SECRET_KEY',
      reason: 'invalid_secret_key',
    });
  }

  return secretKey;
}

// creates stripe sdk once at module load
const stripe = new Stripe(getStripeSecretKey(), {
  // pinned, so a new sdk version does not change the api version of every request by itself
  apiVersion: '2026-09-30.endive',
  // a call inside a transaction must end before it does: by default the sdk waits 80 s and tries
  // 3 times, and a refund that came after the 20 s of the cancel left the order paid with its money
  // back. 10 s, one more try
  timeout: 10_000,
  maxNetworkRetries: 1,
});

export { stripe };
export default stripe;
