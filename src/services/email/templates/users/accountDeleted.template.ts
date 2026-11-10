import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type AccountDeletedItem = { name: string; quantity: number };

// an order that is paid and still on its way: it lives on after the account is gone
export type AccountDeletedDelivery = {
  orderId: number;
  status: 'paid' | 'shipped';
  // the buyer collects it at the shop, it is not sent
  pickup?: boolean;
  // numbers or prisma decimals turned into strings
  total: number | string;
  items: AccountDeletedItem[];
};

// what the payment provider said about the payment page of an order the deletion cancelled:
// not_taken - the page is closed and no money was taken; refunding - the money came and goes back;
// unknown - there was no page to ask about, or the provider did not answer
export type CancelledOrderPayment = 'not_taken' | 'refunding' | 'unknown';

export type AccountDeletedCancelled = {
  orderId: number;
  total: number | string;
  items: AccountDeletedItem[];
  payment: CancelledOrderPayment;
};

export type AccountDeletedTemplateArgs = {
  deliveries: AccountDeletedDelivery[];
  cancelled: AccountDeletedCancelled[];
  // the deletion ended a subscription to the newsletter of the account: one more sentence
  newsletterEnded?: boolean;
  // the currency checkout charges in, for example "eur"
  currency: string;
  userName?: string | null;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the key of accountDeleted.* for the status of a delivery (src/locales), by whether it is picked
// up at the shop or sent
const statusKeyOf = (status: AccountDeletedDelivery['status'], pickup: boolean | undefined) =>
  pickup
    ? status === 'paid'
      ? 'statusPaidPickup'
      : 'statusReadyPickup'
    : status === 'paid'
      ? 'statusPaid'
      : 'statusShipped';

// the key of accountDeleted.* for what the payment provider said of a cancelled order
const PAYMENT_KEYS: Record<CancelledOrderPayment, string> = {
  not_taken: 'paymentNotTaken',
  refunding: 'paymentRefunding',
  unknown: 'paymentUnknown',
};

// the mail itself is accountDeleted.html and accountDeleted.txt next to this file
export function buildAccountDeletedTemplate(args: AccountDeletedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || shopSettings().shopName;
  const locale = args.locale || 'en';

  const money = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });
  const price = (value: number | string) => money.format(Number(value));
  const itemsText = (items: AccountDeletedItem[]) =>
    items.map((item) => `${item.name.trim()} x ${item.quantity}`).join(', ');

  const values = {
    appName,
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    hasNewsletter: args.newsletterEnded ? 'yes' : '',
    hasDeliveries: args.deliveries.length ? 'yes' : '',
    deliveries: args.deliveries.map((order) => ({
      orderId: String(order.orderId),
      total: price(order.total),
      statusText: t(`accountDeleted.${statusKeyOf(order.status, order.pickup)}`, locale),
      itemsText: itemsText(order.items),
    })),
    hasCancelled: args.cancelled.length ? 'yes' : '',
    cancelled: args.cancelled.map((order) => ({
      orderId: String(order.orderId),
      total: price(order.total),
      paymentText: t(`accountDeleted.${PAYMENT_KEYS[order.payment]}`, locale),
      itemsText: itemsText(order.items),
    })),
    title: t('accountDeleted.subject', locale, { appName }),
    preview: t('accountDeleted.preview', locale, { appName }),
    heading: t('accountDeleted.heading', locale),
    body: t('accountDeleted.body', locale, { appName }),
    newsletterEnded: t('accountDeleted.newsletterEnded', locale),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    deliveriesHeading: t('accountDeleted.deliveriesHeading', locale),
    deliveriesIntro: t('accountDeleted.deliveriesIntro', locale),
    deliveriesIntroTxt: t('accountDeleted.deliveriesIntroTxt', locale),
    deliveriesOutroTxt: t('accountDeleted.deliveriesOutroTxt', locale),
    cancelledHeading: t('accountDeleted.cancelledHeading', locale),
    cancelledIntro: t('accountDeleted.cancelledIntro', locale),
    orderLabel: t('accountDeleted.orderLabel', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: values.title,
    text: renderTemplate('users/accountDeleted.txt', values),
    html: renderTemplate('users/accountDeleted.html', values),
  };
}
