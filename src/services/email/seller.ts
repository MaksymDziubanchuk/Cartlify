import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';

// the seller at the foot of every mail (a confirmation names who sells, where and how to reach
// them): the parts root filled in, as root wrote them (a legal name and an address are not
// translated), the words around them in the language of the mail; nothing at all while root has
// filled in none of them
export function sellerLineOf(locale: string): string {
  const settings = shopSettings();
  const parts = [
    settings.sellerLegalName,
    settings.sellerAddress,
    settings.sellerTaxId?.trim()
      ? t('common.sellerTaxId', locale, { taxId: settings.sellerTaxId.trim() })
      : null,
    settings.sellerEmail,
    settings.sellerPhone,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return parts.length ? t('common.seller', locale, { details: parts.join(', ') }) : '';
}
