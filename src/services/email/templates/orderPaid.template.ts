import { renderTemplate } from '@services/email/renderTemplate.js';

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
  appName?: string;
  logoCid?: string;
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
    total: price(args.total),
    shippingAddress: args.shippingAddress?.trim() || '',
    // the name and the phone in one line; an order confirmed before the recipient fields existed
    // has neither, then the line is left out
    recipient: [args.recipientName?.trim(), args.recipientPhone?.trim()].filter(Boolean).join(', '),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Order #${args.orderId} is paid`,
    text: renderTemplate('orderPaid.txt', values),
    html: renderTemplate('orderPaid.html', values),
  };
}
