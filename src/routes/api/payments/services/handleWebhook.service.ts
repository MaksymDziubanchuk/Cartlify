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
import { cancelOrderReservationExpiry } from '@routes/api/orders/services/helpers/index.js';
import {
  getOrderIdFromCheckoutSession,
  getPaidAmountFromCheckoutSession,
  getPaymentIntentIdFromCheckoutSession,
  getUserIdFromCheckoutSession,
} from './helpers/checkoutSession.helper.js';
import {
  payOrderFromStripeWebhook,
  unconfirmOrderFromStripeWebhook,
} from './helpers/orderPaymentTx.helper.js';
import { refundOrderPaymentFromStripeWebhook } from './helpers/orderPaymentRefund.helper.js';

import type Stripe from 'stripe';
import type { HandleStripeWebhookDto, StripeWebhookResponseDto } from 'types/dto/payments.dto.js';

type WebhookLogger = {
  warn: (obj: unknown, msg?: string) => void;
};

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

        if (session.payment_status !== 'paid') {
          break;
        }

        const orderId = getOrderIdFromCheckoutSession(session);
        const paymentIntentId = getPaymentIntentIdFromCheckoutSession(session);
        const paidAmount = getPaidAmountFromCheckoutSession(session);

        // db decides what this payment means for the order
        // a technical failure throws here, so stripe gets an error and delivers the event again
        const payResult = await payOrderFromStripeWebhook({ orderId, paymentIntentId, paidAmount });

        // order is paid now, also when the payment came late and stock was taken without reservation
        if (payResult === 'PAID') {
          // a leftover timeout job is harmless, so a redis outage must not fail a recorded payment
          if (isRedisReady()) {
            await cancelOrderReservationExpiry(orderId);
          }

          break;
        }

        // same payment delivered again, order already holds it
        if (payResult === 'ALREADY_PAID_SAME_PAYMENT') {
          break;
        }

        // every other answer means the order cannot take this money, so it goes back in full:
        // paid by another payment, cannot be paid, amount differs from order items, out of stock, order is gone
        const refundResult = await refundOrderPaymentFromStripeWebhook({
          orderId,
          fallbackUserId: getUserIdFromCheckoutSession(session),
          paymentIntentId,
          reason: payResult,
          amount: paidAmount,
          currency: session.currency,
        });

        // audit log needs an existing user as actor, leave a trace when there is nobody to attribute
        if (!refundResult.logged) {
          log.warn(
            { orderId, paymentIntentId, refundId: refundResult.refundId, reason: payResult },
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

        const orderId = getOrderIdFromCheckoutSession(session);

        // expired session can still have a last-moment payment on its way, so its reservation waits for the grace window
        // failed async payment is final, nothing can arrive after it, so its reservation is released at once
        const unconfirmResult = await unconfirmOrderFromStripeWebhook({
          orderId,
          waitForPaymentGrace: event.type === 'checkout.session.expired',
        });

        // order is already deleted by its owner: acknowledge the event and say why nothing was done
        if (!unconfirmResult.orderFound) {
          return { received: true, skipped: 'ORDER_NOT_FOUND' };
        }

        // a leftover timeout job is harmless, so a redis outage must not fail the webhook
        if (unconfirmResult.unconfirmedNow && isRedisReady()) {
          await cancelOrderReservationExpiry(orderId);
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
      throw new ResourceBusyError('RESOURCE_BUSY_TRY_AGAIN');
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
