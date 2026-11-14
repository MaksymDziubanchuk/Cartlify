import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type ReturnSentBackItem = { name: string; quantity: number };

export type ReturnSentBackTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // the units the parcel carries back
  items: ReturnSentBackItem[];
  // the parcel as the admin wrote it: a number goes with its carrier
  carrier?: string | null;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  // where the buyer writes: the address the shop answers from
  supportEmail: string;
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is returnSentBack.html and returnSentBack.txt next to this file. It goes when an
// admin sent goods the shop did not accept back to the buyer in a parcel of the statement
export function buildReturnSentBackTemplate(args: ReturnSentBackTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || shopSettings().shopName;
  const orderUrl = args.orderUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');
  if (!args.items?.length) throw new Error('ORDER_ITEMS_REQUIRED');

  const orderId = String(args.orderId);
  const code = args.code?.trim() || '';
  const carrier = args.carrier?.trim() || '';
  const number = args.trackingNumber?.trim() || '';
  const trackingUrl = carrier ? args.trackingUrl?.trim() || '' : '';

  const parcelLine = !carrier
    ? ''
    : number
      ? t('returnSentBack.parcel', locale, { carrier, number })
      : t('returnSentBack.parcelCarrier', locale, { carrier });

  const values = {
    appName,
    orderId,
    code,
    orderUrl,
    trackingUrl,
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('returnSentBack.subject', locale, { appName, orderId }),
    preview: t('returnSentBack.preview', locale),
    leadTxt: t('returnSentBack.leadTxt', locale, { appName, orderId }),
    heading: t('returnSentBack.heading', locale),
    body: t('returnSentBack.body', locale, { orderId }),
    parcelLine,
    followLine: trackingUrl ? t('returnSentBack.follow', locale) : '',
    items: args.items.map((item) => ({ name: item.name.trim(), quantity: String(item.quantity) })),
    itemHeader: t('common.itemHeader', locale),
    qtyHeader: t('common.qtyHeader', locale),
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
    text: renderTemplate('returns/returnSentBack.txt', values),
    html: renderTemplate('returns/returnSentBack.html', values),
  };
}
