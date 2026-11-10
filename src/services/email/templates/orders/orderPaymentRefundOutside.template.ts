import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

// how money sent outside the app went (src/locales, returnWayWords.*); none for other
const WAY_KEYS = ['bank_transfer', 'cash'];

const wayWordsOf = (method: string, locale: string) =>
  t(`returnWayWords.${WAY_KEYS.includes(method) ? method : 'other'}`, locale);

export type OrderPaymentRefundOutsideTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // the payment that went back, all of it
  amount: number | string;
  // the currency it was paid in, for example "eur"
  currency: string;
  // how root sent it (bank_transfer, cash, other) and the day it went
  method: string;
  sentOn: Date;
  // the time zone of the shop the day is told in, UTC when none
  timeZone?: string;
  // where the buyer writes: the address the shop answers from
  supportEmail?: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is orderPaymentRefundOutside.html and orderPaymentRefundOutside.txt next to this
// file. It goes when root sent the money of a payment the order could not take, whose refund
// failed, another way: the note of root is for the shop
export function buildOrderPaymentRefundOutsideTemplate(
  args: OrderPaymentRefundOutsideTemplateArgs,
): {
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
  const dateLocale = locale === 'en' ? 'en-GB' : locale;

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
    title: t('orderPaymentRefundOutside.subject', locale, { appName, orderId }),
    preview: t('orderPaymentRefundOutside.preview', locale, { amount, orderId }),
    heading: t('orderPaymentRefundOutside.heading', locale),
    body: t('orderPaymentRefundOutside.body', locale, { amount, orderId }),
    sentLine: t('returnRefunded.sentWithDate', locale, {
      way: wayWordsOf(args.method, locale),
      date: new Intl.DateTimeFormat(dateLocale, {
        dateStyle: 'long',
        timeZone: args.timeZone || 'UTC',
      }).format(args.sentOn),
    }),
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
    text: renderTemplate('orders/orderPaymentRefundOutside.txt', values),
    html: renderTemplate('orders/orderPaymentRefundOutside.html', values),
  };
}
