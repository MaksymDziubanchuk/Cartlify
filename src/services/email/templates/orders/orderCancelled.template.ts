import { renderTemplate } from '@services/email/renderTemplate.js';

import { deliveryLineOf } from './deliveryLine.js';

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
  // what the buyer paid for the delivery, part of the refunded amount: free when 0, no line for a
  // pickup
  deliveryPrice?: number | string | null;
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
    deliveryLine: deliveryLineOf(args.deliveryPrice, price),
    total: price(args.total),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Order #${args.orderId} is cancelled`,
    text: renderTemplate('orders/orderCancelled.txt', values),
    html: renderTemplate('orders/orderCancelled.html', values),
  };
}
