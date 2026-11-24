import env from '@config/env.js';

import { pickProvider } from '../provider.js';

import { fiskalyReceiptProvider } from './fiskaly/fiskaly.provider.js';
import { RECEIPT_PROVIDER_NAMES } from './names.js';
import { noneReceiptProvider } from './none/none.provider.js';
import type { ReceiptProvider } from './types.js';

export * from './names.js';
export * from './types.js';

// every provider of fiscal receipts this server has; RECEIPT_PROVIDER names the one it works with
// (docs/taxes.md). A new service of a country (Checkbox for Ukraine) is a folder and a line here
const providers: readonly ReceiptProvider[] = [noneReceiptProvider, fiskalyReceiptProvider];

// the list the settings take the names from is the list of the providers themselves
if (
  providers.length !== RECEIPT_PROVIDER_NAMES.length ||
  providers.some((provider, i) => provider.name !== RECEIPT_PROVIDER_NAMES[i])
) {
  throw new Error('RECEIPT_PROVIDER_NAMES must name the receipt providers in the same order');
}

export const receiptProvider: ReceiptProvider = pickProvider(
  'RECEIPT_PROVIDER',
  env.RECEIPT_PROVIDER,
  providers,
);
