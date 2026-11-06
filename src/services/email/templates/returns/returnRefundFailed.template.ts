import { t } from '@config/i18n.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type ReturnRefundFailedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // the money that could not go back to the card
  amount: number | string;
  // the currency, for example "eur"
  currency: string;
  // where the buyer writes: the address the shop answers from
  supportEmail: string;
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  // the money went to the card and its bank sent it back: the buyer was told it was returned
  sentBack?: boolean;
  userName?: string;
  appName?: string;
  logoCid?: string;
  locale?: string;
};

// the mail itself is returnRefundFailed.html and returnRefundFailed.txt next to this file. It goes
// when the card can no longer take the money; the details of the failure are for the shop
export function buildReturnRefundFailedTemplate(args: ReturnRefundFailedTemplateArgs): {
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
  const code = args.code?.trim() || '';
  const amount = money.format(Number(args.amount));

  const values = {
    appName,
    orderId,
    code,
    sentBack: args.sentBack ? 'yes' : '',
    orderUrl,
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('returnRefundFailed.subject', locale, { appName, orderId }),
    preview: t('returnRefundFailed.preview', locale, { amount }),
    heading: t('returnRefundFailed.heading', locale),
    leadTxt: t('returnRefundFailed.leadTxt', locale, { appName, orderId, amount }),
    body: t('returnRefundFailed.body', locale, { orderId, amount }),
    sentBackLine: t('returnRefundFailed.sentBackLine', locale),
    contactLine: t('returnRefundFailed.contactLine', locale),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    statementLine: code ? t('common.statementLine', locale, { code }) : '',
    viewOrderButton: t('common.viewOrderButton', locale),
    seeOrderTxt: t('common.seeOrderTxt', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: `${values.title}${code ? ` (${code})` : ''}`,
    text: renderTemplate('returns/returnRefundFailed.txt', values),
    html: renderTemplate('returns/returnRefundFailed.html', values),
  };
}
