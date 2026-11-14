import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type ReturnSplitItem = { name: string; quantity: number };

export type ReturnSplitTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // the code of the new statement (W42-2), told in the subject and the text
  code: string;
  // the code of the statement the goods left (W42-1)
  fromCode: string;
  // the units of the new statement
  items: ReturnSplitItem[];
  // where the buyer writes: the address the shop answers from
  supportEmail: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is returnSplit.html and returnSplit.txt next to this file. It goes when units of a
// statement left it for a statement of their own: the buyer sends them back in a parcel of their own
export function buildReturnSplitTemplate(args: ReturnSplitTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || shopSettings().shopName;
  const orderUrl = args.orderUrl?.trim() || '';
  const locale = args.locale || 'en';
  const code = args.code?.trim() || '';
  const fromCode = args.fromCode?.trim() || '';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');
  if (!code || !fromCode) throw new Error('RETURN_CODE_REQUIRED');
  if (!args.items?.length) throw new Error('ORDER_ITEMS_REQUIRED');

  const orderId = String(args.orderId);

  const values = {
    appName,
    orderId,
    code,
    orderUrl,
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('returnSplit.subject', locale, { appName, orderId }),
    preview: t('returnSplit.preview', locale),
    leadTxt: t('returnSplit.leadTxt', locale, { appName, orderId, fromCode }),
    heading: t('returnSplit.heading', locale),
    body: t('returnSplit.body', locale, { orderId, fromCode }),
    nextLine: t('returnSplit.next', locale),
    items: args.items.map((item) => ({ name: item.name.trim(), quantity: String(item.quantity) })),
    itemHeader: t('common.itemHeader', locale),
    qtyHeader: t('common.qtyHeader', locale),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    statementLine: t('common.statementLine', locale, { code }),
    viewOrderButton: t('common.viewOrderButton', locale),
    seeOrderTxt: t('common.seeOrderTxt', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: `${values.title} (${code})`,
    text: renderTemplate('returns/returnSplit.txt', values),
    html: renderTemplate('returns/returnSplit.html', values),
  };
}
