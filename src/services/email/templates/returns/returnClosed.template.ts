import { renderTemplate } from '@services/email/renderTemplate.js';

export type ReturnClosedLine = { name: string; quantity: number };
export type ReturnDeclinedLine = ReturnClosedLine & {
  // why the units were not returned, in the words of the mail
  why: string;
};

// what the shop says of the code root closed rows with; the note of root is for the shop only
const CLOSE_WORDS: Record<string, string> = {
  buyer_changed_mind: 'You let us know that you no longer wish to return the goods.',
  not_buyer: 'We could not match the statement to your purchase.',
  goods_not_returned: 'We did not receive the goods back.',
  stated_again: 'The goods are handled in another statement of this order.',
  other: 'The shop closed the statement.',
};

// why goods that came back were not accepted
export const NOT_ACCEPTED_WORDS: Record<string, string> = {
  unsealed: 'the package was opened',
  mixed: 'the goods were mixed with other things',
  used: 'the goods were used',
  damaged: 'the goods arrived damaged',
  other: 'the shop did not accept the goods',
};

export type ReturnClosedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // the units that went back with their money, and those that did not
  refunded: ReturnClosedLine[];
  declined: ReturnDeclinedLine[];
  // all the money that went back with the statement
  refundedAmount?: number | string;
  // the currency, for example "eur"
  currency: string;
  // the code root closed rows with, none when the statement closed by itself
  closeCode?: string | null;
  // the mail names no goods: a statement whose sender the shop did not check
  hideItems?: boolean;
  // where the buyer writes with a question: the address the shop answers from
  supportEmail: string;
  // what root kept of the money for the value the goods lost, and the goods it was kept for
  withheldAmount?: number | string;
  withheldItems?: string[];
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  userName?: string;
  appName?: string;
  logoCid?: string;
};

// the mail itself is returnClosed.html and returnClosed.txt next to this file
export function buildReturnClosedTemplate(args: ReturnClosedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const orderUrl = args.orderUrl?.trim() || '';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');
  if (!args.refunded.length && !args.declined.length) throw new Error('ORDER_ITEMS_REQUIRED');

  const hide = args.hideItems === true;

  const money = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });
  const amount = Number(args.refundedAmount ?? 0);

  const values = {
    appName,
    orderId: String(args.orderId),
    code: args.code?.trim() || '',
    withheldLine:
      Number(args.withheldAmount ?? 0) > 0 && args.withheldItems?.length
        ? `We kept ${money.format(Number(args.withheldAmount))} of the price for the value the goods lost: ${args.withheldItems.map((name) => name.trim()).join(', ')}.`
        : '',
    orderUrl,
    outcomeLine:
      amount > 0
        ? `${money.format(amount)} went back to you.`
        : 'No money is returned for this statement.',
    closeLine: args.closeCode ? (CLOSE_WORDS[args.closeCode] ?? CLOSE_WORDS.other!) : '',
    showRefunded: !hide && args.refunded.length ? 'yes' : '',
    refunded: args.refunded.map((line) => ({
      name: line.name.trim(),
      quantity: String(line.quantity),
    })),
    showDeclined: !hide && args.declined.length ? 'yes' : '',
    declined: args.declined.map((line) => ({
      name: line.name.trim(),
      quantity: String(line.quantity),
      why: line.why,
    })),
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Return of order #${args.orderId} is closed${args.code ? ` (${args.code})` : ''}`,
    text: renderTemplate('returns/returnClosed.txt', values),
    html: renderTemplate('returns/returnClosed.html', values),
  };
}
