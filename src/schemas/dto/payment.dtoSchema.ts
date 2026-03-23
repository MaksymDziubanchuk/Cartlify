const paymentsCreateCheckoutSessionBodySchema = {
  $id: 'paymentsCreateCheckoutSessionBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['orderId'],
  properties: {
    orderId: { type: 'integer', minimum: 1 },
  },
} as const;

const paymentsCheckoutSessionPublicSchema = {
  $id: 'paymentsCheckoutSessionPublicSchema',
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'url', 'mode', 'status', 'paymentStatus', 'expiresAt'],
  properties: {
    sessionId: { type: 'string', minLength: 1 },
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
    expiresAt: { type: 'string', format: 'date-time' },
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

const paymentsGetCheckoutSessionByIdParamsSchema = {
  $id: 'paymentsGetCheckoutSessionByIdParamsSchema',
  type: 'object',
  additionalProperties: false,
  required: ['sessionId'],
  properties: {
    sessionId: { type: 'string', minLength: 1 },
  },
} as const;

const paymentsStripeWebhookHeadersSchema = {
  $id: 'paymentsStripeWebhookHeadersSchema',
  type: 'object',
  additionalProperties: true,
  required: ['stripe-signature'],
  properties: {
    'stripe-signature': { type: 'string', minLength: 1 },
  },
} as const;

const paymentsStripeWebhookResponseSchema = {
  $id: 'paymentsStripeWebhookResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: ['received'],
  properties: {
    received: { type: 'boolean', const: true },
  },
} as const;

export const paymentDtoSchemas = [
  paymentsCreateCheckoutSessionBodySchema,
  paymentsCheckoutSessionPublicSchema,
  paymentsCheckoutSessionResponseSchema,
  paymentsGetCheckoutSessionByIdParamsSchema,
  paymentsStripeWebhookHeadersSchema,
  paymentsStripeWebhookResponseSchema,
];
