import { describe, expect, it } from '@jest/globals';

import { isRateLimitFree } from '@helpers/rateLimitFree.js';

describe('isRateLimitFree', () => {
  it.each([
    '/health',
    '/health/',
    '/ready',
    '/api/payments/stripe/webhook',
    '/api/payments/stripe/webhook?from=stripe',
  ])('leaves %s out of the rate limit', (url) => {
    expect(isRateLimitFree(url)).toBe(true);
  });

  // only the exact path of a provider: anything that only starts like it is counted. There is no
  // /static any more either (the logo is on Cloudinary, shopSettings.logoUrl)
  it.each([
    '/api/products',
    '/api/payments/stripe/webhooks',
    '/api/payments/stripe/webhook/x',
    '/static/images/logo-mail.png',
  ])('counts %s', (url) => {
    expect(isRateLimitFree(url)).toBe(false);
  });
});
