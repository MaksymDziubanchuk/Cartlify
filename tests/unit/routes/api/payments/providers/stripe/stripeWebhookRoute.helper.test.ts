import { describe, expect, it } from '@jest/globals';

import { stripeEventRouteOf } from '@routes/api/payments/providers/stripe/stripeWebhookRoute.helper.js';

// what the webhook does with an event of Stripe, by its type: the events the dashboards of the shop
// send (notes: the settings of Stripe before the work) each go to their service; any other event is
// acknowledged and left alone

describe('stripeEventRouteOf', () => {
  it.each([
    ['checkout.session.completed', 'page_paid'],
    ['checkout.session.async_payment_succeeded', 'page_paid'],
    ['checkout.session.async_payment_failed', 'page_closed'],
    ['checkout.session.expired', 'page_closed'],
    ['refund.created', 'refund'],
    ['refund.updated', 'refund'],
    ['refund.failed', 'refund'],
    ['charge.dispute.created', 'dispute'],
    ['charge.dispute.updated', 'dispute'],
    ['charge.dispute.funds_withdrawn', 'dispute'],
    ['charge.dispute.funds_reinstated', 'dispute'],
    ['charge.dispute.closed', 'dispute'],
    ['radar.early_fraud_warning.created', 'fraud_warning'],
    ['radar.early_fraud_warning.updated', 'fraud_warning'],
    ['review.opened', 'review'],
    ['review.closed', 'review'],
  ])('sends %s to %s', (type, route) => {
    expect(stripeEventRouteOf(type)).toBe(route);
  });

  // the shop does not subscribe to these: the same as refund.created told less fully, the payment
  // itself, the payouts of the shop (only the dashboard of Stripe can mend a payout)
  it.each([
    'charge.refunded',
    'payment_intent.succeeded',
    'payout.failed',
    'customer.created',
    'checkout.session',
    '',
  ])('leaves %p alone', (type) => {
    expect(stripeEventRouteOf(type)).toBe('ignored');
  });
});
