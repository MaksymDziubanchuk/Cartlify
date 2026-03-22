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
  url: string;
  mode: StripeCheckoutMode;
  status: StripeCheckoutSessionStatus;
  paymentStatus: StripeCheckoutPaymentStatus;
  expiresAt: string;
}

export interface CheckoutSessionResponseDto {
  checkoutSession: CheckoutSessionDto;
}
