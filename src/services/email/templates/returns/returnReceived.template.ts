import { t } from '@config/i18n.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';

export type ReturnReceivedItem = { name: string; quantity: number };

export type ReturnReceivedTemplateArgs = {
  orderId: number;
  // the order page of the frontend; none for a statement of the public form, whose account may be gone
  orderUrl?: string;
  // the statement came through the public form (withdrawFromOrder is the account): no link to the
  // order, the buyer is greeted by the name of the form
  publicForm?: boolean;
  // the page with the code where the buyer writes the parcel of the goods: a statement of the form
  // with the code, and one of the account (for when the account is gone)
  proofUrl?: string;
  // a statement of the form without the code: an admin checks it against the order, the mail names
  // no goods (anybody who knows the order number and the name of its recipient can send one) and says
  // nothing about the money until the admin has checked it
  manualCheck?: boolean;
  items: ReturnReceivedItem[];
  // the moment the statement states
  statedAt: Date;
  // the order was paid and had not been sent: the goods stay with the shop and the money follows
  beforeShipment: boolean;
  // the goods were sent: where to send them back, the last day for it and who pays the carrier
  returnAddress?: string | null;
  sendBy?: Date | null;
  shippingPaidBy?: 'buyer' | 'shop' | null;
  // where the buyer writes with a question: the address the shop answers from
  supportEmail: string;
  // the code of the statement the mail is about (W42-2), told in the subject and the text
  code?: string;
  // the time zone of the shop the dates are told in (named in the mail), UTC when none
  timeZone?: string;
  userName?: string;
  appName?: string;
  logoCid?: string;
  locale?: string;
};

// the mail itself is returnReceived.html and returnReceived.txt next to this file. It goes at once
// when the buyer withdraws from their account: the notice of the law that the statement came, the
// date and time of it, and what happens next
export function buildReturnReceivedTemplate(args: ReturnReceivedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const orderUrl = args.orderUrl?.trim() || '';
  const proofUrl = args.proofUrl?.trim() || '';
  const manual = args.manualCheck === true;
  const locale = args.locale || 'en';
  const dateLocale = locale === 'en' ? 'en-GB' : locale;
  // the goods are on their way back: they were sent, and an admin is not checking the statement yet
  const sentBack = !args.beforeShipment && !manual;

  if (!orderUrl && !args.publicForm) throw new Error('ORDER_URL_REQUIRED');
  if (!manual && !args.items?.length) throw new Error('ORDER_ITEMS_REQUIRED');

  const day = (date: Date, zone: string) =>
    new Intl.DateTimeFormat(dateLocale, { dateStyle: 'long', timeZone: zone }).format(date);

  // the time in the time zone of the shop, which the mail names
  const zone = args.timeZone || 'UTC';
  const statedAt = `${new Intl.DateTimeFormat(dateLocale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: zone,
  }).format(args.statedAt)} (${zone})`.replace(',', '');

  const orderId = String(args.orderId);
  const code = args.code?.trim() || '';

  const values = {
    appName,
    orderId,
    code,
    statedAt,
    hasItems: manual ? '' : 'yes',
    items: manual
      ? []
      : args.items.map((item) => ({ name: item.name.trim(), quantity: String(item.quantity) })),
    outcomeLine: manual
      ? t('returnReceived.manualOutcome', locale)
      : args.beforeShipment
        ? t('returnReceived.beforeShipmentOutcome', locale)
        : t('returnReceived.sendBackOutcome', locale),
    addressLine: !sentBack
      ? ''
      : args.returnAddress?.trim()
        ? t('returnReceived.addressLine', locale, { address: args.returnAddress.trim() })
        : t('returnReceived.noAddressLine', locale),
    sendByLine:
      sentBack && args.sendBy
        ? t('returnReceived.sendByLine', locale, { date: day(args.sendBy, zone) })
        : '',
    payerLine: !sentBack
      ? ''
      : args.shippingPaidBy === 'buyer'
        ? t('returnReceived.payerBuyer', locale)
        : args.shippingPaidBy === 'shop'
          ? t('returnReceived.payerShop', locale)
          : '',
    proofLine: !sentBack
      ? ''
      : args.publicForm
        ? proofUrl
          ? t('returnReceived.proofLineForm', locale)
          : ''
        : proofUrl
          ? t('returnReceived.proofLineAccountWithProof', locale)
          : t('returnReceived.proofLineAccountNoProof', locale),
    // the page of the parcel for a buyer of an account, next to the order: it needs no sign-in
    proofLinkUrl: sentBack && !args.publicForm ? proofUrl : '',
    // the one link of the mail: the order of an account, the page of the parcel of the form, or none
    linkUrl: args.publicForm ? (sentBack ? proofUrl : '') : orderUrl,
    linkLabel: args.publicForm
      ? t('returnReceived.linkLabelForm', locale)
      : t('common.viewOrderButton', locale),
    linkIntro: args.publicForm
      ? t('returnReceived.linkIntroForm', locale)
      : t('common.seeOrderTxt', locale),
    supportEmail: args.supportEmail.trim(),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('returnReceived.subject', locale, { appName, orderId }),
    preview: t('returnReceived.preview', locale, { orderId }),
    heading: t('returnReceived.heading', locale),
    leadTxt: t('returnReceived.leadTxt', locale, { appName, orderId, statedAt }),
    body: t('returnReceived.body', locale, { orderId, statedAt }),
    greeting: greetingOf(args.userName, locale),
    statementLine: code ? t('common.statementLine', locale, { code }) : '',
    itemHeader: t('common.itemHeader', locale),
    qtyHeader: t('common.qtyHeader', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: `${values.title}${code ? ` (${code})` : ''}`,
    text: renderTemplate('returns/returnReceived.txt', values),
    html: renderTemplate('returns/returnReceived.html', values),
  };
}
