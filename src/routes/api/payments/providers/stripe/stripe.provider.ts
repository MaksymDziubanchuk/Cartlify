import env from '@config/env.js';
import stripe from '@config/stripe.js';
import { ServiceUnavailableError } from '@utils/errors.js';

import {
  buildCheckoutIdempotencyKey,
  buildCheckoutSessionPayload,
  expireCheckoutSession,
  isStripeUnavailable,
  mapCreatedCheckoutSession,
  readCheckoutSessionStatus,
} from './stripeCheckout.helper.js';
import { refundStripePayment } from './stripeRefund.helper.js';

import type Stripe from 'stripe';
import type { PaymentPageCloseResult, PaymentProvider } from '../types.js';

// the smallest total stripe takes: it refuses a card payment below 0.50 in EUR and USD (another
// STRIPE_CURRENCY may have another minimum)
export const STRIPE_MINIMUM_TOTAL = 0.5;

// where stripe delivers its events: the stripe router is registered under /api/payments/stripe
export const STRIPE_WEBHOOK_PATH = '/api/payments/stripe/webhook';

export const stripeProvider: PaymentProvider = {
  name: 'stripe',
  label: 'Stripe',
  // env.ts reads it in lower case and lets only a currency with cents through
  currency: env.STRIPE_CURRENCY,
  minimumTotal: STRIPE_MINIMUM_TOTAL,
  callbackPath: STRIPE_WEBHOOK_PATH,

  async openPaymentPage({
    orderId,
    userId,
    total,
    reservationExpiresAt,
    pageClosedAt,
    items,
    customerEmail,
  }) {
    // a repeated request for the same order and reservation gets the same session, not a second payment
    let session: Stripe.Checkout.Session;

    try {
      session = await stripe.checkout.sessions.create(
        buildCheckoutSessionPayload({
          orderId,
          userId,
          total,
          reservationExpiresAt,
          items,
          customerEmail,
        }),
        {
          idempotencyKey: buildCheckoutIdempotencyKey(orderId, reservationExpiresAt, pageClosedAt),
        },
      );
    } catch (err) {
      // nothing is opened, the page asks the buyer to try again a bit later
      if (isStripeUnavailable(err)) {
        throw new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE', undefined, err);
      }

      throw err;
    }

    const { checkoutSession } = mapCreatedCheckoutSession(session, orderId, reservationExpiresAt);

    return { pageId: session.id, checkoutSession };
  },

  // once stripe says the session is closed, no payment can come for it. A session stripe already
  // took the money on cannot be closed, the webhook marks the order paid then
  async closePaymentPage(sessionId): Promise<PaymentPageCloseResult> {
    try {
      await expireCheckoutSession({ sessionId });
      return { state: 'closed' };
    } catch (expireErr) {
      let status: 'open' | 'complete' | 'expired';
      let paid: boolean;

      try {
        ({ status, paid } = await readCheckoutSessionStatus(sessionId));
      } catch (readErr) {
        throw new ServiceUnavailableError('PAYMENT_PROVIDER_UNAVAILABLE', undefined, readErr);
      }

      // closed already, by stripe or by the reservation timer
      if (status === 'expired') return { state: 'closed' };

      // the money is taken
      if (status === 'complete' && paid) return { state: 'paid' };

      // a delayed payment method is still deciding
      if (status === 'complete') return { state: 'in_progress' };

      // the session is open and stripe did not close it
      return { state: 'open', cause: expireErr };
    }
  },

  refundPayment({ orderId, paymentId }) {
    // the payment id of a stripe order is its PaymentIntent
    return refundStripePayment({ orderId, paymentIntentId: paymentId });
  },
};
