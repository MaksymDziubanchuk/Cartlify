import { t } from '@config/i18n.js';

// the line of the delivery in a mail with a total: its price, free, or none for a pickup
export const deliveryLineOf = (
  value: number | string | null | undefined,
  price: (v: number | string) => string,
  locale = 'en',
): string =>
  value === null || value === undefined
    ? ''
    : Number(value) > 0
      ? price(value)
      : t('common.free', locale);
