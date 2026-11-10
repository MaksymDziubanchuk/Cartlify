import { InternalError } from '@utils/errors.js';

import { getPaymentProvider } from '../../providers/index.js';

import type { PaymentProviderName, RefundAnswer } from '../../providers/types.js';

type RefundWholePaymentArgs = {
  provider: PaymentProviderName;
  paymentId: string;
  orderId: number;
  // the whole sum the payment took, in the currency of the shop
  amount: string;
};

// gives the whole payment back at once, for the two places that return all of it: a payment the
// order could not take and the cancel of a paid order. One key per payment, so a delivery of the
// event again or a second click gives the money back once. A refund the provider made is the
// answer: its money is sent already (succeeded), the provider has not decided yet (pending), or it
// failed at once (failed, with its reason, settled like a refund that fails later). No refund made
// (the provider refused the request itself, or did not answer) is an error: the event is
// delivered again, the order does not become cancelled
export async function refundWholePayment({
  provider,
  paymentId,
  orderId,
  amount,
}: RefundWholePaymentArgs): Promise<RefundAnswer & { status: 'succeeded' | 'pending' | 'failed' }> {
  const answer = await getPaymentProvider(provider).refundPayment({
    orderId,
    paymentId,
    amount,
    key: `refund:${paymentId}`,
  });

  // the money of the payment is back already, e.g. the event came again after the provider forgot the
  // key, or an admin gave it back at the provider: it is sent
  if (answer.status === 'failed' && answer.alreadyRefunded) {
    return { refundId: null, status: 'succeeded' };
  }

  if (answer.status === 'failed' && answer.refundId !== null) {
    return {
      refundId: answer.refundId,
      status: 'failed',
      ...(answer.failure ? { failure: answer.failure } : {}),
      ...(answer.failureText ? { failureText: answer.failureText } : {}),
    };
  }

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

  return { refundId: answer.refundId, status: answer.status };
}
