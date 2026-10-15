import { inspect } from 'node:util';
import { describe, expect, it } from '@jest/globals';

import { rejectedBy } from '../../helpers/errors.js';
import { importWithEnv } from '../../helpers/freshImport.js';

type StripeConfig = typeof import('@config/stripe.js');

// synthetic keys; the module creates the sdk at import and refuses to load without a secret key
const load = (key: string) =>
  importWithEnv<StripeConfig>('@config/stripe.js', { STRIPE_SECRET_KEY: key });

describe('stripe config', () => {
  it('creates the sdk with a secret key, without calling stripe', async () => {
    const { stripe } = await load('sk_test_unit_key');

    expect(typeof stripe.checkout.sessions.create).toBe('function');
    expect(typeof stripe.webhooks.constructEvent).toBe('function');
  });

  it('accepts a key with spaces around it', async () => {
    await expect(load('  sk_test_unit_key  ')).resolves.toHaveProperty('stripe');
  });

  it.each([
    ['missing', ''],
    ['blank', '   '],
  ])('refuses to start when the key is %s', async (_case, key) => {
    const err = await rejectedBy(() => load(key));

    expect(err).toMatchObject({ statusCode: 500, details: { key: 'STRIPE_SECRET_KEY' } });
  });

  it('refuses a publishable key, it cannot act on the account', async () => {
    const err = await rejectedBy(() => load('pk_test_unit_key'));

    expect(err).toMatchObject({ statusCode: 500, details: { key: 'STRIPE_SECRET_KEY' } });
  });

  // the start error lands in the hosting logs, the key must not go with it
  it('never prints the key it refused', async () => {
    const err = await rejectedBy(() => load('pk_test_unit_key'));

    expect(inspect(err, { depth: 10 })).not.toContain('pk_test_unit_key');
  });
});
