import type { UserId } from 'types/ids.js';
import type { Role } from 'types/user.js';

// the routes of Stripe itself, under /api/payments/stripe

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
