import { renderTemplate } from '@services/email/renderTemplate.js';

import { deliveryLineOf } from './deliveryLine.js';

export type OrderPaidItem = {
  name: string;
  quantity: number;
  // prices come as numbers or as prisma decimals turned into strings
  unitPrice: number | string;
  totalPrice: number | string;
};

export type OrderPaidTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  items: OrderPaidItem[];
  total: number | string;
  // the currency checkout charges in, for example "eur"
  currency: string;
  paidAt: Date;
  userName?: string;
  shippingAddress?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  // where and when to collect the order, a pickup only
  pickup?: string | null;
  // what the buyer pays for the delivery, part of the total: free when 0, no line for a pickup
  deliveryPrice?: number | string | null;
  appName?: string;
  logoCid?: string;
  // the documents attached to the mail as files: the versions of the terms and of the contract the
  // order was confirmed with (sendOrderPaidEmail); the mail names them in its last lines
  attachedDocuments?: ('terms' | 'contract')[];
};

const ATTACHED_LINES = {
  both: 'The terms and the contract you accepted are attached to this mail.',
  terms: 'The terms you accepted are attached to this mail.',
  contract: 'The contract you accepted is attached to this mail.',
} as const;

const attachedLineOf = (kinds: readonly ('terms' | 'contract')[] = []) => {
  const terms = kinds.includes('terms');
  const contract = kinds.includes('contract');
  if (terms && contract) return ATTACHED_LINES.both;
  if (terms) return ATTACHED_LINES.terms;
  if (contract) return ATTACHED_LINES.contract;
  return '';
};

// the mail itself is orderPaid.html and orderPaid.txt next to this file
export function buildOrderPaidTemplate(args: OrderPaidTemplateArgs): {
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
  const price = (value: number | string) => money.format(Number(value));

  // the time zone of the buyer is unknown, the time is given in utc and says so
  const paidAt = `${new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(args.paidAt)} UTC`;

  const values = {
    appName,
    orderId: String(args.orderId),
    orderUrl,
    paidAt,
    items: args.items.map((item) => ({
      name: item.name.trim(),
      quantity: String(item.quantity),
      unitPrice: price(item.unitPrice),
      lineTotal: price(item.totalPrice),
    })),
    deliveryLine: deliveryLineOf(args.deliveryPrice, price),
    total: price(args.total),
    shippingAddress: args.shippingAddress?.trim() || '',
    pickup: args.pickup?.trim() || '',
    // the name and the phone in one line; an order confirmed before the recipient fields existed
    // has neither, then the line is left out
    recipient: [args.recipientName?.trim(), args.recipientPhone?.trim()].filter(Boolean).join(', '),
    userName: args.userName?.trim() || '',
    attachedLine: attachedLineOf(args.attachedDocuments),
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Order #${args.orderId} is paid`,
    text: renderTemplate('orders/orderPaid.txt', values),
    html: renderTemplate('orders/orderPaid.html', values),
  };
}
