import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type OrderCancelledByBankTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // what the bank gave the buyer back by the dispute
  bankAmount: number | string;
  // what the shop sent of the rest of the payment; 0 when the bank gave all of it back
  sentAmount: number | string;
  // the currency it was paid in, for example "eur"
  currency: string;
  // where the buyer writes: the address the shop answers from
  supportEmail?: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is orderCancelledByBank.html and orderCancelledByBank.txt next to this file. It
// goes when the bank decided a dispute of the payment of an order that was not sent for the buyer:
// the system cancelled the order (a statement of its own, the goods back to the stock) and sent the
// rest of the payment the bank did not give back; told once the rest is sent, or at once when the
// bank gave back all of it. The buyer is never told that a dispute opened or that the shop won one
export function buildOrderCancelledByBankTemplate(args: OrderCancelledByBankTemplateArgs): {
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

  const orderId = String(args.orderId);
  const bankAmount = money.format(Number(args.bankAmount));
  const sent = Number(args.sentAmount) > 0;
  const sentAmount = money.format(Number(args.sentAmount));

  const values = {
    appName,
    orderId,
    orderUrl,
    ...(args.supportEmail !== undefined ? { supportEmail: args.supportEmail.trim() } : {}),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t('orderCancelledByBank.subject', locale, { appName, orderId }),
    preview: t('orderCancelledByBank.preview', locale, { orderId }),
    heading: t('orderCancelledByBank.heading', locale),
    paragraphs: [
      t('orderCancelledByBank.body', locale, { orderId, amount: bankAmount }),
      t('orderCancelledByBank.cancelLine', locale),
      ...(sent
        ? [
            t('orderCancelledByBank.sentLine', locale, { amount: sentAmount }),
            t('orderCancelledByBank.bankNote', locale),
          ]
        : []),
      t('orderCancelledByBank.newOrder', locale),
    ].map((text) => ({ text })),
    greeting: greetingOf(args.userName, locale),
    seller: sellerLineOf(locale),
    viewOrderButton: t('common.viewOrderButton', locale),
    seeOrderTxt: t('common.seeOrderTxt', locale),
    openLinkFallback: t('common.openLinkFallback', locale),
    questionsIntro: t('common.questionsIntro', locale),
    orTo: t('common.orTo', locale),
  };

  return {
    subject: values.title,
    text: renderTemplate('orders/orderCancelledByBank.txt', values),
    html: renderTemplate('orders/orderCancelledByBank.html', values),
  };
}
