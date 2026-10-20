import { describe, expect, it } from '@jest/globals';

import {
  formatPaymentPageLink,
  parsePaymentPageLink,
} from '@routes/api/payments/providers/pageLink.js';

// the link redis keeps from an order to its payment page names the provider of the page, so the
// page is closed by the one that opened it
describe('payment page link', () => {
  it('keeps the provider with the id of the page', () => {
    expect(formatPaymentPageLink({ provider: 'stripe', pageId: 'cs_test_1' })).toBe(
      'stripe:cs_test_1',
    );
    expect(parsePaymentPageLink('stripe:cs_test_1')).toEqual({
      provider: 'stripe',
      pageId: 'cs_test_1',
    });
  });

  it('keeps an id with a colon of its own whole', () => {
    const page = { provider: 'stripe', pageId: 'dev:12:1700000000000' } as const;

    expect(parsePaymentPageLink(formatPaymentPageLink(page))).toEqual(page);
  });

  // a link written before links named the provider, or of a provider the server has not:
  // there is no page it could close
  it.each([
    ['a link of the old form without a provider', 'cs_test_1'],
    ['a provider this server has not', 'liqpay:dev-12-1700000000000'],
    ['a link without a page', 'stripe:'],
    ['a link without a provider', ':cs_test_1'],
    ['an empty link', ''],
    ['no link', null],
  ])('leads to no page for %s', (_case, link) => {
    expect(parsePaymentPageLink(link)).toBeNull();
  });
});
