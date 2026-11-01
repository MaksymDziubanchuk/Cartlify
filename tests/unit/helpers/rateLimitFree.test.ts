import { describe, expect, it } from '@jest/globals';

import { isRateLimitFree } from '@helpers/rateLimitFree.js';

import { shopLogoUrl } from '../../helpers/shopLogo.js';

describe('isRateLimitFree', () => {
  it.each([
    '/health',
    '/health/',
    '/ready',
    shopLogoUrl(),
    '/api/payments/stripe/webhook',
    '/api/payments/stripe/webhook?from=stripe',
  ])('leaves %s out of the rate limit', (url) => {
    expect(isRateLimitFree(url)).toBe(true);
  });

  // only the exact path of a provider: anything that only starts like it is counted
  it.each(['/api/products', '/api/payments/stripe/webhooks', '/api/payments/stripe/webhook/x'])(
    'counts %s',
    (url) => {
      expect(isRateLimitFree(url)).toBe(false);
    },
  );
});
