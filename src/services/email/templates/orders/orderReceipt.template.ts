import { t } from '@config/i18n.js';
import { shopSettings } from '@config/shopSettings.js';
import { greetingOf } from '@services/email/greeting.js';
import { renderTemplate } from '@services/email/renderTemplate.js';
import { sellerLineOf } from '@services/email/seller.js';

export type OrderReceiptTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // the receipt of the sale, or of a return
  kind: 'sale' | 'return';
  // what the fiscal service gave: the number of the receipt, the page to check it at, the text its
  // law asks to show (a line each)
  number: string | null;
  checkUrl: string | null;
  lawText: string | null;
  // the sum of the receipt (below 0 for a return, shown as it is)
  amount: number | string;
  // the currency of the order, for example "EUR"
  currency: string;
  // where the buyer writes: the address the shop answers from
  supportEmail?: string;
  userName?: string;
  appName?: string;
  logoUrl?: string | null;
  locale?: string;
};

// the mail itself is orderReceipt.html and orderReceipt.txt next to this file. It goes when the
// fiscal service registered the receipt of a sale or of a return of the order (docs/taxes.md): its
// number, the page of the service to check it, and the text its law asks to show
export function buildOrderReceiptTemplate(args: OrderReceiptTemplateArgs): {
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
  const amount = money.format(Number(args.amount));
  const of = args.kind === 'return' ? 'Return' : 'Sale';

  const values = {
    appName,
    orderId,
    orderUrl,
    ...(args.supportEmail !== undefined ? { supportEmail: args.supportEmail.trim() } : {}),
    userName: args.userName?.trim() || '',
    logoUrl: args.logoUrl?.trim() || '',
    year: String(new Date().getFullYear()),
    title: t(`orderReceipt.subject${of}`, locale, { appName, orderId }),
    preview: t(`orderReceipt.preview${of}`, locale, { amount, orderId }),
    heading: t(`orderReceipt.heading${of}`, locale),
    body: t(`orderReceipt.body${of}`, locale, { amount, orderId }),
    numberLine: args.number?.trim()
      ? t('orderReceipt.numberLine', locale, { number: args.number.trim() })
      : '',
    checkUrl: args.checkUrl?.trim() || '',
    checkLine: t('orderReceipt.checkLine', locale),
    lawLines: (args.lawText ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ line })),
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
    text: renderTemplate('orders/orderReceipt.txt', values),
    html: renderTemplate('orders/orderReceipt.html', values),
  };
}
