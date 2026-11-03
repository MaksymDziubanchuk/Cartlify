import { renderTemplate } from '@services/email/renderTemplate.js';

export type ReturnByShopItem = { name: string; quantity: number };

// what the shop says of a return it registered, by the reason an admin gave; none for other
const REASON_WORDS: Record<string, string> = {
  defect: 'a defect of the goods',
  wrong_item: 'the wrong item',
  damaged: 'damage of the goods',
  goodwill: 'a return the shop agreed to',
  shop_cancel: 'the cancellation of your order by the shop',
  refused: 'your refusal of the parcel',
};

export type ReturnByShopTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  items: ReturnByShopItem[];
  // the reason an admin gave, none or other says nothing
  reason?: string | null;
  // the words of the admin
  description?: string | null;
  // the moment the statement states
  statedAt: Date;
  // where the buyer writes with a question: the address the shop answers from
  supportEmail: string;
  // the statement extends an earlier one of the buyer
  extended?: boolean;
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  // the time zone of the shop the dates are told in (named in the mail), UTC when none
  timeZone?: string;
  userName?: string;
  appName?: string;
  logoCid?: string;
};

// the mail itself is returnByShop.html and returnByShop.txt next to this file
export function buildReturnByShopTemplate(args: ReturnByShopTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const orderUrl = args.orderUrl?.trim() || '';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');
  if (!args.items?.length) throw new Error('ORDER_ITEMS_REQUIRED');

  // the time in the time zone of the shop, which the mail names
  const zone = args.timeZone || 'UTC';
  const statedAt = `${new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: zone,
  }).format(args.statedAt)} (${zone})`.replace(',', '');

  const values = {
    appName,
    orderId: String(args.orderId),
    code: args.code?.trim() || '',
    orderUrl,
    items: args.items.map((item) => ({ name: item.name.trim(), quantity: String(item.quantity) })),
    reasonWords: args.reason ? (REASON_WORDS[args.reason] ?? '') : '',
    note: args.description?.trim() || '',
    statedAt,
    extendedLine: args.extended ? 'It extends your earlier statement.' : '',
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Return of order #${args.orderId} registered${args.code ? ` (${args.code})` : ''}`,
    text: renderTemplate('returns/returnByShop.txt', values),
    html: renderTemplate('returns/returnByShop.html', values),
  };
}
