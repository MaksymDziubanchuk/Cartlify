import type { OrderId, UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

export type StripeCheckoutMode = 'payment';

export type StripeCheckoutSessionStatus = 'open' | 'complete' | 'expired';

export type StripeCheckoutPaymentStatus = 'paid' | 'unpaid' | 'no_payment_required';

// POST /checkout/sessions
export interface CreateCheckoutSessionBodyDto {
  orderId: OrderId;
}

export interface CreateCheckoutSessionDto extends CreateCheckoutSessionBodyDto {
  actorId: UserId;
  actorRole: Role;
}

export interface CheckoutSessionDto {
  sessionId: string;
  url: string | null;
  mode: StripeCheckoutMode;
  status: StripeCheckoutSessionStatus;
  paymentStatus: StripeCheckoutPaymentStatus;
  expiresAt: string;
}

export interface CheckoutSessionResponseDto {
  checkoutSession: CheckoutSessionDto;
}

// GET /checkout/sessions/:sessionId
export interface GetCheckoutSessionByIdParamsDto {
  sessionId: string;
}

export interface GetCheckoutSessionByIdDto extends GetCheckoutSessionByIdParamsDto {
  actorId: UserId;
  actorRole: Role;
}

// POST /webhook
export interface HandleStripeWebhookDto {
  stripeSignature: string;
  rawBody: string | Buffer;
}

export interface StripeWebhookResponseDto {
  received: true;
}
