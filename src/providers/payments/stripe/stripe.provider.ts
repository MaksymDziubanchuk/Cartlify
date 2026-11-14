import stripe from './stripeClient.js';
import { stripeDtoSchemas } from './stripe.dtoSchemas.js';
import { ServiceUnavailableError } from '@utils/errors.js';

import {
  buildCheckoutIdempotencyKey,
  buildCheckoutSessionPayload,
  expireCheckoutSession,
  isStripeIdempotencyConflict,
  isStripeUnavailable,
  mapCreatedCheckoutSession,
  readCheckoutSessionStatus,
  readStripePaidPage,
} from './stripeCheckout.helper.js';
import { getStripeDispute, putStripeDisputeEvidence } from './stripeDispute.helper.js';
import {
  findStripeRefund,
  getStripeRefund,
  listStripeRefunds,
  refundStripePayment,
} from './stripeRefund.helper.js';
import { PaymentPageChangedError } from '../types.js';

import type Stripe from 'stripe';
import type { PaymentPageCloseResult, PaymentProvider } from '../types.js';

// the smallest total stripe takes: it refuses a card payment below 0.50 in EUR and USD (another
// currency of the shop may have another minimum)
const STRIPE_MINIMUM_TOTAL = 0.5;

// where stripe delivers its events: the stripe router is registered under /api/payments/stripe
export const STRIPE_WEBHOOK_PATH = '/api/payments/stripe/webhook';

export const stripeProvider: PaymentProvider = {
  name: 'stripe',
  label: 'Stripe',
  minimumTotal: STRIPE_MINIMUM_TOTAL,
  // stripe closes a checkout session no sooner than 30 minutes after it was opened and keeps it
  // no longer than a day
  pageMinutes: { least: 30, mostWithReservation: 24 * 60 },
  callbackPaths: [STRIPE_WEBHOOK_PATH],
  routes: () => import('./stripe.routes.js'),
  schemas: stripeDtoSchemas,
  examples: {
    pageId: 'cs_test_123456789',
    pageUrl: 'https://checkout.stripe.com/c/pay/cs_test_123456789',
    paymentId: 'pi_3QxYzAbCdEfGhIjK',
    refundId: 're_3QxYzAbCdEfGhIjK',
    refundFailureText: 'expired_or_canceled_card',
    disputeId: 'du_1QxYzAbCdEfGhIjKlMnOpQrS',
    balanceTxId: 'txn_1QxYzAbCdEfGhIjKlMnOpQr',
  },

  async openPaymentPage({
    orderId,
    userId,
    total,
    reservationExpiresAt,
    pageClosedAt,
    items,
    deliveryPrice,
    shipping,
    customerEmail,
    locale,
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
          deliveryPrice,
          shipping,
          customerEmail,
          locale,
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

      // the key of this reservation opened a page with other values (the language of the buyer,
      // the name of the shop, the minutes of the page): that page is the one to close
      if (isStripeIdempotencyConflict(err)) throw new PaymentPageChangedError(err);

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

  refundPayment({ orderId, paymentId, amount, key }) {
    // the payment id of a stripe order is its PaymentIntent
    return refundStripePayment({ orderId, paymentIntentId: paymentId, amount, key });
  },

  getRefund(refundId) {
    return getStripeRefund(refundId);
  },

  findRefund({ paymentId, key }) {
    return findStripeRefund({ paymentIntentId: paymentId, key });
  },

  listRefunds(paymentId) {
    return listStripeRefunds(paymentId);
  },

  getDispute(disputeId) {
    return getStripeDispute(disputeId);
  },

  putDisputeEvidence(disputeId, evidence) {
    return putStripeDisputeEvidence(disputeId, evidence);
  },

  // the page of a stripe order is its checkout session
  readPaidPage(sessionId) {
    return readStripePaidPage(sessionId);
  },
};
