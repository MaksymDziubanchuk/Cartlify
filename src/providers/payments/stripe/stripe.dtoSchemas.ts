// the schemas of the routes of Stripe itself, under /api/payments/stripe; the registry of the
// payment providers hands them to the app with the schemas of every provider

const paymentsGetCheckoutSessionByIdParamsSchema = {
  $id: 'paymentsGetCheckoutSessionByIdParamsSchema',
  type: 'object',
  additionalProperties: false,
  required: ['sessionId'],
  properties: {
    // the id comes from the address the buyer returns to, so from the browser: only the form of a
    // stripe checkout session goes on to stripe
    sessionId: {
      type: 'string',
      pattern: '^cs_(test|live)_[A-Za-z0-9]+$',
      description: 'Id of the Stripe checkout session: `cs_test_…` or `cs_live_…`.',
    },
  },
} as const;

const paymentsStripeWebhookResponseSchema = {
  $id: 'paymentsStripeWebhookResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: ['received'],
  properties: {
    received: { type: 'boolean', const: true },
    // event was acknowledged without any action, with the reason
    skipped: {
      type: 'string',
      enum: [
        'ORDER_NOT_FOUND',
        'ORDER_NOT_CONFIRMED',
        'ORDER_STATUS_NOT_WAITING',
        'ORDER_ITEMS_REQUIRED',
        'NOT_AN_ORDER',
        'OBJECT_INVALID',
        'REFUNDED',
        'UNKNOWN_REFUND',
      ],
      description:
        'Why nothing was done. The event can never pass, so it is acknowledged (an error answer would make Stripe deliver it again for days and turn the endpoint off); all but `REFUNDED` are a warning in the log: `ORDER_NOT_FOUND` the order of the page is deleted; `ORDER_NOT_CONFIRMED`, `ORDER_STATUS_NOT_WAITING`, `ORDER_ITEMS_REQUIRED` the order is not in the state the event needs; `NOT_AN_ORDER` the page is not one the app opened for an order, or the payment of a refund made by hand, a dispute, a warning of fraud or a review is neither the payment of an order nor one an order could not take (another tool in the same Stripe account): its money is left alone; `OBJECT_INVALID` the object of the event is not the kind its type names; `REFUNDED` the payment is one the order could not take (a delivery of its event again), its money goes back or went back and the order never takes it; `UNKNOWN_REFUND` a refund under a key of the app that no refund of the app has.',
    },
  },
} as const;

export const stripeDtoSchemas = [
  paymentsGetCheckoutSessionByIdParamsSchema,
  paymentsStripeWebhookResponseSchema,
];
