import { renderTemplate } from '@services/email/renderTemplate.js';

// how the money went, in the words of the mail
const WAY_WORDS: Record<string, string> = {
  bank_transfer: 'a bank transfer',
  cash: 'cash',
  other: 'another way',
};

export type ReturnReimbursedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // what the shop gave back for sending the goods back
  amount: number | string;
  // the currency, for example "eur"
  currency: string;
  // how the money went outside the app, and the day it went
  method: string;
  sentOn: Date;
  // where the buyer writes: the address the shop answers from
  supportEmail: string;
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  // the time zone of the shop the dates are told in (named in the mail), UTC when none
  timeZone?: string;
  userName?: string;
  appName?: string;
  logoCid?: string;
};

// the mail itself is returnReimbursed.html and returnReimbursed.txt next to this file. It goes when
// root recorded that the shop paid the buyer back the cost of sending the goods back
export function buildReturnReimbursedTemplate(args: ReturnReimbursedTemplateArgs): {
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
  const day = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'long',
    timeZone: args.timeZone || 'UTC',
  });

  const values = {
    appName,
    orderId: String(args.orderId),
    code: args.code?.trim() || '',
    orderUrl,
    amount: money.format(Number(args.amount)),
    way: WAY_WORDS[args.method] ?? WAY_WORDS.other!,
    sentOn: day.format(args.sentOn),
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — We paid back the cost of sending order #${args.orderId} back${args.code ? ` (${args.code})` : ''}`,
    text: renderTemplate('returns/returnReimbursed.txt', values),
    html: renderTemplate('returns/returnReimbursed.html', values),
  };
}
