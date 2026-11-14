import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type OrderPaymentCheckTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // where the buyer writes: the address the shop answers from
  supportEmail?: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is orderPaymentCheck.html and orderPaymentCheck.txt next to this file. It goes once
// when a paid order is first held for a check of its payment (an early warning of the network of the
// card, a review of the payment provider): the money came, the shop checks it before sending, and
// writes when the order is sent or the money goes back. A warning can be wrong: the mail never names
// fraud
export function buildOrderPaymentCheckTemplate(args: OrderPaymentCheckTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || shopSettings().shopName;
  const orderUrl = args.orderUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');

  const orderId = String(args.orderId);

  const values = {
    appName,
    orderId,
    orderUrl,
    ...(args.supportEmail !== undefined ? { supportEmail: args.supportEmail.trim() } : {}),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('orderPaymentCheck.subject', locale, { appName, orderId }),
    preview: t('orderPaymentCheck.preview', locale, { orderId }),
    heading: t('orderPaymentCheck.heading', locale),
    paragraphs: [
      t('orderPaymentCheck.body', locale, { orderId }),
      t('orderPaymentCheck.checkLine', locale),
      t('orderPaymentCheck.nextLine', locale),
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
    text: renderTemplate('orders/orderPaymentCheck.txt', values),
    html: renderTemplate('orders/orderPaymentCheck.html', values),
  };
}
