import type { FastifyBaseLogger } from 'fastify';
import type { ReturnOutsideMethod } from '@prisma/client';

import type { AvailablePaymentProviderName } from '@routes/api/payments/providers/names.js';
import type { OrderId, UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

export type CheckoutMode = 'payment';

export type CheckoutSessionStatus = 'open' | 'complete' | 'expired';

export type CheckoutPaymentStatus = 'paid' | 'unpaid' | 'no_payment_required';

// POST /checkout/sessions
export interface CreateCheckoutSessionBodyDto {
  orderId: OrderId;
  provider: AvailablePaymentProviderName;
}

export interface CreateCheckoutSessionDto extends CreateCheckoutSessionBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export interface CheckoutSessionDto {
  provider: AvailablePaymentProviderName;
  // the id of the page at the provider
  sessionId: string;
  url: string | null;
  mode: CheckoutMode;
  status: CheckoutSessionStatus;
  paymentStatus: CheckoutPaymentStatus;
  // time after which this checkout can no longer be paid
  expiresAt: string;
}

export interface CheckoutSessionResponseDto {
  checkoutSession: CheckoutSessionDto;
}

// the order of a page the buyer comes back to: the provider may call the page paid while the
// order could not take the money and it went back
export interface CheckoutSessionOrderDto {
  id: OrderId;
  status: 'pending' | 'unconfirmed' | 'waiting' | 'paid' | 'shipped' | 'delivered' | 'cancelled';
  // the money of the payment of this page went back, the order does not hold it
  paymentRefunded: boolean;
}

export interface CheckoutSessionReadResponseDto extends CheckoutSessionResponseDto {
  order: CheckoutSessionOrderDto;
}

// GET /stripe/checkout/sessions/:sessionId
export interface GetCheckoutSessionByIdParamsDto {
  sessionId: string;
}

export interface GetCheckoutSessionByIdDto extends GetCheckoutSessionByIdParamsDto {
  actorId: UserId;
  actorRole: Role;
}

// POST /stripe/webhook
export interface HandleStripeWebhookDto {
  stripeSignature: string;
  rawBody: string | Buffer;
}

export interface StripeWebhookResponseDto {
  received: true;
  // event was acknowledged without any action, with the reason
  skipped?: 'ORDER_NOT_FOUND' | 'NOT_AN_ORDER' | 'REFUNDED';
}

// GET /refunds: the refunds that wait for the shop
export type PaymentRefundState = 'failed' | 'unsent';

export interface GetPaymentRefundsQueryDto {
  // failed: money that did not reach the buyer, to be sent another way; unsent: the refund of a
  // late payment whose money was not told sent or failed
  state: PaymentRefundState;
  userId?: number;
  orderId?: number;
  // only the ones that came to their state before this time
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface PaymentRefundItemDto {
  // the id of a case (the one an alert puts aside): the statement for a return, the refund at the
  // provider for a payment
  id: string;
  source: 'return' | 'payment';
  orderId: number;
  // the buyer
  userId: number;
  // the statement, for a return
  returnId: number | null;
  provider: string | null;
  paymentId: string | null;
  // the refund at the provider, for a payment
  refundId: string | null;
  // the money, none when it is not told in one sum (a statement: see its card)
  amount: number | null;
  currency: string | null;
  // why it failed, in our words and in the words of the provider
  failure: string | null;
  failureText: string | null;
  // when it came to its state: the transfer failed, the refund was made
  at: string;
}

export interface GetPaymentRefundsResponseDto {
  items: PaymentRefundItemDto[];
  // of the filter, not only of the page
  total: number;
  limit: number;
  nextCursor: string | null;
}

export interface ListPaymentRefundsDto extends Omit<GetPaymentRefundsQueryDto, 'to' | 'limit'> {
  actorId: UserId;
  actorRole: Role;
  to?: Date | undefined;
  limit: number;
}

// POST /refunds/:refundId/outside: the ways root sends money outside the app by hand (a chargeback is
// the end of a dispute at the bank, not a way to send money)
export type PaymentRefundOutsideMethod = Exclude<ReturnOutsideMethod, 'chargeback'>;

export interface MarkPaymentRefundOutsideParamsDto {
  refundId: string;
}

export interface MarkPaymentRefundOutsideBodyDto {
  method: PaymentRefundOutsideMethod;
  note: string;
  // the day the money really went, never of the future and never before the refund was made
  at: string;
}

export interface MarkPaymentRefundOutsideDto
  extends MarkPaymentRefundOutsideParamsDto, MarkPaymentRefundOutsideBodyDto {
  actorId: UserId;
  actorRole: Role;
  log: FastifyBaseLogger;
}

export interface PaymentRefundOutsideDto {
  refundId: string;
  orderId: number;
  userId: number;
  provider: string;
  paymentId: string;
  amount: number;
  currency: string | null;
  state: 'outside';
  // why the refund failed
  failure: string | null;
  failureText: string | null;
  outside: {
    method: PaymentRefundOutsideMethod;
    note: string;
    at: string;
    by: number;
  };
}
