import { t } from '@config/i18n.js';

const MINUTE_MS = 60_000;

// how long a mailed link stays valid, for the text of the mail, in the language of the mail
// ("24 hours", "24 годин", "24 horas": the dictionary holds the forms each count takes).
// Never promises more than there is: a bigger unit only when the time divides by it,
// so 61 minutes stay "61 minutes" instead of "2 hours". The time is rounded to a minute,
// the mail goes out a few milliseconds after the token got its expiry
export function formatExpiresIn(expiresAt: Date, locale = 'en', now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((expiresAt.getTime() - now) / MINUTE_MS));

  if (minutes < 60 || minutes % 60 !== 0) {
    return t('common.minutesCount', locale, { count: minutes });
  }

  const hours = minutes / 60;
  if (hours < 48 || hours % 24 !== 0) return t('common.hoursCount', locale, { count: hours });

  return t('common.daysCount', locale, { count: hours / 24 });
}
