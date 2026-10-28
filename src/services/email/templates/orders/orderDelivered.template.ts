import { renderTemplate } from '@services/email/renderTemplate.js';

import { deliveryLineOf } from './deliveryLine.js';

export type OrderDeliveredItem = {
  name: string;
  quantity: number;
  // prices come as numbers or as prisma decimals turned into strings
  totalPrice: number | string;
  // the page where the buyer rates the product; an item without one is not offered to rate
  reviewUrl?: string;
};

export type OrderDeliveredTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  items: OrderDeliveredItem[];
  total: number | string;
  // what the buyer paid for the delivery, none for a pickup
  deliveryPrice?: number | string | null;
  // the currency checkout charges in, for example "eur"
  currency: string;
  userName?: string;
  shippingAddress?: string | null;
  recipientName?: string | null;
  recipientPhone?: string | null;
  // where the order was collected, a pickup only: the mail then says it is collected
  pickup?: string | null;
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
    deliveryLine: deliveryLineOf(args.deliveryPrice, price),
    total: price(args.total),
    // the products to rate, each with the page of its reviews
    ratings: args.items
      .filter((item) => item.reviewUrl?.trim())
      .map((item) => ({ name: item.name.trim(), reviewUrl: item.reviewUrl!.trim() })),
    hasRatings: args.items.some((item) => item.reviewUrl?.trim()) ? 'yes' : '',
    shippingAddress: args.shippingAddress?.trim() || '',
    pickup: args.pickup?.trim() || '',
    // how the mail says the order came to the buyer
    statement: args.pickup?.trim() ? 'is collected' : 'is delivered',
    heading: args.pickup?.trim() ? 'Order collected' : 'Order delivered',
    // the name and the phone in one line
    recipient: [args.recipientName?.trim(), args.recipientPhone?.trim()].filter(Boolean).join(', '),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — Order #${args.orderId} ${args.pickup?.trim() ? 'is collected' : 'is delivered'}`,
    text: renderTemplate('orders/orderDelivered.txt', values),
    html: renderTemplate('orders/orderDelivered.html', values),
  };
}
