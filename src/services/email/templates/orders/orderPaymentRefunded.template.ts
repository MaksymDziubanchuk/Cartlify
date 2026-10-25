import { renderTemplate } from '@services/email/renderTemplate.js';

// why the order could not take the payment, the answers of pay_order that give the money back
export type PaymentRefundReason =
  | 'OUT_OF_STOCK'
  | 'ALREADY_PAID_OTHER_PAYMENT'
  | 'AMOUNT_MISMATCH'
  | 'ORDER_NOT_PAYABLE'
  | 'ORDER_NOT_FOUND';

export type OrderPaymentRefundedTemplateArgs = {
  orderId: number;
  // the order page of the frontend
  orderUrl: string;
  // the payment that went back, all of it
  amount: number | string;
  // the currency it was paid in, for example "eur"
  currency: string;
  reason: PaymentRefundReason;
  userName?: string;
  appName?: string;
  logoCid?: string;
};

// the words of the mail for each reason; it comes after the reservation of the order was over
const REASONS: Record<PaymentRefundReason, string> = {
  OUT_OF_STOCK: 'the reservation of the order was over and some items of it were no longer in stock',
  ALREADY_PAID_OTHER_PAYMENT: 'the order was paid with another payment already',
  AMOUNT_MISMATCH: 'the order changed after the payment page was opened',
  ORDER_NOT_PAYABLE: 'the order could not take a payment any more',
  ORDER_NOT_FOUND: 'the order no longer exists',
};

// what became of the order: only another payment of it leaves it paid
const orderLine = (reason: PaymentRefundReason) =>
  reason === 'ALREADY_PAID_OTHER_PAYMENT'
    ? 'The order stays paid with your other payment.'
    : 'The order is not paid and nothing will be sent.';

// the mail itself is orderPaymentRefunded.html and orderPaymentRefunded.txt next to this file
export function buildOrderPaymentRefundedTemplate(args: OrderPaymentRefundedTemplateArgs): {
  subject: string;
  text: string;
  html: string;
} {
  const appName = args.appName?.trim() || 'Cartlify';
  const orderUrl = args.orderUrl?.trim() || '';

  if (!orderUrl) throw new Error('ORDER_URL_REQUIRED');

  const money = new Intl.NumberFormat('en', {
    style: 'currency',
    currency: args.currency.trim().toUpperCase(),
  });

  const values = {
    appName,
    orderId: String(args.orderId),
    orderUrl,
    amount: money.format(Number(args.amount)),
    reason: REASONS[args.reason],
    orderLine: orderLine(args.reason),
    userName: args.userName?.trim() || '',
    logoCid: args.logoCid?.trim() || '',
    year: String(new Date().getFullYear()),
  };

  return {
    subject: `${appName} — The payment for order #${args.orderId} is refunded`,
    text: renderTemplate('orders/orderPaymentRefunded.txt', values),
    html: renderTemplate('orders/orderPaymentRefunded.html', values),
  };
}
