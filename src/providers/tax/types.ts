import type { Prisma } from '@prisma/client';

import type { TaxRuleName } from '@config/shopCountries.js';

import type { Provider } from '../provider.js';
import type { TaxProviderName } from './names.js';

// The tax of a cart (docs/taxes.md): how much of the price of each item and of the delivery is tax,
// by which rule and rate, the prices a rule without the tax of the seller leaves, and why a sale
// cannot go there now. The app asks before it shows the prices for an address and again when the
// order is confirmed; the confirmation keeps the answer (db/05, confirm_order). The code knows no
// law of a country: the rules, the rates and the conditions are what root wrote for each country
// (@config/shopCountries.js).

// the sale stops at a threshold of a country where the shop is not registered for the tax
export const TAX_SALES_STOPPED = 'TAX_SALES_STOPPED';
// the parcel is within the limit of a country where the shop is not registered for the tax: the
// buyer can order above the limit, where the tax is paid on receipt
export const TAX_PARCEL_LIMIT = 'TAX_PARCEL_LIMIT';

export type TaxLineInput = {
  // the item of the order it is about
  key: number;
  productId: number;
  // the group of the product and the countries that class it in another one
  groupId: number | null;
  exceptions: Readonly<Record<string, number | null>>;
  quantity: number;
  // the price of the catalog, which holds the tax of the seller when the shop takes it
  unitPrice: number;
};

export type TaxInput = {
  // where the sale is taxed: the country of the recipient, or of the pickup
  country: string;
  lines: readonly TaxLineInput[];
  // the price of the delivery before the rule for the items at the prices the rule leaves: the price
  // of the zone and its free-from sum, or the price of the carrier (deliveryRuleOf); none for a pickup
  delivery: ((itemsTotal: number) => { flat: number | null; freeFrom: number | null }) | null;
  // the moment whose rates and threshold count
  at: Date;
};

export type TaxLine = {
  key: number;
  // the rule the item is sold by; null when the shop takes no tax there
  rule: TaxRuleName | null;
  // the country the tax is of (the seller's or the recipient's); null with no rule
  country: string | null;
  groupId: number | null;
  // the rate in percent; null for a rule that takes no tax
  rate: number | null;
  // the unit price the rule leaves (lower than the catalog only for a rule without the tax of the
  // seller), the price of the line and the tax it holds
  unitPrice: number;
  total: number;
  tax: number;
};

export type TaxDelivery = {
  // the price of the delivery the rule leaves before the free-from sum, and the price after it
  // (confirm_order is given the first and the sum, and comes to the second)
  flat: number | null;
  freeFrom: number | null;
  price: number;
  rule: TaxRuleName | null;
  // the tax the price holds, by rate
  parts: { rate: number; gross: number; tax: number }[];
  tax: number;
};

// the sums of the order by rate (null for the part without tax)
export type TaxTotal = { rate: number | null; net: number; tax: number; gross: number };

export type TaxRefusal =
  | { code: typeof TAX_SALES_STOPPED }
  | { code: typeof TAX_PARCEL_LIMIT; limit: number; withDelivery: boolean; withVat: boolean };

export type TaxQuote = {
  // the rule of the order and the country whose tax it is
  rule: TaxRuleName | null;
  country: string | null;
  lines: TaxLine[];
  delivery: TaxDelivery | null;
  totals: TaxTotal[];
  // the items, and the items with the delivery, at the prices the rule leaves
  itemsTotal: number;
  total: number;
  // customs may ask the buyer for the tax and the duty on receipt
  payOnReceipt: boolean;
  // why the order cannot be sold there now; null when it can
  refusal: TaxRefusal | null;
  // the threshold the order is counted against, for the lock of the confirmation and the alerts:
  // its group (or the country) and the countries that share it
  threshold: { key: string; countries: string[] } | null;
};

export interface TaxProvider extends Provider<TaxProviderName> {
  // the threshold a sale to the country is counted against: its key, for the lock the confirmation
  // takes before it asks the quote (two orders never pass a threshold unseen), and its countries
  thresholdOf(country: string): { key: string; countries: string[] } | null;
  // the tax of a cart; db reads the sales of the period of a threshold (the caller holds the lock of
  // the threshold when it confirms)
  quote(input: TaxInput, db: Prisma.TransactionClient): Promise<TaxQuote>;
}
