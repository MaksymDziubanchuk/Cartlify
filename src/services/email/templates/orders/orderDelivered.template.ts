import { renderTemplate } from '@services/email/renderTemplate.js';

export type OrderDeliveredItem = {
  name: string;
  quantity: number;
  // prices come as numbers or as prisma decimals turned into strings
  totalPrice: number | string;
};

export type OrderDeliveredTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  items: OrderDeliveredItem[];
  total: number | string;
  // the currency checkout charges in, for example "eur"
  currency: string;
  userName?: string;
  shippingAddress?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  appName?: string;
  logoCid?: string;
};

// the mail itself is orderDelivered.html and orderDelivered.txt next to this file
export function buildOrderDeliveredTemplate(args: OrderDeliveredTemplateArgs): {
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

  const values = {
    appName,
    orderId: String(args.orderId),
    orderUrl,
    items: args.items.map((item) => ({
      name: item.name.trim(),
      quantity: String(item.quantity),
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
    subject: `${appName} — Order #${args.orderId} is delivered`,
    text: renderTemplate('orders/orderDelivered.txt', values),
    html: renderTemplate('orders/orderDelivered.html', values),
  };
}
