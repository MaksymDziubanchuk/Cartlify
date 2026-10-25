import type { PaymentProvider as PaymentProviderName } from '@prisma/client';

import type { CheckoutSessionDto } from 'types/dto/payments.dto.js';

// the names the database knows (orders.paymentProvider), also of a provider this server has not
export type { PaymentProviderName };

// a confirmed order a payment page is opened for
export type PaymentPageOrder = {
  orderId: number;
  userId: number;
  // in the currency of the provider
  total: number;
  reservationExpiresAt: Date;
  // when the app last closed a page of the order to open one at another provider, null when it
  // never did; a page opened after it is a new page, never the closed one again
  pageClosedAt: Date | null;
  // what is bought, the way the page shows it: the name each item was confirmed with, its price
  // and units; together they are the total
  items: { name: string; unitPrice: number; quantity: number }[];
  // the email of the buyer, the page fills it in; none for an account without one
  customerEmail: string | null;
};

// what became of an unpaid payment page the app asked to close:
// closed - nothing can be paid on it any more, closed now or before
// paid - the money is taken, the payment event marks the order paid
// in_progress - a payment is on its way (a bank still decides), the page cannot be closed now
// open - the provider answered that the page is still open and it did not close it
export type PaymentPageCloseResult =
  | { state: 'closed' }
  | { state: 'paid' }
  | { state: 'in_progress' }
  | { state: 'open'; cause: unknown };

// what the rest of the app asks of a payment provider by its name. How a provider does it is its
// own: its pages, its payment events, its refunds and their rules stay in its folder
export interface PaymentProvider {
  name: PaymentProviderName;
  // how the buyer and the chat bot name it
  label: string;
  // the currency it charges in, lower case, for example "eur"
  currency: string;
  // the smallest total it takes
  minimumTotal: number;
  // the path its payment events come to; it is outside the request rate limit
  callbackPath: string;

  // opens the payment page of a confirmed order; the same order with the same reservation gets
  // the same page. Throws PAYMENT_PROVIDER_UNAVAILABLE when the provider cannot be reached
  openPaymentPage(
    order: PaymentPageOrder,
  ): Promise<{ pageId: string; checkoutSession: CheckoutSessionDto }>;

  // closes an unpaid page; throws PAYMENT_PROVIDER_UNAVAILABLE when the provider cannot be asked
  closePaymentPage(pageId: string): Promise<PaymentPageCloseResult>;

  // returns the whole payment; a repeated call for the same payment gives no money twice
  refundPayment(args: { orderId: number; paymentId: string }): Promise<{ refundId: string | null }>;
}
