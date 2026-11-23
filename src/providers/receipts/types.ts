import type { Provider } from '../provider.js';
import type { ReceiptProviderName } from './names.js';

// Fiscal receipts (docs/taxes.md): a sale or a return registered with the fiscal service of the
// country of the seller, the way its law asks. The app gives the document it made (an invoice or a
// credit note: its number, its lines with their rates, where the sale is taxed and by which rule);
// the provider registers it and answers its number, the link to check it, and, when it gives them,
// the code to print (a picture) and the text the law asks to print. What a country asks is the
// provider's, in its folder.

// the service does not answer, or does not let the app in (try again later, with the same key)
export const RECEIPT_PROVIDER_UNAVAILABLE = 'RECEIPT_PROVIDER_UNAVAILABLE';
// the service refused the document (its data needs a person; trying again does not help)
export const RECEIPT_PROVIDER_REFUSED = 'RECEIPT_PROVIDER_REFUSED';

export type ReceiptTaxRule = 'seller' | 'recipient' | 'none' | 'buyer_at_receipt';

export type ReceiptLine = {
  name: string;
  // the units of an item of a sale; null for a sum that is not units (the delivery, a part of the
  // money that went back)
  quantity: number | null;
  // the rate of the tax in the line; null: the line holds no tax
  rate: number | null;
  // the sums of the line, below 0 in a return: without the tax, the tax, with the tax
  net: number;
  tax: number;
  gross: number;
};

export type ReceiptRequest = {
  // ours, the same on every try of one receipt (the number of our document in its series): a
  // provider that takes a key does not register it twice
  key: string;
  // a sale (an invoice), a return (a credit note: the lines below 0), or the money of a return that
  // came back to the shop (an invoice that reverses a credit note)
  kind: 'sale' | 'return' | 'reversal';
  // the number of our document in its series
  series: string;
  number: number;
  issuedAt: Date;
  // ISO 4217, upper case
  currency: string;
  // where the sale is taxed and by which rule (docs/taxes.md); null for a shop that takes no tax
  taxRule: ReceiptTaxRule | null;
  taxCountry: string | null;
  lines: ReceiptLine[];
  gross: number;
  // a return or a reversal: the key of the receipt of the sale it corrects
  correctsKey: string | null;
};

export type ReceiptAnswer = {
  // registered: the service took it; pending: it took it and registers it later (ask again)
  state: 'registered' | 'pending';
  number: string | null;
  url: string | null;
  // the code to print, a PNG in base64, and the text the law asks to print
  code: string | null;
  text: string | null;
};

export interface ReceiptProvider extends Provider<ReceiptProviderName> {
  // whether the provider makes receipts at all (none makes none)
  makesReceipts(): boolean;
  isConfigured(): boolean;
  // the countries of a seller the provider registers for (the law it follows); null: any
  sellerCountries(): readonly string[] | null;
  // the moment its law fixes for the receipt of a sale (the receipt is the invoice itself, made at
  // the payment); null: root chooses it (receiptMoment)
  fixedMoment(): 'payment' | 'shipment' | null;
  issue(request: ReceiptRequest): Promise<ReceiptAnswer>;
  // where a receipt the service took stands
  status(request: ReceiptRequest): Promise<ReceiptAnswer>;
}
