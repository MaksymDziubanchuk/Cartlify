import { t } from '@config/i18n.js';
import { withdrawalRightOf, type WithdrawalRuleName } from '@helpers/withdrawal.js';

type RuledItem = { name: string; withdrawal?: WithdrawalRuleName };

// the items the right of withdrawal does not cover, or covers only under a condition, each with the
// reason (src/locales, withdrawalReasons.*); none for an order whose items may all be taken back
// freely
export const withdrawalNoticeOf = (
  items: readonly RuledItem[],
  right: 'conditional' | 'none',
  locale = 'en',
) =>
  items.flatMap((item) =>
    item.withdrawal && item.withdrawal !== 'allowed' && withdrawalRightOf(item.withdrawal) === right
      ? [{ name: item.name.trim(), reason: t(`withdrawalReasons.${item.withdrawal}`, locale) }]
      : [],
  );

export type WithdrawalOfferArgs = {
  // the link of the page of withdrawal with the code of the order after the # (withdrawalLinkOf)
  withdrawalUrl?: string;
  // the days the buyer has after the delivery: the contract's and the grace of the shop
  withdrawalDays?: number | null;
  // a delivered order: the end of the period, in the time zone of the shop
  withdrawalEndsAt?: Date | null;
  timeZone?: string;
};

// "en" formats dates the way it always has (1 May 2026, not May 1, 2026); the other languages
// format in their own way
const dateFormatLocale = (locale: string) => (locale === 'en' ? 'en-GB' : locale);

// the sentence of a mail that tells the buyer they may withdraw, and the link to do it from; both
// are empty when no item of the order has the right (or the mail has no link)
export function withdrawalOfferOf(
  stage: 'paid' | 'shipped' | 'delivered',
  items: readonly RuledItem[],
  args: WithdrawalOfferArgs,
  locale = 'en',
): { withdrawalLine: string; withdrawalUrl: string } {
  const url = args.withdrawalUrl?.trim() || '';
  const hasRight = items.some((item) => withdrawalRightOf(item.withdrawal ?? 'allowed') !== 'none');
  if (!url || !hasRight) return { withdrawalLine: '', withdrawalUrl: '' };

  const period =
    typeof args.withdrawalDays === 'number'
      ? t('withdrawal.daysCount', locale, { count: args.withdrawalDays })
      : t('withdrawal.contractPeriod', locale);

  const line =
    stage === 'delivered' && args.withdrawalEndsAt
      ? t('withdrawal.untilDate', locale, {
          date: new Intl.DateTimeFormat(dateFormatLocale(locale), {
            dateStyle: 'long',
            timeZone: args.timeZone ?? 'UTC',
          }).format(args.withdrawalEndsAt),
        })
      : stage === 'paid'
        ? t('withdrawal.beforeSentThenPeriod', locale, { period })
        : stage === 'delivered'
          ? t('withdrawal.periodAfterDelivery', locale, { period })
          : t('withdrawal.periodAfterReceipt', locale, { period });

  return { withdrawalLine: line, withdrawalUrl: url };
}
