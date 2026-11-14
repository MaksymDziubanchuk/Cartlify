import stripe from '@config/stripe.js';
import { InternalError, ServiceUnavailableError } from '@utils/errors.js';

import {
  amountOfCents,
  isStripeResourceMissing,
  isStripeUnavailable,
} from './stripeCheckout.helper.js';

import type Stripe from 'stripe';
import type { PaymentRefund, RefundAnswer, RefundFailure } from '../types.js';

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

// the codes of stripe for a refund it refuses without making one, in our words: the payment has
// nothing left to give back (all of it given back before, by the app or by hand in the dashboard),
// or the buyer disputed it at the bank, which gives the money back then; any other refusal is
// unknown. Less left than asked comes with no code at all, only the parameter amount (the sandbox,
// 11.11.2026): the app sends only whole cents above 0, so a refusal of the amount is that one
const REFUSALS: Record<string, RefundFailure> = {
  charge_already_refunded: 'already_refunded',
  charge_disputed: 'disputed',
};

// the longest text of a failure the database keeps
const FAILURE_TEXT_MAX = 500;

// the most refunds stripe gives on one page of a list
const REFUNDS_PAGE = 100;

// the number the bank of the card knows the refund by (the acquirer reference number); stripe has
// it some days after the money is sent, and none for the other ways of paying
const bankReferenceOf = (refund: Stripe.Refund): string | null =>
  refund.destination_details?.card?.reference || null;

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
  const bankReference = bankReferenceOf(refund);

  if (refund.status === 'succeeded') {
    return { refundId: refund.id, status: 'succeeded', bankReference };
  }

  if (refund.status === 'failed' || refund.status === 'canceled') {
    return {
      refundId: refund.id,
      status: 'failed',
      failure: FAILURES[refund.failure_reason ?? ''] ?? 'unknown',
      failureText: (refund.failure_reason ?? refund.status).slice(0, FAILURE_TEXT_MAX),
      bankReference,
    };
  }

  return { refundId: refund.id, status: 'pending', bankReference };
}

// a refund as stripe lists it for a payment: where it stands, its sum, the key of the transfer
// that made it (none for one made by hand in the dashboard), its reason and its time
function paymentRefundOf(refund: Stripe.Refund): PaymentRefund {
  return {
    ...refundAnswerOf(refund),
    refundId: refund.id,
    amount: amountOfCents(refund.amount),
    transferKey: refund.metadata?.transfer || null,
    reason: refund.reason ?? null,
    createdAt: new Date(refund.created * 1000),
  };
}

// every refund of a payment, page after page, the newest first as stripe lists them. Stripe out of
// reach is PAYMENT_PROVIDER_UNAVAILABLE; a payment it has no record of is a server error
async function stripeRefundsOf(paymentIntentId: string): Promise<Stripe.Refund[]> {
  const refunds: Stripe.Refund[] = [];

  try {
    for (;;) {
      const last = refunds.at(-1);
      const page = await stripe.refunds.list({
        payment_intent: paymentIntentId,
        limit: REFUNDS_PAGE,
        ...(last ? { starting_after: last.id } : {}),
      });

      refunds.push(...page.data);

      // a page that brings nothing ends the list whatever it says, or stripe would be asked for ever
      if (!page.has_more || page.data.length === 0) return refunds;
    }
  } catch (err) {
    if (isStripeUnavailable(err)) {
      throw new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE', undefined, err);
    }

    if (isStripeResourceMissing(err)) {
      throw new InternalError(
        { reason: 'STRIPE_PAYMENT_NOT_FOUND', paymentId: paymentIntentId },
        err,
      );
    }

    throw err;
  }
}

// every refund of a payment, the ones of the app and the ones made by hand, the oldest first: for
// a refund the app asked for while one was made by hand, and for a refund made by hand whose event
// did not say all
export async function listStripeRefunds(paymentIntentId: string): Promise<PaymentRefund[]> {
  return (await stripeRefundsOf(paymentIntentId)).reverse().map(paymentRefundOf);
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
      param?: unknown;
      message?: unknown;
      statusCode?: unknown;
    } | null;

    // a request of the same key still running at stripe may yet make the refund: no answer
    if (e?.statusCode === 409 || e?.code === 'idempotency_key_in_use') {
      return { refundId: null, status: 'pending', bankReference: null };
    }

    if (e?.type === 'StripeInvalidRequestError') {
      return {
        refundId: null,
        status: 'failed',
        failure:
          REFUSALS[typeof e.code === 'string' ? e.code : ''] ??
          (e.code === undefined && e.param === 'amount' ? 'already_refunded' : 'unknown'),
        failureText: String(e.message ?? '').slice(0, FAILURE_TEXT_MAX),
        bankReference: null,
      };
    }

    return { refundId: null, status: 'pending', bankReference: null };
  }
}

// the refund stripe made for the key of a transfer: the key rides in the metadata of the refund,
// among all the refunds of the payment. None when stripe made none; stripe out of reach is
// PAYMENT_PROVIDER_UNAVAILABLE
export async function findStripeRefund({
  paymentIntentId,
  key,
}: {
  paymentIntentId: string;
  key: string;
}): Promise<RefundAnswer | null> {
  const found = (await stripeRefundsOf(paymentIntentId)).find(
    (refund) => refund.metadata?.transfer === key,
  );

  return found ? refundAnswerOf(found) : null;
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
