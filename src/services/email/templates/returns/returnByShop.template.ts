import { t } from '@config/i18n.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';

export type ReturnByShopItem = { name: string; quantity: number };

// the reasons a return.js understands (src/locales, returnReasons.*); none for other
const REASON_KEYS = ['defect', 'wrong_item', 'damaged', 'goodwill', 'shop_cancel', 'refused'];

export type ReturnByShopTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  items: ReturnByShopItem[];
  // the reason an admin gave, none or other says nothing
  reason?: string | null;
  // the words of the admin
  description?: string | null;
  // the moment the statement states
  statedAt: Date;
  // where the buyer writes with a question: the address the shop answers from
  supportEmail: string;
  // the statement extends an earlier one of the buyer
  extended?: boolean;
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  // the time zone of the shop the dates are told in (named in the mail), UTC when none
  timeZone?: string;
  userName?: string;
  appName?: string;
  logoCid?: string;
  locale?: string;
};

// the mail itself is returnByShop.html and returnByShop.txt next to this file
export function buildReturnByShopTemplate(args: ReturnByShopTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const orderUrl = args.orderUrl?.trim() || '';
  const locale = args.locale || 'en';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');
  if (!args.items?.length) throw new Error('ORDER_ITEMS_REQUIRED');

  // the time in the time zone of the shop, which the mail names
  const zone = args.timeZone || 'UTC';
  const dateLocale = locale === 'en' ? 'en-GB' : locale;
  const statedAt = `${new Intl.DateTimeFormat(dateLocale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: zone,
  }).format(args.statedAt)} (${zone})`.replace(',', '');

  const reasonWords =
    args.reason && REASON_KEYS.includes(args.reason)
      ? t(`returnReasons.${args.reason}`, locale)
      : '';
  const orderId = String(args.orderId);
  const code = args.code?.trim() || '';

  const values = {
    appName,
    orderId,
    code,
    orderUrl,
    items: args.items.map((item) => ({ name: item.name.trim(), quantity: String(item.quantity) })),
    reasonLine: reasonWords ? t('returnByShop.reasonLine', locale, { reasonWords }) : '',
    note: args.description?.trim() || '',
    statedAt,
    extendedLine: args.extended ? t('returnByShop.extendedLine', locale) : '',
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('returnByShop.subject', locale, { appName, orderId }),
    preview: t('returnByShop.preview', locale, { orderId }),
    leadTxt: t('returnByShop.leadTxt', locale, { appName, orderId }),
    heading: t('returnByShop.heading', locale),
    body: t('returnByShop.body', locale, { orderId }),
    registeredOn: t('returnByShop.registeredOn', locale, { statedAt }),
    greeting: greetingOf(args.userName, locale),
    statementLine: code ? t('common.statementLine', locale, { code }) : '',
    itemHeader: t('common.itemHeader', locale),
    qtyHeader: t('common.qtyHeader', locale),
    noteLabel: t('common.noteLabel', locale),
    viewOrderButton: t('common.viewOrderButton', locale),
    seeOrderTxt: t('common.seeOrderTxt', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: `${values.title}${code ? ` (${code})` : ''}`,
    text: renderTemplate('returns/returnByShop.txt', values),
    html: renderTemplate('returns/returnByShop.html', values),
  };
}
