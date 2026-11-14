// What the webhook does with an event of Stripe, by its type. The dashboards of the shop send these
// events (docs/disputes.md lists them); any other is acknowledged and
// left alone, so an event the shop subscribes to by mistake never makes Stripe deliver it again:
// - page_paid: the money of a payment page is taken (a card at once, a bank later)
// - page_closed: a payment page closed without the money, or the bank refused it
// - refund: a refund was made, changed or failed (ours carry the key of the transfer, one made by
//   hand in the dashboard carries none)
// - dispute: a dispute of a payment at the bank, or an inquiry of the bank, opened, changed, took
//   or gave back money, or ended
// - fraud_warning: the network of the card warns that the payment may be a fraud
// - review: Stripe holds a payment for the shop to look at, or let it go
export type StripeEventRoute =
  'page_paid' | 'page_closed' | 'refund' | 'dispute' | 'fraud_warning' | 'review' | 'ignored';

const ROUTES: Record<string, StripeEventRoute> = {
  'checkout.session.completed': 'page_paid',
  'checkout.session.async_payment_succeeded': 'page_paid',
  'checkout.session.async_payment_failed': 'page_closed',
  'checkout.session.expired': 'page_closed',
  'refund.created': 'refund',
  'refund.updated': 'refund',
  'refund.failed': 'refund',
  'charge.dispute.created': 'dispute',
  'charge.dispute.updated': 'dispute',
  'charge.dispute.funds_withdrawn': 'dispute',
  'charge.dispute.funds_reinstated': 'dispute',
  'charge.dispute.closed': 'dispute',
  'radar.early_fraud_warning.created': 'fraud_warning',
  'radar.early_fraud_warning.updated': 'fraud_warning',
  'review.opened': 'review',
  'review.closed': 'review',
};

export const stripeEventRouteOf = (type: string): StripeEventRoute =>
  Object.hasOwn(ROUTES, type) ? ROUTES[type]! : 'ignored';
