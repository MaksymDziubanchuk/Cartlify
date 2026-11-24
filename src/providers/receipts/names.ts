// the providers of fiscal receipts this server has; RECEIPT_PROVIDER names the one it works with
// (none: the shop is of a country whose online sales need no receipt). Kept apart from the
// providers themselves, the settings and the tests read it
export const RECEIPT_PROVIDER_NAMES = ['none', 'fiskaly'] as const;

export type ReceiptProviderName = (typeof RECEIPT_PROVIDER_NAMES)[number];
