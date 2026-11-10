import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type ReturnClosedLine = { name: string; quantity: number };
export type ReturnDeclinedLine = ReturnClosedLine & {
  // why the units were not returned, in the words of the mail
  why: string;
};

// the codes the shop closes a statement with (src/locales, closeReasons.*); none for other
const CLOSE_CODE_KEYS = ['buyer_changed_mind', 'not_buyer', 'goods_not_returned', 'stated_again'];

const closeLineOf = (closeCode: string | null | undefined, locale: string) => {
  if (!closeCode) return '';
  const key = CLOSE_CODE_KEYS.includes(closeCode) ? closeCode : 'other';
  return t(`closeReasons.${key}`, locale);
};

export type ReturnClosedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // the units that went back with their money, and those that did not
  refunded: ReturnClosedLine[];
  declined: ReturnDeclinedLine[];
  // all the money that went back with the statement
  refundedAmount?: number | string;
  // the currency, for example "eur"
  currency: string;
  // the code root closed rows with, none when the statement closed by itself
  closeCode?: string | null;
  // the mail names no goods: a statement whose sender the shop did not check
  hideItems?: boolean;
  // where the buyer writes with a question: the address the shop answers from
  supportEmail: string;
  // what root kept of the money for the value the goods lost, and the goods it was kept for
  withheldAmount?: number | string;
  withheldItems?: string[];
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is returnClosed.html and returnClosed.txt next to this file
export function buildReturnClosedTemplate(args: ReturnClosedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || shopSettings().shopName;
  const orderUrl = args.orderUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');
  if (!args.refunded.length && !args.declined.length) throw new Error('ORDER_ITEMS_REQUIRED');

  const hide = args.hideItems === true;

  const money = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });
  const amount = Number(args.refundedAmount ?? 0);
  const orderId = String(args.orderId);
  const code = args.code?.trim() || '';

  const values = {
    appName,
    orderId,
    code,
    orderUrl,
    withheldLine:
      Number(args.withheldAmount ?? 0) > 0 && args.withheldItems?.length
        ? t('returnClosed.withheldLine', locale, {
            amount: money.format(Number(args.withheldAmount)),
            names: args.withheldItems.map((name) => name.trim()).join(', '),
          })
        : '',
    outcomeLine:
      amount > 0
        ? t('returnClosed.moneyBack', locale, { amount: money.format(amount) })
        : t('returnClosed.noMoney', locale),
    closeLine: closeLineOf(args.closeCode, locale),
    showRefunded: !hide && args.refunded.length ? 'yes' : '',
    refunded: args.refunded.map((line) => ({
      name: line.name.trim(),
      quantity: String(line.quantity),
    })),
    showDeclined: !hide && args.declined.length ? 'yes' : '',
    declined: args.declined.map((line) => ({
      name: line.name.trim(),
      quantity: String(line.quantity),
      why: line.why,
    })),
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('returnClosed.subject', locale, { appName, orderId }),
    preview: t('returnClosed.preview', locale, { orderId }),
    leadTxt: t('returnClosed.leadTxt', locale, { appName, orderId }),
    heading: t('returnClosed.heading', locale),
    body: t('returnClosed.body', locale, { orderId }),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    statementLine: code ? t('common.statementLine', locale, { code }) : '',
    returnedToYouHeader: t('returnClosed.returnedToYouHeader', locale),
    notReturnedHeader: t('returnClosed.notReturnedHeader', locale),
    qtyHeader: t('common.qtyHeader', locale),
    viewOrderButton: t('common.viewOrderButton', locale),
    seeOrderTxt: t('common.seeOrderTxt', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: `${values.title}${code ? ` (${code})` : ''}`,
    text: renderTemplate('returns/returnClosed.txt', values),
    html: renderTemplate('returns/returnClosed.html', values),
  };
}
