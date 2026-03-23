import { Prisma } from '@prisma/client';
import { isRetryableTxError } from '@db/client.js';
import stripe from '@config/stripe.js';
import env from '@config/env.js';

import {
  BadRequestError,
  UnauthorizedError,
  ConflictError,
  InternalError,
  isAppError,
  ResourceBusyError,
} from '@utils/errors.js';
import { cancelOrderReservationExpiry } from '@routes/api/orders/services/helpers/index.js';
import { getOrderIdFromCheckoutSession } from './helpers/checkoutSession.helper.js';
import {
  payOrderFromStripeWebhook,
  unconfirmOrderFromStripeWebhook,
} from './helpers/orderPaymentTx.helper.js';

import type Stripe from 'stripe';
import type { HandleStripeWebhookDto, StripeWebhookResponseDto } from 'types/dto/payments.dto.js';

export async function handleStripeWebhook({
  stripeSignature,
  rawBody,
}: HandleStripeWebhookDto): Promise<StripeWebhookResponseDto> {
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
        const payResult = await payOrderFromStripeWebhook(orderId);

        if (payResult.paidNow) {
          await cancelOrderReservationExpiry(orderId);
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
        const unconfirmResult = await unconfirmOrderFromStripeWebhook(orderId);

        if (unconfirmResult.unconfirmedNow) {
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
      const msg = String((err.meta as any)?.message ?? err.message);

      if (msg.includes('ORDER_NOT_FOUND')) {
        throw new InternalError({ reason: 'STRIPE_ORDER_NOT_FOUND' });
      }

      if (msg.includes('ORDER_PAY_FORBIDDEN')) {
        throw new InternalError({ reason: 'STRIPE_ORDER_PAY_FORBIDDEN' });
      }

      if (msg.includes('ORDER_NOT_CONFIRMED')) {
        throw new ConflictError('ORDER_NOT_CONFIRMED');
      }

      if (msg.includes('ORDER_STATUS_NOT_WAITING')) {
        throw new ConflictError('ORDER_STATUS_NOT_WAITING');
      }

      if (msg.includes('ORDER_RESERVATION_MISSING')) {
        throw new ConflictError('ORDER_RESERVATION_MISSING');
      }

      if (msg.includes('ORDER_RESERVATION_EXPIRED')) {
        throw new ConflictError('ORDER_RESERVATION_EXPIRED');
      }

      if (msg.includes('ORDER_ITEMS_REQUIRED')) {
        throw new BadRequestError('ORDER_ITEMS_REQUIRED');
      }
    }

    throw new InternalError({ reason: 'PAYMENTS_HANDLE_STRIPE_WEBHOOK_UNEXPECTED' }, err);
  }
}
