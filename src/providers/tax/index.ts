import env from '@config/env.js';

import { pickProvider } from '../provider.js';

import { TAX_PROVIDER_NAMES } from './names.js';
import { ownTaxProvider } from './own/own.provider.js';
import type { TaxProvider } from './types.js';

export * from './names.js';
export * from './types.js';

// every provider of the tax of a cart this server has; TAX_PROVIDER names the one it counts with.
// The first is our own logic by the records of the countries; an outside service for countries with
// a tax of their states and cities would be another folder and a line here
const providers: readonly TaxProvider[] = [ownTaxProvider];

// the list the settings take the names from is the list of the providers themselves
if (
  providers.length !== TAX_PROVIDER_NAMES.length ||
  providers.some((provider, i) => provider.name !== TAX_PROVIDER_NAMES[i])
) {
  throw new Error('TAX_PROVIDER_NAMES must name the tax providers in the same order');
}

export const taxProvider: TaxProvider = pickProvider('TAX_PROVIDER', env.TAX_PROVIDER, providers);
