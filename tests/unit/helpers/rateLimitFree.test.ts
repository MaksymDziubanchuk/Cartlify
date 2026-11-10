import { describe, expect, it } from '@jest/globals';

import { isRateLimitFree } from '@helpers/rateLimitFree.js';

describe('isRateLimitFree', () => {
  it.each([
    '/health',
    '/health/',
    '/ready',
    '/api/payments/stripe/webhook',
    '/api/payments/stripe/webhook?from=stripe',
    // the Event Webhook of SendGrid for the newsletters: it delivers from a few addresses, the
    // signature keeps anybody else out
    '/api/newsletters/sendgrid/webhook',
    '/api/newsletters/sendgrid/webhook?retry=1',
    // the unsubscribe button of the mails (the POST of a mail client and the GET of the link): a
    // mailbox provider unsubscribes many readers from a few addresses, so the button keeps only its
    // own count (LIMIT_NEWSLETTER_UNSUBSCRIBE_PER_ADDRESS). The swagger document reads the route
    // pattern, the rate limit the address with a token
    '/api/newsletters/unsubscribe/a-token',
    '/api/newsletters/unsubscribe/a-token?c=12',
    '/api/newsletters/unsubscribe/:token',
  ])('leaves %s out of the rate limit', (url) => {
    expect(isRateLimitFree(url)).toBe(true);
  });

  // only the exact path of a provider: anything that only starts like it is counted. There is no
  // /static any more either (the logo is on Cloudinary, shopSettings.logoUrl)
  it.each([
    '/api/products',
    '/api/payments/stripe/webhooks',
    '/api/payments/stripe/webhook/x',
    '/api/newsletters/sendgrid/webhooks',
    '/api/newsletters/sendgrid/webhook/x',
    '/api/newsletters/sendgrid',
    '/api/newsletters/subscriptions',
    // the button is one segment after the path: nothing else that starts like it is let through
    '/api/newsletters/unsubscribe',
    '/api/newsletters/unsubscribe/',
    '/api/newsletters/unsubscribe/a-token/more',
    '/api/newsletters/unsubscribed/a-token',
    '/api/newsletters/manage/unsubscribe',
    '/static/images/logo-mail.png',
  ])('counts %s', (url) => {
    expect(isRateLimitFree(url)).toBe(false);
  });
});
