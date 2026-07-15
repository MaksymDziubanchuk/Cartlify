import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const checkoutSessionBodyExample = {
  orderId: 1,
};

const checkoutSessionParamsExample = {
  sessionId: 'cs_test_123456789',
};

const checkoutSessionResponseExample = {
  checkoutSession: {
    sessionId: 'cs_test_123456789',
    url: 'https://checkout.stripe.com/c/pay/cs_test_123456789',
    mode: 'payment',
    status: 'open',
    paymentStatus: 'unpaid',
    expiresAt: '2026-01-01T10:30:00.000Z',
  },
};

const stripeWebhookHeadersExample = {
  'stripe-signature': 't=1700000000,v1=example_signature',
};

const stripeWebhookResponseExample = {
  received: true,
};

// Schema for user checkout session creation
const postCheckoutSessionSchema = {
  operationId: 'createCheckoutSession',
  summary: 'Create checkout session',
  description: 'Creates a Stripe checkout session for a confirmed user order.',

  body: {
    $ref: 'paymentsCreateCheckoutSessionBodySchema#',
    examples: [checkoutSessionBodyExample],
  },

  response: {
    201: {
      description: 'Checkout session was created successfully.',
      $ref: 'paymentsCheckoutSessionResponseSchema#',
      examples: [checkoutSessionResponseExample],
    },

    400: {
      description: 'Invalid checkout session request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to create a checkout session.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to create this checkout session.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Order required for checkout was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Order state does not allow checkout session creation.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Checkout session payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while creating checkout session.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for user checkout session lookup
const getCheckoutSessionByIdSchema = {
  operationId: 'getCheckoutSessionById',
  summary: 'Get checkout session by id',
  description: 'Returns a Stripe checkout session by session id for the authenticated user.',

  params: {
    $ref: 'paymentsGetCheckoutSessionByIdParamsSchema#',
    examples: [checkoutSessionParamsExample],
  },

  response: {
    200: {
      description: 'Checkout session was returned successfully.',
      $ref: 'paymentsCheckoutSessionResponseSchema#',
      examples: [checkoutSessionResponseExample],
    },

    400: {
      description: 'Invalid checkout session id.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read a checkout session.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to access this checkout session.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Checkout session or linked order was not found.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading checkout session.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for Stripe webhook delivery
const postStripeWebhookSchema = {
  operationId: 'handleStripeWebhook',
  summary: 'Handle Stripe webhook',
  description: 'Handles Stripe checkout webhook events and updates linked order payment state.',

  headers: {
    $ref: 'paymentsStripeWebhookHeadersSchema#',
    examples: [stripeWebhookHeadersExample],
  },

  response: {
    200: {
      description: 'Stripe webhook was received successfully.',
      $ref: 'paymentsStripeWebhookResponseSchema#',
      examples: [stripeWebhookResponseExample],
    },

    400: {
      description: 'Invalid Stripe webhook payload or missing signature.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Stripe webhook signature is invalid.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while handling Stripe webhook.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group payment routes under the payments Swagger tag
const taggedPaymentsSchema = withOpenApiTag(
  {
    postCheckoutSessionSchema,
    getCheckoutSessionByIdSchema,
    postStripeWebhookSchema,
  },
  'payments',
);

// Add access token security only to user checkout routes
export const paymentsSchema = withOpenApiSecurityFor(
  taggedPaymentsSchema,
  openApiSecurity.accessTokenCookie,
  ['postCheckoutSessionSchema', 'getCheckoutSessionByIdSchema'],
);