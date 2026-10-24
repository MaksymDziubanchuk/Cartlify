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
