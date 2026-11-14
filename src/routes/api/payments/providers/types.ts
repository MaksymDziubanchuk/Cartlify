import type {
  DisputeStatus,
  PaymentProvider as PaymentProviderName,
  RefundFailure,
} from '@prisma/client';

import type { CheckoutSessionDto } from 'types/dto/payments.dto.js';

// the names the database knows (orders.paymentProvider, money_log.failure,
// payment_disputes.status), also of a provider this server has not
export type { DisputeStatus, PaymentProviderName, RefundFailure };

// where a transfer of money back stands at the provider:
// succeeded - the money is on its way to the buyer for good
// pending - the provider has not decided yet, or did not answer (then there is no id): the same
//   key asks again and gets the one refund
// failed - the money did not go back; failure is the reason in our words and failureText the
//   words of the provider. already_refunded: the payment had not that much left to give back
//   (given back before, by the app or by hand at the provider), so no refund was made
export type RefundAnswer = {
  refundId: string | null;
  status: 'succeeded' | 'pending' | 'failed';
  failure?: RefundFailure;
  failureText?: string;
  // the number the bank of the buyer knows the refund by (for a card the acquirer reference
  // number), for the buyer to follow the money at the bank: null until the provider has it, and
  // for a way of paying without one
  bankReference: string | null;
};

// a refund of a payment the way the provider keeps it: ours carry the key of their transfer, one
// made by hand at the provider (its dashboard) carries none
export type PaymentRefund = RefundAnswer & {
  refundId: string;
  // digits with two decimals, in the currency of the shop
  amount: string;
  // the key of the transfer of the app it was made for; null for a refund made by hand
  transferKey: string | null;
  // why it was made, in the words of the provider (for Stripe duplicate, fraudulent,
  // requested_by_customer); null when nobody said. A hint for root, never a decision
  reason: string | null;
  // when the provider made it
  createdAt: Date;
};

// a dispute of a payment the buyer opened at the bank, or an inquiry of the bank, as it stands at
// the provider now: the state comes from the provider each time, never from the order of events
export type PaymentDispute = {
  id: string;
  // the payment it disputes; null for a charge without one (not a payment of the app)
  paymentId: string | null;
  status: DisputeStatus;
  // why the bank says it is disputed, in the words of the provider (fraudulent, general, ...)
  reason: string;
  // the sum disputed, digits with two decimals, and its currency lower case
  amount: string;
  currency: string;
  // the last moment the evidence can be submitted; null when the provider gives none
  evidenceDueBy: Date | null;
  // evidence is on it, staged or submitted
  hasEvidence: boolean;
  // how many times evidence was submitted: once at most, as a rule
  submissionCount: number;
  // the payment can still be given back by a refund
  isChargeRefundable: boolean;
  openedAt: Date;
  // the money it moved on the balance of the shop, as the provider moved it
  transactions: PaymentDisputeTransaction[];
};

// one move of money of a dispute on the balance of the shop
export type PaymentDisputeTransaction = {
  id: string;
  // signed, digits with two decimals, without the fee: below 0 taken from the shop, above 0 given
  // back to it
  amount: string;
  // the fee of the provider for it, signed as the provider charges it: above 0 charged, below 0
  // given back
  fee: string;
  currency: string;
  createdAt: Date;
};

// what the app puts on a dispute as a draft of the evidence, each a text the bank reads (at most
// 20000 characters each and 150000 together at Stripe); a field not given is left as it is
export type DisputeEvidence = {
  // what was bought: the order and its items
  productDescription?: string;
  customerName?: string;
  customerEmailAddress?: string;
  shippingAddress?: string;
  shippingCarrier?: string;
  shippingTrackingNumber?: string;
  // when the order was sent
  shippingDate?: string;
  // how the buyer was shown the rules of returns
  refundPolicyDisclosure?: string;
  // why the payment was not given back, or what of it was
  refundRefusalExplanation?: string;
  // the rest: the refunds of the payment, a statement of return, the delivery
  uncategorizedText?: string;
};

// put - the draft is on the dispute and nothing is submitted
// refused - the provider did not take it, in its words: the dispute is closed, or a person has
//   submitted the evidence already
export type DisputeEvidenceAnswer = { status: 'put' } | { status: 'refused'; refusalText: string };

// a payment page the provider took the money on, read the way its payment event is read
export type PaidPage = {
  pageId: string;
  orderId: number;
  // the owner of the order the page carries, for an order deleted since; null when it has none
  userId: number | null;
  paymentId: string;
  // the sum taken, digits with two decimals, and its currency lower case
  amount: string;
  currency: string;
};

// what a payment page is, read at the provider the way its payment event is read:
// paid - the money is taken
// unpaid - nothing is taken yet: the page is open or closed, or a bank still decides
// foreign - not a page the app opened for an order (another tool in the same account): its money
//   is left alone and nothing else of it is read
export type PaymentPageReading =
  | ({ state: 'paid' } & PaidPage)
  | { state: 'unpaid'; pageId: string; orderId: number }
  | { state: 'foreign'; pageId: string };

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
  // what the buyer pays for the delivery, part of the total, 0 when it is free or a pickup: a line
  // of its own on the page
  deliveryPrice: number;
  // where and to whom the order goes, the payment carries it; none for a pickup
  shipping: PaymentPageShipping | null;
  // the email of the buyer, the page fills it in; none for an account without one
  customerEmail: string | null;
  // the language of the buyer (mailLocaleOf, as for a mail); a provider uses it when it can, else
  // its own way of guessing one (for example the browser's)
  locale: string;
};

export type PaymentPageShipping = {
  name: string;
  phone: string;
  address: {
    line1: string;
    line2: string | null;
    city: string;
    postalCode: string | null;
    country: string;
  };
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

// a page of the same order and reservation was opened before with other values (the buyer's
// language, a setting root changed since): the provider will not give that page again for them,
// the caller closes it and opens a new one (createCheckout.service.ts)
export class PaymentPageChangedError extends Error {
  constructor(cause: unknown) {
    super('PAYMENT_PAGE_CHANGED', { cause });
    this.name = 'PaymentPageChangedError';
  }
}

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
  // the same page. Throws PAYMENT_PROVIDER_UNAVAILABLE when the provider cannot be reached, and
  // PaymentPageChangedError when that page was opened with other values
  openPaymentPage(
    order: PaymentPageOrder,
  ): Promise<{ pageId: string; checkoutSession: CheckoutSessionDto }>;

  // closes an unpaid page; throws PAYMENT_PROVIDER_UNAVAILABLE when the provider cannot be asked
  closePaymentPage(pageId: string): Promise<PaymentPageCloseResult>;

  // gives back the sum (digits with up to two decimals) of a payment. The key is the one of our
  // transfer: a repeated call with it is the same transfer, a new transfer has a new key. A refusal
  // of the provider is a failed answer, no answer is a pending one without an id; the call does
  // not throw for either
  refundPayment(args: {
    orderId: number;
    paymentId: string;
    amount: string;
    key: string;
  }): Promise<RefundAnswer>;

  // where a refund the provider made stands now; throws PAYMENT_PROVIDER_UNAVAILABLE when the
  // provider cannot be asked
  getRefund(refundId: string): Promise<RefundAnswer>;

  // the refund the provider made for the key of a transfer, none when it made none: the answer to a
  // request may have been lost, and a provider forgets a key after a day, so the transfer is looked
  // for before it is asked again. Throws PAYMENT_PROVIDER_UNAVAILABLE when the provider cannot be asked
  findRefund(args: { paymentId: string; key: string }): Promise<RefundAnswer | null>;

  // every refund of a payment the provider has, the ones of the app and the ones made by hand at
  // the provider, the oldest first. Throws PAYMENT_PROVIDER_UNAVAILABLE when the provider cannot
  // be asked
  listRefunds(paymentId: string): Promise<PaymentRefund[]>;

  // a dispute as it stands now, with the money it moved. Throws PAYMENT_PROVIDER_UNAVAILABLE when
  // the provider cannot be asked
  getDispute(disputeId: string): Promise<PaymentDispute>;

  // puts a draft of the evidence on a dispute and never submits it: a person reads it at the
  // provider, adds to it and submits it. A refusal of the provider is an answer, the call does not
  // throw for it; throws PAYMENT_PROVIDER_UNAVAILABLE when the provider cannot be asked
  putDisputeEvidence(disputeId: string, evidence: DisputeEvidence): Promise<DisputeEvidenceAnswer>;

  // what a payment page is now, read the way its payment event is read: for a page whose money
  // was taken while its event did not come. Throws PAYMENT_PROVIDER_UNAVAILABLE when the provider
  // cannot be asked
  readPaidPage(pageId: string): Promise<PaymentPageReading>;
}
