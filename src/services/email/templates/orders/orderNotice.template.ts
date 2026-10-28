import { renderTemplate } from '@services/email/renderTemplate.js';

export type OrderNoticeTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  subject: string;
  // the line above the text, what the mail is about
  heading: string;
  // the text of the mail, a paragraph for each
  paragraphs: string[];
  // what the mail tells, a line for each: a label and its value
  details?: { label: string; value: string }[];
  userName?: string;
  appName?: string;
  logoCid?: string;
};

// the mail itself is orderNotice.html and orderNotice.txt next to this file. It is the mail of an
// event of an order that has no list of items to show: a pickup that is ready, details of the
// shipping that changed, a step of the status taken back (orderNotices.ts holds the texts)
export function buildOrderNoticeTemplate(args: OrderNoticeTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const orderUrl = args.orderUrl?.trim() || '';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');
  if (!args.paragraphs?.length) throw new Error('ORDER_NOTICE_TEXT_REQUIRED');

  const values = {
    appName,
    orderId: String(args.orderId),
    orderUrl,
    heading: args.heading.trim(),
    paragraphs: args.paragraphs.map((text) => ({ text: text.trim() })),
    details: (args.details ?? [])
      .filter((detail) => detail.value.trim())
      .map((detail) => ({ label: detail.label.trim(), value: detail.value.trim() })),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: args.subject.trim(),
    text: renderTemplate('orders/orderNotice.txt', values),
    html: renderTemplate('orders/orderNotice.html', values),
  };
}
