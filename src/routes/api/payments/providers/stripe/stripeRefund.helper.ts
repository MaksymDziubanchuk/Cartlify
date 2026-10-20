import stripe from '@config/stripe.js';
import { InternalError } from '@utils/errors.js';

type RefundStripePaymentArgs = {
  orderId: number;
  paymentIntentId: string;
};

// refund the whole stripe payment
export async function refundStripePayment({
  orderId,
  paymentIntentId,
}: RefundStripePaymentArgs): Promise<{ refundId: string | null }> {
  try {
    // one key per payment: a repeated webhook delivery returns the same refund instead of a second one
    // params stay constant for this key, stripe rejects a reused key with other params
    const refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        metadata: {
          entityType: 'order',
          entityId: String(orderId),
        },
      },
      { idempotencyKey: `refund:${paymentIntentId}` },
    );

    return { refundId: refund.id };
  } catch (err) {
    // money is already back, e.g. webhook was redelivered after stripe forgot the idempotency key
    if ((err as { code?: unknown } | null)?.code === 'charge_already_refunded') {
      return { refundId: null };
    }

    // any other failure must reach stripe as an error, so the webhook is delivered again
    throw new InternalError(
      {
        reason: 'STRIPE_REFUND_FAILED',
        orderId,
        paymentIntentId,
      },
      err,
    );
  }
}
