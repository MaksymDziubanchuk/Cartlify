import type { FastifyBaseLogger } from 'fastify';
import type { DisputeStatus, OutsideMethod } from '@prisma/client';
import type { OrderHold } from '@helpers/orderHolds.js';

import type { AvailablePaymentProviderName } from '@routes/api/payments/providers/names.js';
import type {
  MoneyRefundNeed,
  MoneyRefundPurpose,
  MoneyRefundState,
} from '@routes/api/payments/services/helpers/moneyRefunds.helper.js';
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

// why an event was taken without anything done (the answers of the webhook): a page that is not of
// an order, an order that is gone or not in the state the event needs, an object of another kind,
// a payment the order never takes (its money goes back), a refund of a key nobody knows
export type StripeWebhookSkip =
  | 'ORDER_NOT_FOUND'
  | 'ORDER_NOT_CONFIRMED'
  | 'ORDER_STATUS_NOT_WAITING'
  | 'ORDER_ITEMS_REQUIRED'
  | 'NOT_AN_ORDER'
  | 'OBJECT_INVALID'
  | 'REFUNDED'
  | 'UNKNOWN_REFUND';

export interface StripeWebhookResponseDto {
  received: true;
  // event was acknowledged without any action, with the reason
  skipped?: StripeWebhookSkip;
}

// GET /refunds: the refunds of the money journal
export interface GetPaymentRefundsQueryDto {
  purpose?: MoneyRefundPurpose;
  // any by default; failed: the failures that wait for the shop; unassigned: the refunds made by
  // hand that wait for root
  state?: 'in_transit' | 'failed' | 'unassigned' | 'any';
  need?: MoneyRefundNeed;
  userId?: number;
  orderId?: number;
  // the time it came to its state, from and before
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
}

export interface PaymentRefundItemDto {
  // the first line of the refund in the money journal: the id of a case, the one root names
  id: number;
  purpose: MoneyRefundPurpose;
  state: MoneyRefundState;
  // a refund made by hand that waits for root: what it needs
  need: MoneyRefundNeed | null;
  orderId: number | null;
  // the buyer
  userId: number | null;
  returnId: number | null;
  // the code of that statement (W42-2)
  returnCode: string | null;
  provider: string | null;
  paymentId: string | null;
  refundId: string | null;
  // what the provider was asked for
  amount: number;
  currency: string | null;
  // why it failed, in our words and in the words of the provider
  failure: string | null;
  failureText: string | null;
  // the number the bank of the buyer knows the refund by
  bankReference: string | null;
  byDashboard: boolean;
  createdAt: string;
  // when it came to its state
  at: string;
  // what is left of the payment at the provider, as much as it can still give back
  paymentLeft: number | null;
  // what the open statement of the refund still has to send the buyer (the total of the money left
  // of its card); null without a statement or once it is closed
  returnLeft: number | null;
}

export interface GetPaymentRefundsResponseDto {
  items: PaymentRefundItemDto[];
  // of the filter, not only of the page
  total: number;
  limit: number;
  nextCursor: string | null;
}

export interface ListPaymentRefundsDto extends Omit<
  GetPaymentRefundsQueryDto,
  'from' | 'to' | 'limit'
> {
  actorId: UserId;
  actorRole: Role;
  from?: Date | undefined;
  to?: Date | undefined;
  limit: number;
}

// POST /refunds/:refundId/outside: the ways root sends money outside the app by hand
export type PaymentRefundOutsideMethod = OutsideMethod;

export interface MarkPaymentRefundOutsideParamsDto {
  refundId: number | string;
}

export interface MarkPaymentRefundOutsideBodyDto {
  method: PaymentRefundOutsideMethod;
  note: string;
  // the day the money really went, never of the future and never before the refund was made
  at: string;
}

export interface MarkPaymentRefundOutsideDto extends MarkPaymentRefundOutsideBodyDto {
  actorId: UserId;
  actorRole: Role;
  refundId: number;
  log: FastifyBaseLogger;
}

export interface PaymentRefundOutsideDto extends PaymentRefundItemDto {
  outside: {
    method: PaymentRefundOutsideMethod;
    note: string;
    at: string;
    by: number;
  };
}

// POST /compensations: root gives the buyer of an order money by the button of the app
export interface GiveCompensationBodyDto {
  orderId: number;
  amount: number;
  note: string;
}

export interface GiveCompensationDto extends GiveCompensationBodyDto {
  actorId: UserId;
  actorRole: Role;
  log: FastifyBaseLogger;
}

// POST /money-lines/:moneyLogId/decision: root says what money given back by hand or taken by a
// bank for a lost dispute was for
export interface MoneyLineParamsDto {
  moneyLogId: number | string;
}

export interface MoneyDecisionItemDto {
  orderItemId: number;
  quantity: number;
  amount: number;
}

export interface MoneyDecisionBodyDto {
  items: MoneyDecisionItemDto[];
  delivery?: number;
  note: string;
}

export interface DecideMoneyUseDto extends MoneyDecisionBodyDto {
  actorId: UserId;
  actorRole: Role;
  moneyLogId: number;
  log: FastifyBaseLogger;
}

export interface MoneyDecisionDto {
  moneyLogId: number;
  orderId: number;
  use: 'goods' | 'compensation' | 'loss';
  distributed: string;
  rest: string;
  // the rows of open statements paid with it at once
  covered: { returnId: number; itemIds: number[] }[];
  note: string;
}

// GET /disputes and /disputes/:disputeId: the disputes of the payments at the bank
export interface GetDisputesQueryDto {
  // states through commas
  status?: string;
  open?: boolean;
  // open with nothing submitted yet
  toAnswer?: boolean;
  moneyUndecided?: boolean;
  closedFrom?: string;
  orderId?: number;
  limit?: number;
  cursor?: string;
}

export interface ListDisputesDto {
  actorId: UserId;
  actorRole: Role;
  statuses?: DisputeStatus[] | undefined;
  open?: boolean | undefined;
  toAnswer?: boolean | undefined;
  closedFrom?: Date | undefined;
  orderId?: number | undefined;
  moneyUndecided?: boolean | undefined;
  limit: number;
  cursor?: string | undefined;
}

export interface DisputeItemDto {
  id: number;
  provider: string;
  // the id of the dispute at the provider
  stripeId: string;
  paymentId: string;
  orderId: number | null;
  userId: number | null;
  // the payment is one the order could not take
  late: boolean;
  reason: string | null;
  status: DisputeStatus;
  open: boolean;
  evidenceDueBy: string | null;
  hasEvidence: boolean;
  submissionCount: number;
  isChargeRefundable: boolean;
  // what the dispute took less what it gave back
  withdrawn: number;
  // a statement of the order is open
  returnOpen: boolean;
  openedAt: string;
  closedAt: string | null;
  draftedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GetDisputesResponseDto {
  items: DisputeItemDto[];
  total: number;
  limit: number;
  nextCursor: string | null;
}

export interface GetDisputeParamsDto {
  disputeId: number | string;
}

export interface GetDisputeDto {
  actorId: UserId;
  actorRole: Role;
  disputeId: number;
}

export interface DisputeCardDto extends DisputeItemDto {
  money: {
    id: number;
    event: string;
    amount: number;
    currency: string | null;
    stripeTxId: string | null;
    // what the money was decided for; null while it waits for root
    moneyUse: string | null;
    createdAt: string;
  }[];
  order: { id: number; status: string; total: number; holds: OrderHold[] } | null;
  returns: {
    id: number;
    code: string;
    reason: string | null;
    refundedTotal: number;
    // what an open statement still owes the buyer (the total of the money left of its card); null
    // once it is closed
    moneyLeft: number | null;
    closedAt: string | null;
  }[];
}
