import { t } from '@config/i18n.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

// why the order could not take the payment, the answers of pay_order that give the money back
export type PaymentRefundReason =
  | 'OUT_OF_STOCK'
  | 'ALREADY_PAID_OTHER_PAYMENT'
  | 'AMOUNT_MISMATCH'
  | 'ORDER_NOT_PAYABLE'
  | 'ORDER_NOT_FOUND';

export type OrderPaymentRefundedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // the payment that went back, all of it
  amount: number | string;
  // the currency it was paid in, for example "eur"
  currency: string;
  reason: PaymentRefundReason;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// what became of the order: only another payment of it leaves it paid
const orderLineOf = (reason: PaymentRefundReason, locale: string) =>
  reason === 'ALREADY_PAID_OTHER_PAYMENT'
    ? t('orderPaymentRefunded.orderStaysPaid', locale)
    : t('orderPaymentRefunded.orderNotPaid', locale);

// the mail itself is orderPaymentRefunded.html and orderPaymentRefunded.txt next to this file
export function buildOrderPaymentRefundedTemplate(args: OrderPaymentRefundedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const orderUrl = args.orderUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');

  const money = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });

  const orderId = String(args.orderId);
  const amount = money.format(Number(args.amount));
  const reason = t(`paymentRefundReasons.${args.reason}`, locale);

  const values = {
    appName,
    orderId,
    orderUrl,
    amount,
    reason,
    orderLine: orderLineOf(args.reason, locale),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('orderPaymentRefunded.subject', locale, { appName, orderId }),
    preview: t('orderPaymentRefunded.preview', locale, { amount, orderId }),
    heading: t('orderPaymentRefunded.heading', locale),
    body: t('orderPaymentRefunded.body', locale, { amount, orderId, reason }),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    viewOrderButton: t('common.viewOrderButton', locale),
    seeOrderTxt: t('common.seeOrderTxt', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  // bankNote interpolates the already-translated orderLine, not a dictionary key of its own
  const bankNote = t('orderPaymentRefunded.bankNote', locale, { orderLine: values.orderLine });

  return {
    subject: values.title,
    text: renderTemplate('orders/orderPaymentRefunded.txt', { ...values, bankNote }),
    html: renderTemplate('orders/orderPaymentRefunded.html', { ...values, bankNote }),
  };
}
