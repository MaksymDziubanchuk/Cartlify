import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const checkoutSessionBodyExample = {
  orderId: 1,
  provider: 'stripe',
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

// Schema for user checkout session creation
const postCheckoutSessionSchema = {
  operationId: 'createCheckoutSession',
  summary: 'Create checkout session',
  description:
    'Opens the payment page of a confirmed user order at the payment provider the buyer picked (`provider`, there is no default one). A repeated request for the same order, reservation and provider returns the same page; a page of another provider opened for the order before is closed first. `expiresAt` is the time after which the checkout can no longer be paid. A Stripe page returns the buyer to `WEB_ORIGIN/checkout/success?session_id=<id>` or `WEB_ORIGIN/checkout/cancel?orderId=<id>`.',

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
      description:
        '`VALIDATION_ERROR`: the order id is not a whole number from 1 to 2147483647, or `provider` is missing or not one this server pays with. `ORDER_TOTAL_INVALID`: the order total is zero. `ORDER_TOTAL_BELOW_MINIMUM`: the provider takes no smaller payment, `details` has the smallest total (`minimum`) and its `currency`; the confirmation refuses a total no provider takes already, this answers a total only another provider takes or an order confirmed before the rule.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: '`LOGIN_REQUIRED`: the session cookies are no longer valid.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        '`INSUFFICIENT_ROLE`: only a signed-in buyer pays, not a guest, an admin or root.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`ORDER_NOT_FOUND`: there is no such order of this user.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The order cannot be paid now: `ORDER_NOT_CONFIRMED` (a cart or an order that lost its reservation, confirm it first), `ORDER_ALREADY_PAID` (also when the page of another provider took the money meanwhile), `ORDER_PAYMENT_IN_PROGRESS` (a payment on the page of another provider is still on its way), `ORDER_STATUS_NOT_WAITING`, `ORDER_RESERVATION_EXPIRED`, `ORDER_ITEMS_UNAVAILABLE` (an item was removed from the catalog: `details.items` names it as the confirmation does; cancel the payment, change the order and confirm it again).',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description:
        '`RATE_LIMITED` with `details.limit: checkout`: more than 10 payment pages of a user in a minute; `retry-after` and `details.retryAfterSeconds` tell the wait.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while creating checkout session.',
      $ref: 'errorResponseSchema#',
    },
    503: {
      description:
        '`REDIS_UNAVAILABLE` or `PAYMENT_PROVIDER_UNAVAILABLE` (the provider cannot be reached): no page was opened, try again a bit later.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group payment routes under the payments Swagger tag
const taggedPaymentsSchema = withOpenApiTag(
  {
    postCheckoutSessionSchema,
  },
  'payments',
);

// Add access token security to the user checkout route
export const paymentsSchema = withOpenApiSecurityFor(
  taggedPaymentsSchema,
  openApiSecurity.accessTokenCookie,
  ['postCheckoutSessionSchema'],
);
