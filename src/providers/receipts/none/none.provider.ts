import type { ReceiptProvider } from '../types.js';

// No fiscal receipts: a shop of a country whose online sales by card need none. Nothing is made,
// nothing is asked
export const noneReceiptProvider: ReceiptProvider = {
  name: 'none',
  label: 'No receipts',
  makesReceipts: () => false,
  isConfigured: () => true,
  sellerCountries: () => null,
  fixedMoment: () => null,
  issue() {
    throw new Error('the provider none makes no receipts');
  },
  status() {
    throw new Error('the provider none makes no receipts');
  },
};
