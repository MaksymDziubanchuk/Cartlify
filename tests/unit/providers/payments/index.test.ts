import { describe, expect, it } from '@jest/globals';

import {
  PAYMENT_CALLBACK_PATHS,
  PAYMENT_PROVIDER_NAMES,
  getPaymentProvider,
  isAvailablePaymentProvider,
  lowestMinimumTotal,
  paymentPageBounds,
  paymentProviderSchemas,
  paymentProviders,
  shopCurrency,
} from '@providers/payments/index.js';
import env from '@config/env.js';
import { stripeProvider } from '@providers/payments/stripe/stripe.provider.js';

import { thrownBy } from '../../../helpers/errors.js';

// the payment providers of the server: none is the main one, a request names the one to pay with
describe('payment providers', () => {
  it('lists the providers the schemas name, stripe for now', () => {
    expect(PAYMENT_PROVIDER_NAMES).toEqual(['stripe']);
    expect(paymentProviders.map((provider) => provider.name)).toEqual([...PAYMENT_PROVIDER_NAMES]);
  });

  it('gives a provider by its name', () => {
    expect(getPaymentProvider('stripe')).toBe(stripeProvider);
  });

  // a name the server has no provider for: an order paid through a provider that was taken off
  it('refuses a provider this server has not as a server error', () => {
    expect(thrownBy(() => getPaymentProvider('paypal' as never))).toMatchObject({
      statusCode: 500,
      details: { reason: 'PAYMENT_PROVIDER_NOT_AVAILABLE', provider: 'paypal' },
    });
  });

  it.each([
    ['stripe', true],
    ['paypal', false],
    ['Stripe', false],
    ['', false],
    [undefined, false],
  ])('tells whether %p is a provider of this server', (value, expected) => {
    expect(isAvailablePaymentProvider(value)).toBe(expected);
  });

  it('takes the currency of the shop from its setting, every provider charges in it', () => {
    expect(shopCurrency()).toBe(env.SHOP_CURRENCY);
  });

  it('keeps the payment page in the bounds of every provider', () => {
    expect(paymentPageBounds()).toEqual(stripeProvider.pageMinutes);
  });

  it('hands the app the schemas the routes of every provider refer to', () => {
    expect(paymentProviderSchemas.map((schema) => schema.$id)).toEqual(
      stripeProvider.schemas.map((schema) => schema.$id),
    );
  });

  it('takes the smallest minimum of the providers', () => {
    expect(lowestMinimumTotal()).toBe(stripeProvider.minimumTotal);
  });

  it('keeps the path of every provider for its payment events', () => {
    expect(PAYMENT_CALLBACK_PATHS).toEqual(['/api/payments/stripe/webhook']);
  });
});
