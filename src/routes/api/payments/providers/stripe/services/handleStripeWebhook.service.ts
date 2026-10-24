import { Prisma } from '@prisma/client';
import { getPgMessage, isRetryableTxError } from '@db/client.js';
import stripe from '@config/stripe.js';
import env from '@config/env.js';
import { isRedisReady } from '@redis/client.js';

import {
  BadRequestError,
  UnauthorizedError,
  ConflictError,
  InternalError,
  isAppError,
  ResourceBusyError,
} from '@utils/errors.js';
import {
  cancelOrderReservationExpiry,
  deleteOrderPaymentPageLink,
} from '@routes/api/orders/services/helpers/index.js';
import {
  payOrder,
  unconfirmOrderFromWebhook,
} from '@routes/api/payments/services/helpers/orderPaymentTx.helper.js';
import {
  isPaymentRefunded,
  refundLatePayment,
} from '@routes/api/payments/services/helpers/orderPaymentRefund.helper.js';
import { sendOrderPaidEmail } from '@routes/api/payments/services/helpers/sendOrderPaidEmail.helper.js';

import {
  getOrderIdFromCheckoutSession,
  getPaidAmountFromCheckoutSession,
  getPaymentIntentIdFromCheckoutSession,
  getUserIdFromCheckoutSession,
  isOrderCheckoutSession,
} from '../stripeCheckout.helper.js';

import type Stripe from 'stripe';
import type { HandleStripeWebhookDto, StripeWebhookResponseDto } from 'types/dto/payments.dto.js';

type WebhookLogger = {
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
};

// a page of another tool in the same stripe account is acknowledged and left alone, its money too:
// an error answer would make stripe deliver the event again for days and then turn the endpoint off
function skipForeignPage(
  event: Stripe.Event,
  session: Stripe.Checkout.Session,
  log: WebhookLogger,
): StripeWebhookResponseDto {
  log.warn(
    { eventId: event.id, eventType: event.type, sessionId: session.id },
    'stripe event of a page that is not an order was skipped',
  );

  return { received: true, skipped: 'NOT_AN_ORDER' };
}

// nothing waits for a paid order: its reservation timers and the link of its page go. A leftover
// timer is harmless (it touches only a waiting order), so redis, down or dropping the connection
// in the middle, never fails a payment that is recorded: the error answer would make stripe deliver
// the event again, that delivery is a repeated one and the buyer would never get the mail
async function dropPaidOrderTimers(orderId: number, log: WebhookLogger): Promise<void> {
  if (!isRedisReady()) return;

  try {
    await cancelOrderReservationExpiry(orderId);
    await deleteOrderPaymentPageLink(orderId);
  } catch (err) {
    log.warn(
      { orderId, err: { code: (err as { code?: unknown })?.code } },
      'paid order cleanup in redis failed, its timers stay until they run out',
    );
  }
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

    switch (event.type) {
      // handle paid checkout flows
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;

        if (session.object !== 'checkout.session') {
          throw new BadRequestError('STRIPE_EVENT_OBJECT_INVALID');
        }

        if (!isOrderCheckoutSession(session)) return skipForeignPage(event, session, log);

        if (session.payment_status !== 'paid') {
          break;
        }

        const orderId = getOrderIdFromCheckoutSession(session);
        // the payment id of a stripe order is its PaymentIntent
        const paymentId = getPaymentIntentIdFromCheckoutSession(session);
        const paidAmount = getPaidAmountFromCheckoutSession(session);

        // the money of this payment went back already (the order could not take it): a later
        // delivery of the event must not sell the order, also when the stock came back meanwhile
        if (await isPaymentRefunded({ provider: 'stripe', paymentId, orderId })) {
          return { received: true, skipped: 'REFUNDED' };
        }

        // db decides what this payment means for the order
        // a technical failure throws here, so stripe gets an error and delivers the event again
        const payResult = await payOrder({ provider: 'stripe', paymentId, orderId, paidAmount });

        // order is paid now, also when the payment came late and stock was taken without reservation
        if (payResult === 'PAID') {
          await dropPaidOrderTimers(orderId, log);

          // the payment is committed; the mail never fails the webhook, a failure is only logged.
          // A repeated delivery answers ALREADY_PAID_SAME_PAYMENT, so the buyer gets one mail
          await sendOrderPaidEmail(orderId, log);

          break;
        }

        // same payment delivered again, order already holds it; what a failed cleanup of the
        // first delivery left goes now
        if (payResult === 'ALREADY_PAID_SAME_PAYMENT') {
          await dropPaidOrderTimers(orderId, log);
          break;
        }

        // every other answer means the order cannot take this money, so it goes back in full:
        // paid by another payment, cannot be paid, amount differs from order items, out of stock, order is gone
        const refundResult = await refundLatePayment(
          {
            provider: 'stripe',
            paymentId,
            orderId,
            fallbackUserId: getUserIdFromCheckoutSession(session),
            reason: payResult,
            amount: paidAmount,
            currency: session.currency,
          },
          log,
        );

        // audit log needs an existing user as actor, leave a trace when there is nobody to attribute
        if (!refundResult.logged) {
          log.warn(
            {
              orderId,
              provider: 'stripe',
              paymentId,
              refundId: refundResult.refundId,
              reason: payResult,
            },
            'stripe refund has no audit record: order owner is unknown',
          );
        }

        break;
      }

      // handle failed or expired checkout flows
      case 'checkout.session.async_payment_failed':
      case 'checkout.session.expired': {
        const session = event.data.object;

        if (session.object !== 'checkout.session') {
          throw new BadRequestError('STRIPE_EVENT_OBJECT_INVALID');
        }

        if (!isOrderCheckoutSession(session)) return skipForeignPage(event, session, log);

        const orderId = getOrderIdFromCheckoutSession(session);

        // expired session can still have a last-moment payment on its way, so its reservation waits for the grace window
        // failed async payment is final, nothing can arrive after it, so its reservation is released at once
        const unconfirmResult = await unconfirmOrderFromWebhook({
          orderId,
          waitForPaymentGrace: event.type === 'checkout.session.expired',
        });

        // order is already deleted by its owner: acknowledge the event and say why nothing was done
        if (!unconfirmResult.orderFound) {
          return { received: true, skipped: 'ORDER_NOT_FOUND' };
        }

        // a leftover timeout job is harmless, so a redis outage must not fail the webhook;
        // the page is closed and the order released, nothing needs the page link any more
        if (unconfirmResult.unconfirmedNow && isRedisReady()) {
          await cancelOrderReservationExpiry(orderId);
          await deleteOrderPaymentPageLink(orderId);
        }

        break;
      }

      // ignore unsupported stripe events
      default:
        break;
    }

    // acknowledge webhook delivery
    return { received: true };
  } catch (err) {
    if (isAppError(err)) throw err;

    if (isRetryableTxError(err)) {
      throw new ResourceBusyError();
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2010') {
      const msg = String(getPgMessage(err) ?? err.message);

      if (msg.includes('ORDER_NOT_FOUND')) {
        throw new InternalError({ reason: 'STRIPE_ORDER_NOT_FOUND' });
      }

      if (msg.includes('ORDER_PAY_FORBIDDEN')) {
        throw new InternalError({ reason: 'STRIPE_ORDER_PAY_FORBIDDEN' });
      }

      if (msg.includes('ORDER_UNCONFIRM_FORBIDDEN')) {
        throw new InternalError({ reason: 'STRIPE_ORDER_UNCONFIRM_FORBIDDEN' });
      }

      if (msg.includes('ORDER_NOT_CONFIRMED')) {
        throw new ConflictError('ORDER_NOT_CONFIRMED');
      }

      if (msg.includes('ORDER_STATUS_NOT_WAITING')) {
        throw new ConflictError('ORDER_STATUS_NOT_WAITING');
      }

      if (msg.includes('ORDER_ITEMS_REQUIRED')) {
        throw new BadRequestError('ORDER_ITEMS_REQUIRED');
      }
    }

    throw new InternalError({ reason: 'PAYMENTS_HANDLE_STRIPE_WEBHOOK_UNEXPECTED' }, err);
  }
}
