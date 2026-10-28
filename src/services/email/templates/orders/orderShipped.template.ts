import { renderTemplate } from '@services/email/renderTemplate.js';

import { deliveryLineOf } from './deliveryLine.js';

export type OrderShippedItem = {
  name: string;
  quantity: number;
  // prices come as numbers or as prisma decimals turned into strings
  totalPrice: number | string;
};

export type OrderShippedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  items: OrderShippedItem[];
  total: number | string;
  // what the buyer paid for the delivery, none for a pickup
  deliveryPrice?: number | string | null;
  // the currency checkout charges in, for example "eur"
  currency: string;
  userName?: string;
  shippingAddress?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  // who carries the order and how to follow it, as the shop wrote them; each one only if it has it
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  appName?: string;
  logoCid?: string;
};

// the mail itself is orderShipped.html and orderShipped.txt next to this file
export function buildOrderShippedTemplate(args: OrderShippedTemplateArgs): {
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
    shippingAddress: args.shippingAddress?.trim() || '',
    carrier: args.carrier?.trim() || '',
    trackingNumber: args.trackingNumber?.trim() || '',
    trackingUrl: args.trackingUrl?.trim() || '',
    // the name and the phone in one line
    recipient: [args.recipientName?.trim(), args.recipientPhone?.trim()].filter(Boolean).join(', '),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Order #${args.orderId} is shipped`,
    text: renderTemplate('orders/orderShipped.txt', values),
    html: renderTemplate('orders/orderShipped.html', values),
  };
}
