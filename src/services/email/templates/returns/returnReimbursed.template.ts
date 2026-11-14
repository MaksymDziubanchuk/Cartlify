import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

// how money sent outside the app went (src/locales, returnWayWords.*); none for other
const WAY_KEYS = ['bank_transfer', 'cash'];

const wayWordsOf = (method: string, locale: string) =>
  t(`returnWayWords.${WAY_KEYS.includes(method) ? method : 'other'}`, locale);

export type ReturnReimbursedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // what the shop gave back for sending the goods back
  amount: number | string;
  // the currency, for example "eur"
  currency: string;
  // how the money went: outside the app (bank_transfer, cash, other), or provider (a transfer to the
  // card or account the buyer paid with); and the day it went
  method: string;
  sentOn: Date;
  // where the buyer writes: the address the shop answers from
  supportEmail: string;
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  // the time zone of the shop the dates are told in (named in the mail), UTC when none
  timeZone?: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is returnReimbursed.html and returnReimbursed.txt next to this file. It goes when
// root recorded that the shop paid the buyer back the cost of sending the goods back, or when a
// transfer of its own to the payment sent it
export function buildReturnReimbursedTemplate(args: ReturnReimbursedTemplateArgs): {
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
  const day = new Intl.DateTimeFormat(dateLocale, {
    dateStyle: 'long',
    timeZone: args.timeZone || 'UTC',
  });

  const orderId = String(args.orderId);
  const code = args.code?.trim() || '';
  const amount = money.format(Number(args.amount));
  const sentOn = day.format(args.sentOn);
  const sentOnLine =
    args.method === 'provider'
      ? t('returnReimbursed.sentToPayment', locale, { date: sentOn })
      : t('returnReimbursed.sentOn', locale, {
          way: wayWordsOf(args.method, locale),
          date: sentOn,
        });

  const values = {
    appName,
    orderId,
    code,
    orderUrl,
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('returnReimbursed.subject', locale, { appName, orderId }),
    preview: t('returnReimbursed.preview', locale, { amount }),
    leadTxt: t('returnReimbursed.leadTxt', locale, { appName, orderId, amount }),
    heading: t('returnReimbursed.heading', locale),
    body: t('returnReimbursed.body', locale, { orderId, amount }),
    sentOnLine,
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
    text: renderTemplate('returns/returnReimbursed.txt', values),
    html: renderTemplate('returns/returnReimbursed.html', values),
  };
}
