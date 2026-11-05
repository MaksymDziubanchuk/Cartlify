import { t } from '@config/i18n.js';
import type { WithdrawalRuleName } from '@helpers/withdrawal.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';

import { deliveryLineOf } from './deliveryLine.js';
import {
  withdrawalNoticeOf,
  withdrawalOfferOf,
  type WithdrawalOfferArgs,
} from './withdrawalNotice.js';

export type OrderDeliveredItem = {
  name: string;
  quantity: number;
  // prices come as numbers or as prisma decimals turned into strings
  totalPrice: number | string;
  // the page where the buyer rates the product; an item without one is not offered to rate
  reviewUrl?: string;
  // the name the rating line goes by (the product, whose reviews the page shows); without one the
  // name of the item
  reviewName?: string;
  // the rule of withdrawal of the item as the order kept it; the mail names the items that are not
  // taken back
  withdrawal?: WithdrawalRuleName;
};

export type OrderDeliveredTemplateArgs = WithdrawalOfferArgs & {
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
  locale?: string;
};

// the mail itself is orderDelivered.html and orderDelivered.txt next to this file
export function buildOrderDeliveredTemplate(args: OrderDeliveredTemplateArgs): {
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
  const collected = Boolean(args.pickup?.trim());
  const orderId = String(args.orderId);
  const statement = t(
    collected ? 'orderDelivered.statementCollected' : 'orderDelivered.statementDelivered',
    locale,
  );

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
    ...withdrawalOfferOf('delivered', args.items, args, locale),
    noRightLine: noRight.length ? t('common.noRightLine', locale) : '',
    noRightItems: noRight,
    // the products to rate, each with the page of its reviews; the text line names the product
    // itself, the html button its own translated label (the mark inside {{#ratings}} takes the
    // fields of the item, not of values)
    ratings: args.items
      .filter((item) => item.reviewUrl?.trim())
      .map((item) => {
        const name = item.reviewName?.trim() || item.name.trim();
        return {
          name,
          reviewUrl: item.reviewUrl!.trim(),
          rateButton: t('orderDelivered.rateButton', locale, { name }),
        };
      }),
    hasRatings: args.items.some((item) => item.reviewUrl?.trim()) ? 'yes' : '',
    shippingAddress: args.shippingAddress?.trim() || '',
    pickup: args.pickup?.trim() || '',
    statement,
    heading: t(
      collected ? 'orderDelivered.headingCollected' : 'orderDelivered.headingDelivered',
      locale,
    ),
    // the name and the phone in one line
    recipient: [args.recipientName?.trim(), args.recipientPhone?.trim()].filter(Boolean).join(', '),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t(
      collected ? 'orderDelivered.subjectCollected' : 'orderDelivered.subjectDelivered',
      locale,
      {
        appName,
        orderId,
      },
    ),
    preview: t(
      collected ? 'orderDelivered.previewCollected' : 'orderDelivered.previewDelivered',
      locale,
      {
        orderId,
      },
    ),
    leadTxt: t('orderDelivered.leadTxt', locale, { appName, orderId, statement }),
    body: t('orderDelivered.body', locale, { orderId, statement }),
    greeting: greetingOf(args.userName, locale),
    itemHeader: t('common.itemHeader', locale),
    qtyHeader: t('common.qtyHeader', locale),
    totalHeader: t('common.totalHeader', locale),
    deliveryLabel: t('common.deliveryLabel', locale),
    deliveredToLabel: t('orderDelivered.deliveredToLabel', locale),
    collectedAtLabel: t('orderDelivered.collectedAtLabel', locale),
    recipientLabel: t('common.recipientLabel', locale),
    ratingsIntro: t('orderDelivered.ratingsIntro', locale),
    viewOrderButton: t('common.viewOrderButton', locale),
    seeOrderTxt: t('common.seeOrderTxt', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
    withdrawContract: t('common.withdrawContract', locale),
  };

  return {
    subject: values.title,
    text: renderTemplate('orders/orderDelivered.txt', values),
    html: renderTemplate('orders/orderDelivered.html', values),
  };
}
