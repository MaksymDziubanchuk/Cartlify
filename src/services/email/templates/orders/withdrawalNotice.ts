import { withdrawalRightOf, type WithdrawalRuleName } from '@helpers/withdrawal.js';

// what each rule that limits the right of withdrawal says to the buyer (Directive 2011/83, art. 16)
const WITHDRAWAL_REASONS: Record<Exclude<WithdrawalRuleName, 'allowed'>, string> = {
  sealed_hygiene:
    'sealed goods that are not suitable for return for health or hygiene reasons, until the seal is broken',
  sealed_media: 'sealed audio or video recordings and software, until the seal is broken',
  mixed: 'goods that are inseparably mixed with other items after delivery, until they are mixed',
  perishable: 'goods that spoil or expire quickly',
  personalised: 'goods made to your specification or personalised',
  periodical: 'newspapers, periodicals and magazines',
};

type RuledItem = { name: string; withdrawal?: WithdrawalRuleName };

// the items the right of withdrawal does not cover, or covers only under a condition, each with the
// reason; none for an order whose items may all be taken back freely
export const withdrawalNoticeOf = (items: readonly RuledItem[], right: 'conditional' | 'none') =>
  items.flatMap((item) =>
    item.withdrawal && item.withdrawal !== 'allowed' && withdrawalRightOf(item.withdrawal) === right
      ? [{ name: item.name.trim(), reason: WITHDRAWAL_REASONS[item.withdrawal] }]
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

// the sentence of a mail that tells the buyer they may withdraw, and the link to do it from; both
// are empty when no item of the order has the right (or the mail has no link)
export function withdrawalOfferOf(
  stage: 'paid' | 'shipped' | 'delivered',
  items: readonly RuledItem[],
  args: WithdrawalOfferArgs,
): { withdrawalLine: string; withdrawalUrl: string } {
  const url = args.withdrawalUrl?.trim() || '';
  const hasRight = items.some((item) => withdrawalRightOf(item.withdrawal ?? 'allowed') !== 'none');
  if (!url || !hasRight) return { withdrawalLine: '', withdrawalUrl: '' };

  const period =
    typeof args.withdrawalDays === 'number'
      ? `${args.withdrawalDays} days`
      : 'the period of your contract';

  const base = 'You may withdraw from the contract without giving a reason';
  const line =
    stage === 'delivered' && args.withdrawalEndsAt
      ? `${base} until ${new Intl.DateTimeFormat('en-GB', {
          dateStyle: 'long',
          timeZone: args.timeZone ?? 'UTC',
        }).format(args.withdrawalEndsAt)}. Withdraw here:`
      : stage === 'paid'
        ? `${base}: before the goods are sent, and for ${period} after you receive them. Withdraw here:`
        : stage === 'delivered'
          ? `${base} for ${period} after the delivery. Withdraw here:`
          : `${base} for ${period} after you receive the goods. Withdraw here:`;

  return { withdrawalLine: line, withdrawalUrl: url };
}
