import { InternalError } from '@utils/errors.js';

import { getPaymentProvider } from '../../providers/index.js';

import type { PaymentProviderName } from '../../providers/types.js';

type RefundWholePaymentArgs = {
  provider: PaymentProviderName;
  paymentId: string;
  orderId: number;
  // the whole sum the payment took, in the currency of the shop
  amount: string;
};

// gives the whole payment back at once, for the two places that return all of it: a payment the
// order could not take and the cancel of a paid order. One key per payment, so a delivery of the
// event again or a second click gives the money back once. A refund on its way counts as made. The
// money not going back (the provider refused, or did not answer) is an error: the event is
// delivered again, the order does not become cancelled
export async function refundWholePayment({
  provider,
  paymentId,
  orderId,
  amount,
}: RefundWholePaymentArgs): Promise<{ refundId: string | null }> {
  const answer = await getPaymentProvider(provider).refundPayment({
    orderId,
    paymentId,
    amount,
    key: `refund:${paymentId}`,
  });

  // the money of the payment is back already, e.g. the event came again after the provider forgot the key
  if (answer.status === 'failed' && answer.alreadyRefunded) return { refundId: null };

  if (answer.status === 'failed' || (answer.status === 'pending' && answer.refundId === null)) {
    throw new InternalError({
      reason: 'PAYMENT_REFUND_FAILED',
      provider,
      orderId,
      paymentId,
      refundId: answer.refundId,
      refundStatus: answer.status,
    });
  }

  return { refundId: answer.refundId };
}
