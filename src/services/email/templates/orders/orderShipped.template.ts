import { t } from '@config/i18n.js';
import type { WithdrawalRuleName } from '@helpers/withdrawal.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

import { deliveryLineOf } from './deliveryLine.js';
import {
  withdrawalNoticeOf,
  withdrawalOfferOf,
  type WithdrawalOfferArgs,
} from './withdrawalNotice.js';

export type OrderShippedItem = {
  name: string;
  quantity: number;
  // prices come as numbers or as prisma decimals turned into strings
  totalPrice: number | string;
  // the rule of withdrawal of the item as the order kept it; the mail names the items that are not
  // taken back
  withdrawal?: WithdrawalRuleName;
};

export type OrderShippedTemplateArgs = WithdrawalOfferArgs & {
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
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is orderShipped.html and orderShipped.txt next to this file
export function buildOrderShippedTemplate(args: OrderShippedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const orderUrl = args.orderUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');
  if (!args.items?.length) throw new Error('ORDER_ITEMS_REQUIRED');

  const money = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });
  const price = (value: number | string) => money.format(Number(value));

  const noRight = withdrawalNoticeOf(args.items, 'none', locale);
  const orderId = String(args.orderId);

  const values = {
    appName,
    orderId,
    orderUrl,
    items: args.items.map((item) => ({
      name: item.name.trim(),
      quantity: String(item.quantity),
      lineTotal: price(item.totalPrice),
    })),
    deliveryLine: deliveryLineOf(args.deliveryPrice, price, locale),
    total: price(args.total),
    ...withdrawalOfferOf('shipped', args.items, args, locale),
    noRightLine: noRight.length ? t('common.noRightLine', locale) : '',
    noRightItems: noRight,
    shippingAddress: args.shippingAddress?.trim() || '',
    carrier: args.carrier?.trim() || '',
    trackingNumber: args.trackingNumber?.trim() || '',
    trackingUrl: args.trackingUrl?.trim() || '',
    // the name and the phone in one line
    recipient: [args.recipientName?.trim(), args.recipientPhone?.trim()].filter(Boolean).join(', '),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('orderShipped.subject', locale, { appName, orderId }),
    preview: t('orderShipped.preview', locale, { orderId }),
    leadTxt: t('orderShipped.leadTxt', locale, { appName, orderId }),
    heading: t('orderShipped.heading', locale),
    body: t('orderShipped.body', locale, { orderId }),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    itemHeader: t('common.itemHeader', locale),
    qtyHeader: t('common.qtyHeader', locale),
    totalHeader: t('common.totalHeader', locale),
    deliveryLabel: t('common.deliveryLabel', locale),
    shippingToLabel: t('orderPaid.shippingToLabel', locale),
    recipientLabel: t('common.recipientLabel', locale),
    carrierLabel: t('orderNotice.carrierLabel', locale),
    trackingNumberLabel: t('orderNotice.trackingNumberLabel', locale),
    followParcelLabel: t('orderNotice.followParcelLabel', locale),
    viewOrderButton: t('common.viewOrderButton', locale),
    seeOrderTxt: t('common.seeOrderTxt', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
    withdrawContract: t('common.withdrawContract', locale),
  };

  return {
    subject: values.title,
    text: renderTemplate('orders/orderShipped.txt', values),
    html: renderTemplate('orders/orderShipped.html', values),
  };
}
