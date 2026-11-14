import { isAvailablePaymentProvider } from './names.js';

import type { PaymentProviderName } from './types.js';

// the payment page an order waits on: the provider that opened it and the id of the page there
export type OrderPaymentPage = {
  provider: PaymentProviderName;
  pageId: string;
};

// the link is kept as "<provider>:<page id>", the id of a page may hold a colon of its own
export function formatPaymentPageLink({ provider, pageId }: OrderPaymentPage): string {
  return `${provider}:${pageId}`;
}

// a link that names no provider this server has (one written before links named the provider,
// or of a provider taken off) leads to no page it could close
export function parsePaymentPageLink(link: string | null | undefined): OrderPaymentPage | null {
  if (!link) return null;

  const colon = link.indexOf(':');
  const provider = link.slice(0, colon);
  const pageId = link.slice(colon + 1);

  if (colon < 1 || !pageId || !isAvailablePaymentProvider(provider)) return null;
  return { provider, pageId };
}
