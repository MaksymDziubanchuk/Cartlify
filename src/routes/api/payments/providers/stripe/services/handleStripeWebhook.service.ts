import { Prisma } from '@prisma/client';
import { getPgMessage, isRetryableTxError } from '@db/client.js';
import stripe from '@config/stripe.js';
import env from '@config/env.js';
import { isRedisReady } from '@redis/client.js';

import { InternalError, isAppError, ResourceBusyError, UnauthorizedError } from '@utils/errors.js';
import {
  cancelOrderReservationExpiry,
  deleteOrderPaymentPageLink,
} from '@routes/api/orders/services/helpers/orderTimeoutQueue.helper.js';
import { unconfirmOrderFromWebhook } from '@routes/api/payments/services/helpers/orderPaymentTx.helper.js';
import { settlePaidPage } from '@routes/api/payments/services/helpers/settlePaidPage.helper.js';
import { followDispute } from '@routes/api/payments/services/followDisputes.service.js';
import {
  followFraudWarning,
  followPaymentReview,
} from '@routes/api/payments/services/paymentChecks.service.js';
import { settleStripeRefundEvent } from '../stripeRefundEvent.helper.js';
import { stripeEventRouteOf } from '../stripeWebhookRoute.helper.js';

import { getOrderIdFromCheckoutSession, paymentPageReadingOf } from '../stripeCheckout.helper.js';

import type Stripe from 'stripe';
import type {
  HandleStripeWebhookDto,
  StripeWebhookResponseDto,
  StripeWebhookSkip,
} from 'types/dto/payments.dto.js';

type WebhookLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// The answers of the webhook: an error only for what
// passes by itself (the signature, the database busy or down) and for a fault of the code, which
// Stripe delivers again for three days while it is mended. An event that can never pass (an object
// it does not know, a page or a payment of another tool, an order that is not in the state the
// event needs) is acknowledged with the reason in skipped and a warning in the log: an error answer
// would make Stripe deliver it again for days and then turn the endpoint off. What the app asks of Stripe again is the worker's, never a repeated event

// the refusals of the functions of the database that the same event meets again every time: the
// order of the page is not in the state the event needs
const ORDER_STATE_SKIPS = [
  'ORDER_NOT_CONFIRMED',
  'ORDER_STATUS_NOT_WAITING',
  'ORDER_ITEMS_REQUIRED',
  'ORDER_NOT_FOUND',
] as const;

function skip(
  event: Stripe.Event,
  skipped: StripeWebhookSkip,
  log: WebhookLogger,
  more: Record<string, unknown> = {},
): StripeWebhookResponseDto {
  log.warn(
    { eventId: event.id, eventType: event.type, skipped, ...more },
    'stripe event was skipped',
  );
  return { received: true, skipped };
}

// the order of the page is not in the state the event needs, as the database said: the reason, none
// for any other error
function orderStateSkipOf(err: unknown): StripeWebhookSkip | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2010') return null;

  const msg = String(getPgMessage(err) ?? err.message);
  return ORDER_STATE_SKIPS.find((code) => msg.includes(code)) ?? null;
}

// the money of a page is taken: the step the reservation timer takes too (settlePaidPage)
async function pagePaid(
  event: Stripe.Event,
  log: WebhookLogger,
): Promise<StripeWebhookResponseDto> {
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.object !== 'checkout.session') return skip(event, 'OBJECT_INVALID', log);

  const page = paymentPageReadingOf(session);
  if (page.state === 'foreign') {
    return skip(event, 'NOT_AN_ORDER', log, { sessionId: session.id });
  }

  // a page whose money a bank still decides: its own event comes when it is taken
  if (page.state === 'unpaid') return { received: true };

  const settled = await settlePaidPage('stripe', page, log);
  return settled.skipped ? { received: true, skipped: settled.skipped } : { received: true };
}

// a page closed without the money, or the bank refused it
async function pageClosed(
  event: Stripe.Event,
  log: WebhookLogger,
): Promise<StripeWebhookResponseDto> {
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.object !== 'checkout.session') return skip(event, 'OBJECT_INVALID', log);

  const page = paymentPageReadingOf(session);
  if (page.state === 'foreign') {
    return skip(event, 'NOT_AN_ORDER', log, { sessionId: session.id });
  }

  const orderId = getOrderIdFromCheckoutSession(session);

  // an expired page can still have a last-moment payment on its way, so its reservation waits for
  // the grace window; a failed bank payment is final, its reservation is released at once
  let unconfirmed: Awaited<ReturnType<typeof unconfirmOrderFromWebhook>>;
  try {
    unconfirmed = await unconfirmOrderFromWebhook({
      orderId,
      waitForPaymentGrace: event.type === 'checkout.session.expired',
    });
  } catch (err) {
    const reason = orderStateSkipOf(err);
    if (reason) return skip(event, reason, log, { orderId });
    throw err;
  }

  // the order is deleted by its owner: nothing to release
  if (!unconfirmed.orderFound) return skip(event, 'ORDER_NOT_FOUND', log, { orderId });

  // a leftover timeout job is harmless, so a redis outage must not fail the webhook; the page is
  // closed and the order released, nothing needs the page link any more
  if (unconfirmed.unconfirmedNow && isRedisReady()) {
    await cancelOrderReservationExpiry(orderId);
    await deleteOrderPaymentPageLink(orderId);
  }

  return { received: true };
}

// a refund was made, changed or ended
async function refundChanged(
  event: Stripe.Event,
  log: WebhookLogger,
): Promise<StripeWebhookResponseDto> {
  const refund = event.data.object as Stripe.Refund;
  if (refund.object !== 'refund') return skip(event, 'OBJECT_INVALID', log);

  // a refund that waits for something the buyer has to do (never for a card): it stays on its way,
  // a person may look at it
  if (refund.status === 'requires_action') {
    log.warn(
      { eventId: event.id, eventType: event.type, refundId: refund.id },
      'a refund waits for an action of the buyer',
    );
  }

  const settled = await settleStripeRefundEvent(refund, log);
  return settled.skipped
    ? skip(event, settled.skipped, log, { refundId: refund.id })
    : { received: true };
}

// a dispute of a payment at the bank, or an inquiry of the bank, changed: it is read from Stripe and
// followed (followDispute), whatever the event and the order they come in
async function disputeChanged(
  event: Stripe.Event,
  log: WebhookLogger,
): Promise<StripeWebhookResponseDto> {
  const dispute = event.data.object as Stripe.Dispute;
  if (dispute.object !== 'dispute') return skip(event, 'OBJECT_INVALID', log);

  const followed = await followDispute('stripe', dispute.id, log);
  return followed.skipped
    ? skip(event, followed.skipped, log, { disputeId: dispute.id })
    : { received: true };
}

// the id of a payment as an object of Stripe names it: the id, or the expanded object
const paymentIdOf = (payment: string | { id: string } | null | undefined): string | null =>
  typeof payment === 'string' ? payment : (payment?.id ?? null);

// the network of the card warns the payment may be a fraud
async function fraudWarned(
  event: Stripe.Event,
  log: WebhookLogger,
): Promise<StripeWebhookResponseDto> {
  const warning = event.data.object as Stripe.Radar.EarlyFraudWarning;
  if (warning.object !== 'radar.early_fraud_warning') return skip(event, 'OBJECT_INVALID', log);

  const paymentId = paymentIdOf(warning.payment_intent);
  if (!paymentId) return skip(event, 'NOT_AN_ORDER', log, { warningId: warning.id });

  const followed = await followFraudWarning(
    { id: warning.id, paymentId, actionable: warning.actionable },
    log,
  );
  return followed.skipped
    ? skip(event, followed.skipped, log, { warningId: warning.id, paymentId })
    : { received: true };
}

// Stripe holds a payment for the shop to look at, or lets it go
async function reviewChanged(
  event: Stripe.Event,
  log: WebhookLogger,
): Promise<StripeWebhookResponseDto> {
  const review = event.data.object as Stripe.Review;
  if (review.object !== 'review') return skip(event, 'OBJECT_INVALID', log);

  const paymentId = paymentIdOf(review.payment_intent);
  if (!paymentId) return skip(event, 'NOT_AN_ORDER', log, { reviewId: review.id });

  const followed = await followPaymentReview(
    { id: review.id, paymentId, open: event.type === 'review.opened' },
    log,
  );
  return followed.skipped
    ? skip(event, followed.skipped, log, { reviewId: review.id, paymentId })
    : { received: true };
}

export async function handleStripeWebhook(
  { stripeSignature, rawBody }: HandleStripeWebhookDto,
  log: WebhookLogger,
): Promise<StripeWebhookResponseDto> {
  // require webhook secret config
  if (!env.STRIPE_WEBHOOK_SECRET) {
    throw new InternalError({
      reason: 'STRIPE_WEBHOOK_SECRET_MISSING',
    });
  }

  try {
    let event: Stripe.Event;

    // verify stripe signature
    try {
      event = stripe.webhooks.constructEvent(rawBody, stripeSignature, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      throw new UnauthorizedError('STRIPE_SIGNATURE_INVALID', { cause: err });
    }

    switch (stripeEventRouteOf(event.type)) {
      case 'page_paid':
        return await pagePaid(event, log);
      case 'page_closed':
        return await pageClosed(event, log);
      case 'refund':
        return await refundChanged(event, log);
      case 'dispute':
        return await disputeChanged(event, log);
      case 'fraud_warning':
        return await fraudWarned(event, log);
      case 'review':
        return await reviewChanged(event, log);
      // an event the dashboards should not send: acknowledged, nothing to do
      case 'ignored':
        return { received: true };
    }
  } catch (err) {
    if (isAppError(err)) throw err;

    // the database busy or a transaction out of its time passes by itself: Stripe delivers again
    if (isRetryableTxError(err)) {
      throw new ResourceBusyError();
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
      const msg = String(getPgMessage(err) ?? err.message);

      if (msg.includes('ORDER_PAY_FORBIDDEN')) {
        throw new InternalError({ reason: 'STRIPE_ORDER_PAY_FORBIDDEN' });
      }

      if (msg.includes('ORDER_UNCONFIRM_FORBIDDEN')) {
        throw new InternalError({ reason: 'STRIPE_ORDER_UNCONFIRM_FORBIDDEN' });
      }
    }

    throw new InternalError({ reason: 'PAYMENTS_HANDLE_STRIPE_WEBHOOK_UNEXPECTED' }, err);
  }
}
