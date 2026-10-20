import { describe, expect, it } from '@jest/globals';

import {
  PAYMENT_CALLBACK_PATHS,
  PAYMENT_PROVIDER_NAMES,
  currencyOf,
  getPaymentProvider,
  isAvailablePaymentProvider,
  lowestMinimumTotal,
  paymentProviders,
  shopCurrency,
} from '@routes/api/payments/providers/index.js';
import { stripeProvider } from '@routes/api/payments/providers/stripe/stripe.provider.js';

import { thrownBy } from '../../../../../helpers/errors.js';

// the payment providers of the server: none is the main one, a request names the one to pay with
describe('payment providers', () => {
  it('lists the providers the schemas name, stripe for now', () => {
    expect(PAYMENT_PROVIDER_NAMES).toEqual(['stripe']);
    expect(paymentProviders.map((provider) => provider.name)).toEqual([...PAYMENT_PROVIDER_NAMES]);
  });

  it('gives a provider by its name', () => {
    expect(getPaymentProvider('stripe')).toBe(stripeProvider);
  });

  // the database knows liqpay already, this server has no such provider yet
  it('refuses a provider this server has not as a server error', () => {
    expect(thrownBy(() => getPaymentProvider('liqpay'))).toMatchObject({
      statusCode: 500,
      details: { reason: 'PAYMENT_PROVIDER_NOT_AVAILABLE', provider: 'liqpay' },
    });
  });

  it.each([
    ['stripe', true],
    ['liqpay', false],
    ['Stripe', false],
    ['', false],
    [undefined, false],
  ])('tells whether %p is a provider of this server', (value, expected) => {
    expect(isAvailablePaymentProvider(value)).toBe(expected);
  });

  it('takes the shop currency from the providers, they all charge in it', () => {
    expect(shopCurrency()).toBe(stripeProvider.currency);
  });

  it('gives an order the currency of the provider that took its money, the shop one before', () => {
    expect(currencyOf('stripe')).toBe(stripeProvider.currency);
    expect(currencyOf(null)).toBe(shopCurrency());
  });

  it('takes the smallest minimum of the providers', () => {
    expect(lowestMinimumTotal()).toBe(stripeProvider.minimumTotal);
  });

  it('keeps the path of every provider for its payment events', () => {
    expect([...PAYMENT_CALLBACK_PATHS]).toEqual(['/api/payments/stripe/webhook']);
  });
});
