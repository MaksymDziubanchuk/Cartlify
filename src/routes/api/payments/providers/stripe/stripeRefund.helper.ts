import stripe from '@config/stripe.js';
import { InternalError, ServiceUnavailableError } from '@utils/errors.js';

import { isStripeResourceMissing, isStripeUnavailable } from './stripeCheckout.helper.js';

import type Stripe from 'stripe';
import type { RefundAnswer, RefundFailure } from '../types.js';

type RefundStripePaymentArgs = {
  orderId: number;
  paymentIntentId: string;
  // the sum to give back, in the currency of the shop: digits with up to two decimals
  amount: string;
  // the key of the transfer: a repeated call with it gives the same refund, never a second one
  key: string;
};

// the words of stripe for why a refund failed, in ours (the reasons stripe lists: a card that can no
// longer take money, the balance of the shop, a dispute at the bank; the rest is unknown)
const FAILURES: Record<string, RefundFailure> = {
  lost_or_stolen_card: 'card_unavailable',
  expired_or_canceled_card: 'card_unavailable',
  insufficient_funds: 'shop_balance',
  charge_for_pending_refund_disputed: 'disputed',
};

// the longest text of a failure the database keeps
const FAILURE_TEXT_MAX = 500;

// the amount in cents without float math; anything but digits with up to two decimals, or a sum
// of nothing, is the mistake of the app and never reaches stripe
function centsOf(amount: string, orderId: number): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
  const cents = match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : 0;

  if (!Number.isSafeInteger(cents) || cents <= 0) {
    throw new InternalError({ reason: 'STRIPE_REFUND_AMOUNT_INVALID', orderId, amount });
  }

  return cents;
}

// what stripe says of a refund, in the answer of the app: succeeded, still on its way (pending, or
// waiting for the buyer), or failed with the reason
export function refundAnswerOf(refund: Stripe.Refund): RefundAnswer {
  if (refund.status === 'succeeded') return { refundId: refund.id, status: 'succeeded' };

  if (refund.status === 'failed' || refund.status === 'canceled') {
    return {
      refundId: refund.id,
      status: 'failed',
      failure: FAILURES[refund.failure_reason ?? ''] ?? 'unknown',
      failureText: (refund.failure_reason ?? refund.status).slice(0, FAILURE_TEXT_MAX),
    };
  }

  return { refundId: refund.id, status: 'pending' };
}

// gives back part or all of a stripe payment. Stripe refusing the request is a failure with its
// words; stripe not answering (the network, a server error, a rate limit) is no failure: the refund
// may have been made, so it stays pending and the same key asks again
export async function refundStripePayment({
  orderId,
  paymentIntentId,
  amount,
  key,
}: RefundStripePaymentArgs): Promise<RefundAnswer> {
  const cents = centsOf(amount, orderId);

  try {
    const refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        amount: cents,
        // the key of the transfer rides with the refund, so the event stripe sends for it finds the
        // transfer even before the app has kept the id
        metadata: {
          entityType: 'order',
          entityId: String(orderId),
          transfer: key,
        },
      },
      { idempotencyKey: key },
    );

    return refundAnswerOf(refund);
  } catch (err) {
    const e = err as {
      type?: unknown;
      code?: unknown;
      message?: unknown;
      statusCode?: unknown;
    } | null;

    // a request of the same key still running at stripe may yet make the refund: no answer
    if (e?.statusCode === 409 || e?.code === 'idempotency_key_in_use') {
      return { refundId: null, status: 'pending' };
    }

    if (e?.type === 'StripeInvalidRequestError') {
      return {
        refundId: null,
        status: 'failed',
        // a charge the buyer disputed at the bank: the bank gives the money back
        failure: e.code === 'charge_disputed' ? 'disputed' : 'unknown',
        failureText: String(e.message ?? '').slice(0, FAILURE_TEXT_MAX),
        // the money of the charge is back already, which the late payments take as done
        ...(e.code === 'charge_already_refunded' ? { alreadyRefunded: true } : {}),
      };
    }

    return { refundId: null, status: 'pending' };
  }
}

// the refund stripe made for the key of a transfer: the key rides in the metadata of the refund.
// A payment has few refunds, the list of one page holds them. None when stripe made none; stripe
// out of reach is PAYMENT_PROVIDER_UNAVAILABLE
export async function findStripeRefund({
  paymentIntentId,
  key,
}: {
  paymentIntentId: string;
  key: string;
}): Promise<RefundAnswer | null> {
  try {
    const refunds = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: 100 });
    const found = refunds.data.find((refund) => refund.metadata?.transfer === key);

    return found ? refundAnswerOf(found) : null;
  } catch (err) {
    if (isStripeUnavailable(err)) {
      throw new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE', undefined, err);
    }

    throw err;
  }
}

// where a refund stands now, for the transfers that stayed pending. Stripe out of reach is
// PAYMENT_PROVIDER_UNAVAILABLE (ask again later); a refund it has no record of is a server error
export async function getStripeRefund(refundId: string): Promise<RefundAnswer> {
  try {
    return refundAnswerOf(await stripe.refunds.retrieve(refundId));
  } catch (err) {
    if (isStripeUnavailable(err)) {
      throw new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE', undefined, err);
    }

    if (isStripeResourceMissing(err)) {
      throw new InternalError({ reason: 'STRIPE_REFUND_NOT_FOUND', refundId }, err);
    }

    throw err;
  }
}
