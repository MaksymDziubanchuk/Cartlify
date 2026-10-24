import { describe, expect, it } from '@jest/globals';

import { startupWarnings } from '@config/startupWarnings.js';

describe('startupWarnings', () => {
  // in production env.ts stops the start instead, see tests/unit/config/env.test.ts
  it.each(['development', 'test'])(
    'warns in %s that stripe events are refused without the webhook secret',
    (mode) => {
      expect(startupWarnings({ NODE_ENV: mode, STRIPE_WEBHOOK_SECRET: '' })).toEqual([
        'STRIPE_WEBHOOK_SECRET is not set: every stripe event is refused, no order becomes paid',
      ]);
    },
  );

  it('says nothing when the webhook secret is set', () => {
    expect(
      startupWarnings({ NODE_ENV: 'development', STRIPE_WEBHOOK_SECRET: 'whsec_local' }),
    ).toEqual([]);
  });

  it('never quotes a value of the settings', () => {
    const warnings = startupWarnings({ NODE_ENV: 'development', STRIPE_WEBHOOK_SECRET: '' });

    expect(warnings.join(' ')).not.toContain('whsec_');
  });
});
