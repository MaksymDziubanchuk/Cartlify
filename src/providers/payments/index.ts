import env from '@config/env.js';
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

export const paymentProviders = providers;

// a provider by the name a request or an order gives; a name this server has no provider for
// (an order paid through a provider that was taken off) is a server error
export function getPaymentProvider(name: PaymentProviderName): PaymentProvider {
  const provider = providers.find((candidate) => candidate.name === name);

  if (!provider)
    throw new InternalError({ reason: 'PAYMENT_PROVIDER_NOT_AVAILABLE', provider: name });

  return provider;
}

// the currency of the shop (SHOP_CURRENCY): of the prices of the catalog, and the one every
// provider charges in
export function shopCurrency(): string {
  return env.SHOP_CURRENCY;
}

// the smallest total some provider takes: the confirmation refuses only a total no provider takes,
// the payment page checks the minimum of the provider the buyer picked
export function lowestMinimumTotal(): number {
  return Math.min(...providers.map((provider) => provider.minimumTotal));
}

// how long the payment pages may stay open after a reservation, the bounds every provider keeps:
// the longest least and the shortest most
export function paymentPageBounds(): { least: number; mostWithReservation: number } {
  return {
    least: Math.max(...providers.map((provider) => provider.pageMinutes.least)),
    mostWithReservation: Math.min(
      ...providers.map((provider) => provider.pageMinutes.mostWithReservation),
    ),
  };
}

// the paths the payment events of the providers come to
export const PAYMENT_CALLBACK_PATHS: readonly string[] = providers.flatMap(
  (provider) => provider.callbackPaths,
);

// the json schemas the routes of the providers refer to
export const paymentProviderSchemas = providers.flatMap((provider) => provider.schemas);
