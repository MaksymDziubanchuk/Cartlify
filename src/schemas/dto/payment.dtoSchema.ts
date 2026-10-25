import { MAX_ID } from '@schemas/idPathParam.js';
import { PAYMENT_PROVIDER_NAMES } from '@routes/api/payments/providers/names.js';

// none of the providers is the main one, the buyer always names the one to pay with
const paymentProviderField = {
  type: 'string',
  enum: PAYMENT_PROVIDER_NAMES,
  description: `The payment provider: ${PAYMENT_PROVIDER_NAMES.map((name) => `\`${name}\``).join(', ')}.`,
} as const;

const paymentsCreateCheckoutSessionBodySchema = {
  $id: 'paymentsCreateCheckoutSessionBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['orderId', 'provider'],
  properties: {
    // a bigger id than the largest int of the database is no order, not a database error
    orderId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: `Id of the order: a whole number from 1 to ${MAX_ID}.`,
    },
    provider: paymentProviderField,
  },
} as const;

const paymentsCheckoutSessionPublicSchema = {
  $id: 'paymentsCheckoutSessionPublicSchema',
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'sessionId', 'url', 'mode', 'status', 'paymentStatus', 'expiresAt'],
  properties: {
    provider: paymentProviderField,
    sessionId: {
      type: 'string',
      minLength: 1,
      description: 'Id of the payment page at the provider.',
    },
    url: {
      anyOf: [{ type: 'string', format: 'uri' }, { type: 'null' }],
    },
    mode: {
      type: 'string',
      enum: ['payment'],
    },
    status: {
      type: 'string',
      enum: ['open', 'complete', 'expired'],
    },
    paymentStatus: {
      type: 'string',
      enum: ['paid', 'unpaid', 'no_payment_required'],
    },
    expiresAt: {
      type: 'string',
      format: 'date-time',
      description:
        'Time after which this checkout can no longer be paid: order reservation end or the expiry of the page at the provider, whichever comes first.',
    },
  },
} as const;

const paymentsCheckoutSessionResponseSchema = {
  $id: 'paymentsCheckoutSessionResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: ['checkoutSession'],
  properties: {
    checkoutSession: { $ref: 'paymentsCheckoutSessionPublicSchema#' },
  },
} as const;

// the page of a payment the buyer comes back to, with the order it is for
const paymentsCheckoutSessionReadResponseSchema = {
  $id: 'paymentsCheckoutSessionReadResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: ['checkoutSession', 'order'],
  properties: {
    checkoutSession: { $ref: 'paymentsCheckoutSessionPublicSchema#' },
    order: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'status', 'paymentRefunded'],
      description:
        'The order of the page: the provider may call the page paid while the order could not take the money (the reservation was over and the stock gone, another payment paid it) and it went back.',
      properties: {
        id: { type: 'integer' },
        status: {
          type: 'string',
          enum: ['pending', 'unconfirmed', 'waiting', 'paid', 'shipped', 'delivered', 'cancelled'],
        },
        paymentRefunded: {
          type: 'boolean',
          description:
            'The money of the payment of this page went back: the page tells the buyer so, the order does not hold the payment.',
        },
      },
    },
  },
} as const;

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
      enum: ['ORDER_NOT_FOUND', 'NOT_AN_ORDER', 'REFUNDED'],
      description:
        'Why nothing was done: `ORDER_NOT_FOUND` the order of the page is deleted, `NOT_AN_ORDER` the page is not one the app opened for an order (another tool in the same Stripe account), its money is left alone, `REFUNDED` the money of this payment went back already, the order does not take it.',
    },
  },
} as const;

export const paymentDtoSchemas = [
  paymentsCreateCheckoutSessionBodySchema,
  paymentsCheckoutSessionPublicSchema,
  paymentsCheckoutSessionResponseSchema,
  paymentsCheckoutSessionReadResponseSchema,
  paymentsGetCheckoutSessionByIdParamsSchema,
  paymentsStripeWebhookResponseSchema,
];
