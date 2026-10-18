import { renderTemplate } from '@services/email/renderTemplate.js';

export type AccountDeletedItem = { name: string; quantity: number };

// an order that is paid and still on its way: it lives on after the account is gone
export type AccountDeletedDelivery = {
  orderId: number;
  status: 'paid' | 'shipped';
  // numbers or prisma decimals turned into strings
  total: number | string;
  items: AccountDeletedItem[];
};

// what stripe said about the payment page of an order the deletion cancelled:
// not_taken - the page is closed and no money was taken; refunding - the money came and goes back;
// unknown - there was no page to ask about, or stripe did not answer
export type CancelledOrderPayment = 'not_taken' | 'refunding' | 'unknown';

export type AccountDeletedCancelled = {
  orderId: number;
  total: number | string;
  items: AccountDeletedItem[];
  payment: CancelledOrderPayment;
};

export type AccountDeletedTemplateArgs = {
  deliveries: AccountDeletedDelivery[];
  cancelled: AccountDeletedCancelled[];
  // the currency checkout charges in, for example "eur"
  currency: string;
  userName?: string | null;
  appName?: string;
  logoCid?: string;
};

const STATUS_TEXT: Record<AccountDeletedDelivery['status'], string> = {
  paid: 'paid, it will be shipped',
  shipped: 'shipped, it is on its way',
};

// only what is known goes into the mail: an unknown payment is told as a condition, not a guess
const PAYMENT_TEXT: Record<CancelledOrderPayment, string> = {
  not_taken: 'cancelled, no payment was taken and none will be',
  refunding:
    'cancelled, your payment was received and is refunded in full; your bank shows it within a few days',
  unknown: 'cancelled; if you paid for it, the payment is refunded in full automatically',
};

// the mail itself is accountDeleted.html and accountDeleted.txt next to this file
export function buildAccountDeletedTemplate(args: AccountDeletedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';

  const money = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });
  const price = (value: number | string) => money.format(Number(value));
  const itemsText = (items: AccountDeletedItem[]) =>
    items.map((item) => `${item.name.trim()} x ${item.quantity}`).join(', ');

  const values = {
    appName,
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
    hasDeliveries: args.deliveries.length ? 'yes' : '',
    deliveries: args.deliveries.map((order) => ({
      orderId: String(order.orderId),
      total: price(order.total),
      statusText: STATUS_TEXT[order.status],
      itemsText: itemsText(order.items),
    })),
    hasCancelled: args.cancelled.length ? 'yes' : '',
    cancelled: args.cancelled.map((order) => ({
      orderId: String(order.orderId),
      total: price(order.total),
      paymentText: PAYMENT_TEXT[order.payment],
      itemsText: itemsText(order.items),
    })),
  };

  return {
    subject: `${appName} — Your account is deleted`,
    text: renderTemplate('accountDeleted.txt', values),
    html: renderTemplate('accountDeleted.html', values),
  };
}
