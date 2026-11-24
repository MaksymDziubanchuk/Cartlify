import type { ShopSettingsValues } from '@config/shopSettings.js';
import type { ReceiptProvider } from '@providers/receipts/index.js';
import { BadRequestError } from '@utils/errors.js';

// The settings of the fiscal receipts (docs/taxes.md), checked on the values a write would leave: a
// provider that makes receipts registers the documents of the shop, so the shop makes an invoice of
// every order and says when the receipt of a sale goes (the moment the law of the provider fixes,
// when it fixes one), for a seller of a country the provider serves; the provider is turned on with
// its keys (a key taken away later does not stop root changing the other settings, the receipts
// wait). A server without a provider makes no receipts: no moment. `current` is the moment the
// shop has now
export function checkReceiptSettings(
  values: Pick<ShopSettingsValues, 'receiptMoment' | 'invoiceMode' | 'sellerCountry'>,
  provider: ReceiptProvider,
  current: ShopSettingsValues['receiptMoment'],
): void {
  if (!provider.makesReceipts()) {
    if (values.receiptMoment !== null) throw new BadRequestError('RECEIPT_MOMENT_WITHOUT_PROVIDER');
    return;
  }

  if (values.receiptMoment === null) throw new BadRequestError('RECEIPT_MOMENT_REQUIRED');
  if (current === null && !provider.isConfigured()) {
    throw new BadRequestError('RECEIPT_PROVIDER_NOT_CONFIGURED');
  }
  if (values.invoiceMode !== 'every_order') {
    throw new BadRequestError('RECEIPT_INVOICE_EVERY_ORDER_REQUIRED');
  }
  const moment = provider.fixedMoment();
  if (moment && values.receiptMoment !== moment) {
    throw new BadRequestError('RECEIPT_MOMENT_FIXED', { moment });
  }
  const sellers = provider.sellerCountries();
  if (sellers && !sellers.includes(values.sellerCountry ?? '')) {
    throw new BadRequestError('RECEIPT_SELLER_COUNTRY_NOT_SUPPORTED', {
      country: values.sellerCountry,
      supported: sellers,
    });
  }
}
