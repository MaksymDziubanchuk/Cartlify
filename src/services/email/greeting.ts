import { t } from '@config/i18n.js';

// the first line of a mail, by name when the account has one: the whole line is one phrase of
// the dictionary, so each language sets the name off its own way (Ukrainian between commas and
// an exclamation mark, Spanish with a colon at the end), not the way English glues it on
export function greetingOf(userName: string | null | undefined, locale: string): string {
  const name = userName?.trim();
  return name ? t('common.greetingNamed', locale, { name }) : t('common.greeting', locale);
}
