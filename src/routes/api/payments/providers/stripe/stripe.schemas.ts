import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const checkoutSessionParamsExample = {
  sessionId: 'cs_test_123456789',
};

const checkoutSessionResponseExample = {
  checkoutSession: {
    provider: 'stripe',
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

// Schema for user checkout session lookup
const getCheckoutSessionByIdSchema = {
  operationId: 'getStripeCheckoutSessionById',
  summary: 'Get Stripe checkout session by id',
  description:
    'Returns a Stripe checkout session by session id for the authenticated user: the page the buyer comes back to from a Stripe payment page (`WEB_ORIGIN/checkout/success?session_id=<id>`) asks how the payment stands. Stripe is asked directly, it knows about the payment before the webhook comes, so `paymentStatus: paid` may come while the order still waits for it.',

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
      description:
        '`VALIDATION_ERROR`: the id is not one of a Stripe checkout session (`cs_test_…` or `cs_live_…`), Stripe is not asked.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: '`LOGIN_REQUIRED`: the session cookies are no longer valid.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        '`INSUFFICIENT_ROLE`: only a signed-in buyer reads a checkout session, not a guest, an admin or root.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`CHECKOUT_SESSION_NOT_FOUND`: Stripe has no such session, or it is not one the app opened for an order. `ORDER_NOT_FOUND`: the order of the session is not one of this user.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading checkout session.',
      $ref: 'errorResponseSchema#',
    },
    503: {
      description:
        '`PAYMENT_PROVIDER_UNAVAILABLE`: Stripe cannot be reached, ask again a bit later.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for Stripe webhook delivery
const postStripeWebhookSchema = {
  operationId: 'handleStripeWebhook',
  summary: 'Handle Stripe webhook',
  description:
    'Handles Stripe checkout webhook events and updates linked order payment state. When the order becomes paid, the buyer gets a mail with the order; a mail that fails is only logged and does not fail the webhook. A payment the order cannot take (already paid by another payment, not payable, amount mismatch, out of stock) is refunded in full and recorded in the admin audit log; the same payment delivered again changes nothing, also after the order was shipped, delivered or cancelled. An expired checkout releases the order reservation only after the payment grace window; an expired or failed checkout of an already deleted order is acknowledged with `skipped: ORDER_NOT_FOUND`. A checkout the app did not open for an order (another tool in the same Stripe account) is acknowledged with `skipped: NOT_AN_ORDER` and left alone, its payment too. The route is outside the request rate limit: Stripe delivers every event from a few addresses, the signature keeps anybody else out.',

  // inline, not a $ref: fastify lowercases header names only in an inline headers schema,
  // so `required` of a referenced one may not apply (FSTSEC002)
  headers: {
    type: 'object',
    additionalProperties: true,
    required: ['stripe-signature'],
    properties: {
      'stripe-signature': { type: 'string', minLength: 1 },
    },
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

// Group the Stripe routes under the payments Swagger tag
const taggedStripeSchema = withOpenApiTag(
  {
    getCheckoutSessionByIdSchema,
    postStripeWebhookSchema,
  },
  'payments',
);

// Add access token security only to the user route
export const stripeSchema = withOpenApiSecurityFor(
  taggedStripeSchema,
  openApiSecurity.accessTokenCookie,
  ['getCheckoutSessionByIdSchema'],
);
