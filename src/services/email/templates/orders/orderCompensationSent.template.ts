import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type OrderCompensationSentTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // what the compensation gave
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

// the mail itself is orderCompensationSent.html and orderCompensationSent.txt next to this file. It
// goes when the provider sent the compensation root gave by the button of the app: the sum, and
// that it goes the way the buyer paid (the note of root is for the shop)
export function buildOrderCompensationSentTemplate(args: OrderCompensationSentTemplateArgs): {
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
    title: t('orderCompensationSent.subject', locale, { appName, orderId }),
    preview: t('orderCompensationSent.preview', locale, { amount, orderId }),
    heading: t('orderCompensationSent.heading', locale),
    body: t('orderCompensationSent.body', locale, { amount, orderId }),
    wayLine: t('returnRefunded.wayBack', locale),
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
    text: renderTemplate('orders/orderCompensationSent.txt', values),
    html: renderTemplate('orders/orderCompensationSent.html', values),
  };
}
