import { renderTemplate } from '@services/email/renderTemplate.js';

export type ReturnRefundedItem = { name: string; quantity: number };

// how money sent outside the app went, in the words of the mail
const OUTSIDE_WORDS: Record<string, string> = {
  bank_transfer: 'a bank transfer',
  cash: 'cash',
  other: 'another way',
};

export type ReturnRefundedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // what the money is for
  items: ReturnRefundedItem[];
  // all that went back in this transfer: the units and the delivery
  amount: number | string;
  // the delivery inside the amount, 0 or none when it did not go back
  deliveryAmount?: number | string;
  // the cost of the way back the buyer owes, taken off the amount; 0 or none when nothing was
  deductionAmount?: number | string;
  // the currency, for example "eur"
  currency: string;
  // money sent outside the app after a transfer failed: how, and the day it went
  outsideMethod?: string | null;
  sentOn?: Date | null;
  // where the buyer writes with a question: the address the shop answers from
  supportEmail: string;
  // what root kept of the money for the value the goods lost, and the goods it was kept for
  withheldAmount?: number | string;
  withheldItems?: string[];
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  // the time zone of the shop the dates are told in (named in the mail), UTC when none
  timeZone?: string;
  userName?: string;
  appName?: string;
  logoCid?: string;
};

// the mail itself is returnRefunded.html and returnRefunded.txt next to this file
export function buildReturnRefundedTemplate(args: ReturnRefundedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const orderUrl = args.orderUrl?.trim() || '';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');
  if (!args.items?.length) throw new Error('ORDER_ITEMS_REQUIRED');

  const money = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });
  const delivery = Number(args.deliveryAmount ?? 0);
  const deduction = Number(args.deductionAmount ?? 0);

  const wayLine = args.outsideMethod
    ? `We sent it by ${OUTSIDE_WORDS[args.outsideMethod] ?? OUTSIDE_WORDS.other}${
        args.sentOn
          ? ` on ${new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: args.timeZone || 'UTC' }).format(args.sentOn)}`
          : ''
      }.`
    : 'It goes back the way you paid. Your bank shows it within a few days.';

  const values = {
    appName,
    orderId: String(args.orderId),
    code: args.code?.trim() || '',
    withheldLine:
      Number(args.withheldAmount ?? 0) > 0 && args.withheldItems?.length
        ? `We kept ${money.format(Number(args.withheldAmount))} of the price for the value the goods lost: ${args.withheldItems.map((name) => name.trim()).join(', ')}.`
        : '',
    orderUrl,
    amount: money.format(Number(args.amount)),
    wayLine,
    deliveryLine: delivery > 0 ? `The delivery is included: ${money.format(delivery)}.` : '',
    deductionLine:
      deduction > 0
        ? `The cost of sending the goods back, ${money.format(deduction)}, is taken off: the contract says you pay it.`
        : '',
    items: args.items.map((item) => ({ name: item.name.trim(), quantity: String(item.quantity) })),
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Money returned for order #${args.orderId}${args.code ? ` (${args.code})` : ''}`,
    text: renderTemplate('returns/returnRefunded.txt', values),
    html: renderTemplate('returns/returnRefunded.html', values),
  };
}
