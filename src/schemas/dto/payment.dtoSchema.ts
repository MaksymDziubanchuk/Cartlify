const createCheckoutSessionBodyDtoSchema = {
  $id: 'createCheckoutSessionBodyDtoSchema',
  type: 'object',
  additionalProperties: false,
  required: ['orderId'],
  properties: {
    orderId: { type: 'integer', minimum: 1 },
  },
} as const;

const checkoutSessionPublicDtoSchema = {
  $id: 'checkoutSessionPublicDtoSchema',
  type: 'object',
  additionalProperties: false,
  required: ['sessionId', 'url', 'mode', 'status', 'paymentStatus', 'expiresAt'],
  properties: {
    sessionId: { type: 'string', minLength: 1 },
    url: { type: 'string', format: 'uri' },
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

const createCheckoutSessionReplyDtoSchema = {
  $id: 'createCheckoutSessionReplyDtoSchema',
  type: 'object',
  additionalProperties: false,
  required: ['checkoutSession'],
  properties: {
    checkoutSession: { $ref: 'checkoutSessionPublicDtoSchema#' },
  },
} as const;

export const paymentDtoSchemas = [
  createCheckoutSessionBodyDtoSchema,
  checkoutSessionPublicDtoSchema,
  createCheckoutSessionReplyDtoSchema,
];
