import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type ReturnRefundedItem = { name: string; quantity: number };

// how money sent outside the app went (src/locales, returnWayWords.*); none for other
const WAY_KEYS = ['bank_transfer', 'cash'];

const wayWordsOf = (method: string, locale: string) =>
  t(`returnWayWords.${WAY_KEYS.includes(method) ? method : 'other'}`, locale);

export type ReturnRefundedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // what the money is for
  items: ReturnRefundedItem[];
  // all that went back in this transfer: the units and the delivery
  amount: number | string;
  // the delivery inside the amount, 0 or none when it did not go back
  deliveryAmount?: number | string;
  // the cost of the way back the buyer owes, taken off the amount; 0 or none when nothing was
  deductionAmount?: number | string;
  // the way back the shop pays inside the amount (what the buyer paid the carrier); 0 or none
  wayBackAmount?: number | string;
  // the parts of the amount money already with the buyer paid: what the bank gave for a dispute,
  // and a refund made earlier by hand; all of it so and nothing was sent now. 0 or none when none
  bankAmount?: number | string;
  earlierAmount?: number | string;
  // the currency, for example "eur"
  currency: string;
  // money sent outside the app after a transfer failed: how, and the day it went
  outsideMethod?: string | null;
  sentOn?: Date | null;
  // where the buyer writes with a question: the address the shop answers from
  supportEmail: string;
  // what root kept of the money for the value the goods lost, and the goods it was kept for
  withheldAmount?: number | string;
  withheldItems?: string[];
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  // the time zone of the shop the dates are told in (named in the mail), UTC when none
  timeZone?: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is returnRefunded.html and returnRefunded.txt next to this file
export function buildReturnRefundedTemplate(args: ReturnRefundedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || shopSettings().shopName;
  const orderUrl = args.orderUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');
  if (!args.items?.length) throw new Error('ORDER_ITEMS_REQUIRED');

  const money = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });
  const dateLocale = locale === 'en' ? 'en-GB' : locale;
  const delivery = Number(args.deliveryAmount ?? 0);
  const deduction = Number(args.deductionAmount ?? 0);
  const wayBack = Number(args.wayBackAmount ?? 0);
  const orderId = String(args.orderId);
  const code = args.code?.trim() || '';
  // in cents, so the parts add up without float math: what money already with the buyer paid, and
  // what was sent now
  const totalCents = Math.round(Number(args.amount) * 100);
  const bankCents = Math.round(Number(args.bankAmount ?? 0) * 100);
  const earlierCents = Math.round(Number(args.earlierAmount ?? 0) * 100);
  const coveredCents = bankCents + earlierCents;
  const coveredAll = coveredCents > 0 && totalCents - coveredCents <= 0;
  const total = money.format(totalCents / 100);
  const amount = coveredAll ? total : money.format((totalCents - coveredCents) / 100);
  const intro = coveredAll ? 'returnRefunded.covered' : 'returnRefunded.';

  const way = args.outsideMethod ? wayWordsOf(args.outsideMethod, locale) : '';
  const sentWay = args.outsideMethod
    ? args.sentOn
      ? t('returnRefunded.sentWithDate', locale, {
          way,
          date: new Intl.DateTimeFormat(dateLocale, {
            dateStyle: 'long',
            timeZone: args.timeZone || 'UTC',
          }).format(args.sentOn),
        })
      : t('returnRefunded.sentNoDate', locale, { way })
    : // a transfer to the card can still fail at the bank, and the buyer is then mailed
      // (returnRefundFailed); money sent outside the app has no such later answer
      `${t('returnRefunded.wayBack', locale)} ${t('returnRefunded.laterLine', locale)}`;

  // all of it was with the buyer already: where it came from (a refund made by hand can still fail at
  // the bank, the money of a bank cannot); part of it: what was sent now, and what the goods have in all
  const wayLine = coveredAll
    ? [
        bankCents > 0
          ? t('returnRefunded.bankLine', locale, { amount: money.format(bankCents / 100) })
          : '',
        earlierCents > 0
          ? t('returnRefunded.earlierLine', locale, { amount: money.format(earlierCents / 100) })
          : '',
        earlierCents > 0 ? t('returnRefunded.laterLine', locale) : '',
      ]
        .filter(Boolean)
        .join(' ')
    : coveredCents > 0
      ? `${sentWay} ${t('returnRefunded.alreadyLine', locale, {
          covered: money.format(coveredCents / 100),
          amount: total,
        })}`
      : sentWay;

  const values = {
    appName,
    orderId,
    code,
    withheldLine:
      Number(args.withheldAmount ?? 0) > 0 && args.withheldItems?.length
        ? t('returnClosed.withheldLine', locale, {
            amount: money.format(Number(args.withheldAmount)),
            names: args.withheldItems.map((name) => name.trim()).join(', '),
          })
        : '',
    orderUrl,
    amount,
    wayLine,
    deliveryLine:
      delivery > 0
        ? t('returnRefunded.deliveryLine', locale, { amount: money.format(delivery) })
        : '',
    wayBackLine:
      wayBack > 0 ? t('returnRefunded.wayBackLine', locale, { amount: money.format(wayBack) }) : '',
    deductionLine:
      deduction > 0
        ? t('returnRefunded.deductionLine', locale, { amount: money.format(deduction) })
        : '',
    items: args.items.map((item) => ({ name: item.name.trim(), quantity: String(item.quantity) })),
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t(`${intro}${coveredAll ? 'Subject' : 'subject'}`, locale, { appName, orderId }),
    preview: t(`${intro}${coveredAll ? 'Preview' : 'preview'}`, locale, { orderId }),
    leadTxt: t(`${intro}${coveredAll ? 'LeadTxt' : 'leadTxt'}`, locale, {
      appName,
      orderId,
      amount,
    }),
    heading: t(`${intro}${coveredAll ? 'Heading' : 'heading'}`, locale),
    body: t(`${intro}${coveredAll ? 'Body' : 'body'}`, locale, { orderId, amount }),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    statementLine: code ? t('common.statementLine', locale, { code }) : '',
    itemHeader: t('common.itemHeader', locale),
    qtyHeader: t('common.qtyHeader', locale),
    viewOrderButton: t('common.viewOrderButton', locale),
    seeOrderTxt: t('common.seeOrderTxt', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: `${values.title}${code ? ` (${code})` : ''}`,
    text: renderTemplate('returns/returnRefunded.txt', values),
    html: renderTemplate('returns/returnRefunded.html', values),
  };
}
