import { renderTemplate } from '@services/email/renderTemplate.js';

export type OrderCancelledItem = {
  name: string;
  quantity: number;
  // prices come as numbers or as prisma decimals turned into strings
  totalPrice: number | string;
};

export type OrderCancelledTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  items: OrderCancelledItem[];
  // the refunded amount, the whole payment
  total: number | string;
  // the currency checkout charges in, for example "eur"
  currency: string;
  userName?: string;
  appName?: string;
  logoCid?: string;
};

// the mail itself is orderCancelled.html and orderCancelled.txt next to this file
export function buildOrderCancelledTemplate(args: OrderCancelledTemplateArgs): {
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
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Order #${args.orderId} is cancelled`,
    text: renderTemplate('orderCancelled.txt', values),
    html: renderTemplate('orderCancelled.html', values),
  };
}
