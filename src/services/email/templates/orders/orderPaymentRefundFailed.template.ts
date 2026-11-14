import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

import type { RefundFailure } from '@prisma/client';

export type OrderPaymentRefundFailedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // the payment that could not go back, all of it
  amount: number | string;
  // the currency it was paid in, for example "eur"
  currency: string;
  // why it did not go back, in our words: only a card that can no longer take money is told as
  // such, the other reasons (the balance of the shop, a dispute at the bank, the unknown) in general words
  failure: RefundFailure;
  // the money had been sent and the bank of the card sent it back: the buyer was told it was sent
  sentBack?: boolean;
  // where the buyer writes: the address the shop answers from
  supportEmail?: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is orderPaymentRefundFailed.html and orderPaymentRefundFailed.txt next to this
// file. It goes when the refund of a payment the order could not take fails, once; the words of the
// payment provider are for the shop
export function buildOrderPaymentRefundFailedTemplate(args: OrderPaymentRefundFailedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || shopSettings().shopName;
  const orderUrl = args.orderUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');

  const money = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });

  const orderId = String(args.orderId);
  const amount = money.format(Number(args.amount));

  const values = {
    appName,
    orderId,
    sentBack: args.sentBack ? 'yes' : '',
    orderUrl,
    ...(args.supportEmail !== undefined ? { supportEmail: args.supportEmail.trim() } : {}),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('orderPaymentRefundFailed.subject', locale, { appName, orderId }),
    preview: t('orderPaymentRefundFailed.preview', locale, { amount }),
    heading: t('orderPaymentRefundFailed.heading', locale),
    body: t(
      args.failure === 'card_unavailable'
        ? 'orderPaymentRefundFailed.bodyCard'
        : 'orderPaymentRefundFailed.bodyGeneral',
      locale,
      { orderId, amount },
    ),
    sentBackLine: t('orderPaymentRefundFailed.sentBackLine', locale),
    contactLine: t('orderPaymentRefundFailed.contactLine', locale),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    viewOrderButton: t('common.viewOrderButton', locale),
    seeOrderTxt: t('common.seeOrderTxt', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: values.title,
    text: renderTemplate('orders/orderPaymentRefundFailed.txt', values),
    html: renderTemplate('orders/orderPaymentRefundFailed.html', values),
  };
}
