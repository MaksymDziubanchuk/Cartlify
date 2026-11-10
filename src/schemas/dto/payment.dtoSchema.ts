import { MAX_ID } from '@schemas/idPathParam.js';
import {
  RETURN_NOTE_MAX,
  RETURN_OUTSIDE_PAYMENT_METHODS,
  RETURN_REFUND_FAILURES,
} from '@helpers/returns.js';
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

const dateTime = { type: 'string', format: 'date-time' } as const;

const refundFailureField = {
  type: ['string', 'null'],
  enum: [...RETURN_REFUND_FAILURES, null],
  description:
    'Why the money did not reach the buyer, in our words: card_unavailable (the card can no ' +
    'longer take money), shop_balance (the balance of the shop at the provider), disputed (the ' +
    'buyer disputed the payment at the bank), unknown. null when the row is not about a failure.',
} as const;

const paymentsRefundsQuerySchema = {
  $id: 'paymentsRefundsQuerySchema',
  type: 'object',
  additionalProperties: false,
  required: ['state'],
  properties: {
    state: {
      type: 'string',
      enum: ['failed', 'unsent'],
      description:
        'failed: money that did not reach the buyer and that the shop sends another way: the ' +
        'transfers of the open statements of return whose last try failed, and the refunds of ' +
        'late payments that failed and root has not marked sent another way. unsent: the refunds ' +
        'of late payments that the provider has not told sent or failed.',
    },
    userId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'Only the refunds of this buyer.',
    },
    orderId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'Only the refunds of this order.',
    },
    to: {
      ...dateTime,
      description:
        'Only the refunds that came to their state before this time (the transfer failed, the ' +
        'refund was made).',
    },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: '20 by default.' },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'nextCursor of the page before (CURSOR_INVALID).',
    },
  },
} as const;

const paymentsRefundItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'source',
    'orderId',
    'userId',
    'returnId',
    'provider',
    'paymentId',
    'refundId',
    'amount',
    'currency',
    'failure',
    'failureText',
    'at',
  ],
  properties: {
    id: {
      type: 'string',
      description:
        'The id of the case, the one an alert puts aside: the id of the statement for a return, ' +
        'the id of the refund at the provider for a payment.',
    },
    source: {
      type: 'string',
      enum: ['return', 'payment'],
      description:
        'return: the transfer of the money of a statement of return; payment: the refund of a ' +
        'payment the order could not take.',
    },
    orderId: { type: 'integer' },
    userId: { type: 'integer', description: 'The buyer.' },
    returnId: { type: ['integer', 'null'], description: 'The statement, for a return.' },
    provider: {
      type: ['string', 'null'],
      description: 'The provider of the payment, for a payment.',
    },
    paymentId: {
      type: ['string', 'null'],
      description: 'The payment at the provider, for a payment.',
    },
    refundId: {
      type: ['string', 'null'],
      description: 'The refund at the provider, for a payment: the id root names to mark it.',
    },
    amount: {
      type: ['number', 'null'],
      description:
        'The money: all of the payment, or for a statement the sum of the rows whose transfer ' +
        'failed.',
    },
    currency: { type: ['string', 'null'], description: 'The currency of the money.' },
    failure: refundFailureField,
    failureText: {
      type: ['string', 'null'],
      description: 'The words of the provider for the failure, for the shop.',
    },
    at: {
      ...dateTime,
      description: 'When it came to its state: the transfer failed, or the refund was made.',
    },
  },
} as const;

const paymentsRefundsResponseSchema = {
  $id: 'paymentsRefundsResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'total', 'limit', 'nextCursor'],
  properties: {
    items: { type: 'array', items: paymentsRefundItemSchema },
    total: { type: 'integer', minimum: 0, description: 'Of the filter, not only of the page.' },
    limit: { type: 'integer' },
    nextCursor: { type: ['string', 'null'], description: 'null on the last page.' },
  },
} as const;

const paymentsRefundOutsideParamsSchema = {
  $id: 'paymentsRefundOutsideParamsSchema',
  type: 'object',
  additionalProperties: false,
  required: ['refundId'],
  properties: {
    refundId: {
      type: 'string',
      pattern: '^[A-Za-z0-9_]{1,255}$',
      description: 'The id of the refund at the provider (`refundId` of the list of the refunds).',
    },
  },
} as const;

const paymentsRefundOutsideBodySchema = {
  $id: 'paymentsRefundOutsideBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['method', 'note', 'at'],
  properties: {
    method: {
      type: 'string',
      enum: [...RETURN_OUTSIDE_PAYMENT_METHODS],
      description: 'How the money went: a bank transfer, cash or another way.',
    },
    note: {
      type: 'string',
      minLength: 1,
      maxLength: RETURN_NOTE_MAX,
      description: 'How the money was sent: for the shop, not mailed to the buyer.',
    },
    at: {
      ...dateTime,
      description:
        'The day the money really went: never of the future and never before the refund was made.',
    },
  },
} as const;

const paymentsRefundOutsideResponseSchema = {
  $id: 'paymentsRefundOutsideResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: [
    'refundId',
    'orderId',
    'userId',
    'provider',
    'paymentId',
    'amount',
    'currency',
    'state',
    'failure',
    'failureText',
    'outside',
  ],
  properties: {
    refundId: { type: 'string' },
    orderId: { type: 'integer' },
    userId: { type: 'integer', description: 'The buyer.' },
    provider: { type: 'string', description: 'The provider of the payment.' },
    paymentId: { type: 'string', description: 'The payment at the provider.' },
    amount: { type: 'number', description: 'All of the payment.' },
    currency: { type: ['string', 'null'], description: 'The currency of the payment.' },
    state: { type: 'string', const: 'outside', description: 'The state the refund has now.' },
    failure: refundFailureField,
    failureText: {
      type: ['string', 'null'],
      description: 'The words of the provider for the failure, for the shop.',
    },
    outside: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'note', 'at', 'by'],
      properties: {
        method: { type: 'string', enum: [...RETURN_OUTSIDE_PAYMENT_METHODS] },
        note: { type: 'string' },
        at: { ...dateTime, description: 'The day the money went.' },
        by: { type: 'integer', description: 'Root who recorded it.' },
      },
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
  paymentsRefundsQuerySchema,
  paymentsRefundsResponseSchema,
  paymentsRefundOutsideParamsSchema,
  paymentsRefundOutsideBodySchema,
  paymentsRefundOutsideResponseSchema,
];
