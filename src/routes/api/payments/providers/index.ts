import { InternalError } from '@utils/errors.js';

import { PAYMENT_PROVIDER_NAMES } from './names.js';
import { stripeProvider } from './stripe/stripe.provider.js';

import type { PaymentProvider, PaymentProviderName } from './types.js';

export * from './names.js';
export type * from './types.js';

// every provider this server has; none of them is the main one, a request names the one to pay with
const providers: readonly PaymentProvider[] = [stripeProvider];

// the list the schemas take the names from is the list of the providers themselves
if (
  providers.length !== PAYMENT_PROVIDER_NAMES.length ||
  providers.some((provider, i) => provider.name !== PAYMENT_PROVIDER_NAMES[i])
) {
  throw new Error('PAYMENT_PROVIDER_NAMES must name the payment providers in the same order');
}

// the prices of the catalog are numbers in one currency: a provider set up with another currency
// would charge the same numbers in other money, so the server does not start that way
if (new Set(providers.map((provider) => provider.currency)).size !== 1) {
  throw new Error('every payment provider must charge in the same currency');
}

export const paymentProviders = providers;

// a provider by the name a request or an order gives; a name this server has no provider for
// (an order paid through a provider that was taken off) is a server error
export function getPaymentProvider(name: PaymentProviderName): PaymentProvider {
  const provider = providers.find((candidate) => candidate.name === name);

  if (!provider)
    throw new InternalError({ reason: 'PAYMENT_PROVIDER_NOT_AVAILABLE', provider: name });

  return provider;
}

// the currency of the catalog prices, the one every provider charges in
export function shopCurrency(): string {
  return providers[0]!.currency;
}

// the currency of an order: of the provider that took its money, of the shop before it was paid
export function currencyOf(provider: PaymentProviderName | null | undefined): string {
  return provider ? getPaymentProvider(provider).currency : shopCurrency();
}

// the smallest total some provider takes: the confirmation refuses only a total no provider takes,
// the payment page checks the minimum of the provider the buyer picked
export function lowestMinimumTotal(): number {
  return Math.min(...providers.map((provider) => provider.minimumTotal));
}

// the paths the payment events of the providers come to
export const PAYMENT_CALLBACK_PATHS: ReadonlySet<string> = new Set(
  providers.map((provider) => provider.callbackPath),
);
