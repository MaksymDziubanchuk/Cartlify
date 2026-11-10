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

export type OrderPaidItem = {
  name: string;
  quantity: number;
  // prices come as numbers or as prisma decimals turned into strings
  unitPrice: number | string;
  totalPrice: number | string;
  // the rule of withdrawal of the item as the order kept it; the mail names the items that are
  // not taken back and the ones taken back only while sealed
  withdrawal?: WithdrawalRuleName;
};

export type OrderPaidTemplateArgs = WithdrawalOfferArgs & {
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
  logoUrl?: string | null;
  locale?: string;
  // the documents attached to the mail as files: the versions of the terms and of the contract the
  // order was confirmed with (sendOrderPaidEmail); the mail names them in its last lines
  attachedDocuments?: ('terms' | 'contract')[];
};

const attachedLineOf = (kinds: readonly ('terms' | 'contract')[] = [], locale: string) => {
  const terms = kinds.includes('terms');
  const contract = kinds.includes('contract');
  if (terms && contract) return t('orderPaid.attachedBoth', locale);
  if (terms) return t('orderPaid.attachedTerms', locale);
  if (contract) return t('orderPaid.attachedContract', locale);
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
  const locale = args.locale || 'en';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');
  if (!args.items?.length) throw new Error('ORDER_ITEMS_REQUIRED');

  const money = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });
  const price = (value: number | string) => money.format(Number(value));

  // the time zone of the buyer is unknown, the time is given in utc and says so
  const dateLocale = locale === 'en' ? 'en-GB' : locale;
  const paidAt = `${new Intl.DateTimeFormat(dateLocale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(args.paidAt)} UTC`;

  const noRight = withdrawalNoticeOf(args.items, 'none', locale);
  const conditional = withdrawalNoticeOf(args.items, 'conditional', locale);
  const orderId = String(args.orderId);

  const values = {
    appName,
    orderId,
    orderUrl,
    paidAt,
    items: args.items.map((item) => ({
      name: item.name.trim(),
      quantity: String(item.quantity),
      unitPrice: price(item.unitPrice),
      lineTotal: price(item.totalPrice),
    })),
    deliveryLine: deliveryLineOf(args.deliveryPrice, price, locale),
    total: price(args.total),
    ...withdrawalOfferOf('paid', args.items, args, locale),
    noRightLine: noRight.length ? t('common.noRightLine', locale) : '',
    noRightItems: noRight,
    conditionalLine: conditional.length ? t('orderPaid.conditionalLine', locale) : '',
    conditionalItems: conditional,
    shippingAddress: args.shippingAddress?.trim() || '',
    pickup: args.pickup?.trim() || '',
    // the name and the phone in one line; an order confirmed before the recipient fields existed
    // has neither, then the line is left out
    recipient: [args.recipientName?.trim(), args.recipientPhone?.trim()].filter(Boolean).join(', '),
    userName: args.userName?.trim() || '',
    attachedLine: attachedLineOf(args.attachedDocuments, locale),
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('orderPaid.subject', locale, { appName, orderId }),
    preview: t('orderPaid.preview', locale, { orderId }),
    leadTxt: t('orderPaid.leadTxt', locale, { appName, orderId }),
    heading: t('orderPaid.heading', locale),
    body: t('orderPaid.body', locale, { orderId }),
    paidOn: t('orderPaid.paidOn', locale, { paidAt }),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    itemHeader: t('common.itemHeader', locale),
    qtyHeader: t('common.qtyHeader', locale),
    priceHeader: t('common.priceHeader', locale),
    totalHeader: t('common.totalHeader', locale),
    deliveryLabel: t('common.deliveryLabel', locale),
    shippingToLabel: t('orderPaid.shippingToLabel', locale),
    pickupAtLabel: t('orderPaid.pickupAtLabel', locale),
    recipientLabel: t('common.recipientLabel', locale),
    viewOrderButton: t('common.viewOrderButton', locale),
    seeOrderTxt: t('common.seeOrderTxt', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
    withdrawContract: t('common.withdrawContract', locale),
  };

  return {
    subject: values.title,
    text: renderTemplate('orders/orderPaid.txt', values),
    html: renderTemplate('orders/orderPaid.html', values),
  };
}
