import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type OrderCancelledRefundedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // what went back to the buyer, all of the payment
  amount: number | string;
  // the currency it was paid in, for example "eur"
  currency: string;
  // where the buyer writes: the address the shop answers from
  supportEmail?: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is orderCancelledRefunded.html and orderCancelledRefunded.txt next to this file.
// It goes when the whole payment of an order that was not sent went back to the buyer by hand in
// the dashboard of the payment provider: the system cancelled the order (a statement of its own,
// the goods back to the stock), nothing will be sent and the money is on its way
export function buildOrderCancelledRefundedTemplate(args: OrderCancelledRefundedTemplateArgs): {
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
    orderUrl,
    ...(args.supportEmail !== undefined ? { supportEmail: args.supportEmail.trim() } : {}),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('orderCancelledRefunded.subject', locale, { appName, orderId }),
    preview: t('orderCancelledRefunded.preview', locale, { amount, orderId }),
    heading: t('orderCancelledRefunded.heading', locale),
    paragraphs: [
      t('orderCancelledRefunded.body', locale, { orderId }),
      t('orderCancelledRefunded.sentLine', locale, { amount }),
      t('orderCancelledRefunded.bankNote', locale),
      t('orderCancelledRefunded.newOrder', locale),
    ].map((text) => ({ text })),
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
    text: renderTemplate('orders/orderCancelledRefunded.txt', values),
    html: renderTemplate('orders/orderCancelledRefunded.html', values),
  };
}
