import { renderTemplate } from '@services/email/renderTemplate.js';

export type ReturnRefundFailedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // the money that could not go back to the card
  amount: number | string;
  // the currency, for example "eur"
  currency: string;
  // where the buyer writes: the address the shop answers from
  supportEmail: string;
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  userName?: string;
  appName?: string;
  logoCid?: string;
};

// the mail itself is returnRefundFailed.html and returnRefundFailed.txt next to this file. It goes
// when the card can no longer take the money; the details of the failure are for the shop
export function buildReturnRefundFailedTemplate(args: ReturnRefundFailedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const orderUrl = args.orderUrl?.trim() || '';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');

  const money = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });

  const values = {
    appName,
    orderId: String(args.orderId),
    code: args.code?.trim() || '',
    orderUrl,
    amount: money.format(Number(args.amount)),
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — We could not return the money for order #${args.orderId}${args.code ? ` (${args.code})` : ''}`,
    text: renderTemplate('returns/returnRefundFailed.txt', values),
    html: renderTemplate('returns/returnRefundFailed.html', values),
  };
}
