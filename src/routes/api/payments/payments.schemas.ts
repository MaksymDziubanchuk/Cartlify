import type { FastifySchema } from 'fastify';

import env from '@config/env.js';
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
    'Opens the payment page of a confirmed user order at the payment provider the buyer picked (`provider`, there is no default one). A repeated request for the same order, reservation and provider returns the same page; a page of another provider opened for the order before is closed first. `expiresAt` is the time after which the checkout can no longer be paid. A Stripe page returns the buyer to `WEB_ORIGIN` + `WEB_PAGE_CHECKOUT_SUCCESS` (`/checkout/success` unless set) `?session_id=<id>` or `WEB_PAGE_CHECKOUT_CANCEL` (`/checkout/cancel`) `?orderId=<id>`.',

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
        'The order cannot be paid now: `ORDER_NOT_CONFIRMED` (a cart or an order that lost its reservation, confirm it first), `ORDER_ALREADY_PAID` (also when the page of another provider took the money meanwhile), `ORDER_PAYMENT_IN_PROGRESS` (a payment on the page of another provider is still on its way), `ORDER_STATUS_NOT_WAITING`, `ORDER_RESERVATION_EXPIRED`, `ORDER_ITEMS_UNAVAILABLE` (the variant of an item was taken out of sale after the confirmation, its product removed with it: `details.items` names the items `{ itemId, variantId, reason: deleted, available, requested }` as the confirmation does; cancel the payment, change the order and confirm it again).',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description:
        '`RATE_LIMITED` with `details.limit: checkout`: more than ' +
        env.LIMIT_CHECKOUT_PER_USER +
        ' payment pages of a user in a minute; `retry-after` and `details.retryAfterSeconds` tell the wait.',
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

const refundsParamsExample = { refundId: 're_3QxYzAbCdEfGhIjK' };

const refundItemExample = {
  id: 're_3QxYzAbCdEfGhIjK',
  source: 'payment',
  orderId: 42,
  userId: 7,
  returnId: null,
  provider: 'stripe',
  paymentId: 'pi_3QxYzAbCdEfGhIjK',
  refundId: 're_3QxYzAbCdEfGhIjK',
  amount: 51,
  currency: 'eur',
  failure: 'card_unavailable',
  failureText: 'expired_or_canceled_card',
  at: '2026-11-10T09:30:00.000Z',
};

const refundOutsideBodyExample = {
  method: 'bank_transfer',
  note: 'Sent to the account the buyer wrote by mail.',
  at: '2026-11-10T09:30:00.000Z',
};

const refundOutsideResponseExample = {
  refundId: 're_3QxYzAbCdEfGhIjK',
  orderId: 42,
  userId: 7,
  provider: 'stripe',
  paymentId: 'pi_3QxYzAbCdEfGhIjK',
  amount: 51,
  currency: 'eur',
  state: 'outside',
  failure: 'card_unavailable',
  failureText: 'expired_or_canceled_card',
  outside: {
    method: 'bank_transfer',
    note: 'Sent to the account the buyer wrote by mail.',
    at: '2026-11-10T09:30:00.000Z',
    by: 1,
  },
};

// Schema for the list of the refunds that wait for the shop
const getRefundsSchema = {
  operationId: 'listPaymentRefunds',
  summary: 'List the refunds that wait for the shop',
  description:
    'The refunds the shop has to look after, the oldest first, a page at a time (`limit`, ' +
    '`cursor`, `total` of the filter). `state=failed`: money that did not reach the buyer: the ' +
    'transfers of the open statements of return whose last try failed (`source: return`, `id` is ' +
    'the statement, see `GET /api/returns/{returnId}`) and the refunds of the payments an order ' +
    'could not take that failed and that root has not marked sent another way (`source: payment`, ' +
    '`id` and `refundId` name the refund at the provider, root marks it with `POST ' +
    '/api/payments/refunds/{refundId}/outside`); a refund of a payment fails when the provider ' +
    'says so, also after its money was sent (the bank sent it back). `state=unsent`: the refunds ' +
    'of late payments that the provider has told neither sent nor failed (a refund on its way, ' +
    'or whose event did not come). Filters: `userId`, `orderId`, `to` (only the refunds that came ' +
    'to their state before the time). The alerts `failed_refunds` and `refunded_payments_not_sent` ' +
    'name this list with the filters of their cases, so the count of an alert is the `total` of ' +
    'its list. Only admin and root read it.',

  querystring: { $ref: 'paymentsRefundsQuerySchema#', examples: [{ state: 'failed' }] },

  response: {
    200: {
      description: 'The page of refunds.',
      $ref: 'paymentsRefundsResponseSchema#',
      examples: [{ items: [refundItemExample], total: 1, limit: 20, nextCursor: null }],
    },
    400: {
      description:
        '`CURSOR_INVALID`: the cursor is not one of this list. `VALIDATION_ERROR`: a wrong field, ' +
        'or no `state`.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for root marking a failed refund of a late payment as sent another way
const postRefundOutsideSchema = {
  operationId: 'markPaymentRefundOutside',
  summary: 'Record a failed refund sent another way',
  description:
    'A root records that the money of a payment an order could not take, whose refund failed, ' +
    'went to the buyer another way (a bank transfer, cash, another way), on the day it really ' +
    'went. Only a refund that failed and is not marked yet; the refund is named by its id at the ' +
    'provider (`refundId` of the list `GET /api/payments/refunds?state=failed`). It writes the ' +
    'line `order.refund_late_outside` once (the way, the day, the note, the sum) and leaves the ' +
    'alert `failed_refunds`; the buyer is mailed how much, how and when (the note is for the ' +
    'shop). Two marks at the same time make one: the second is refused.',

  params: { $ref: 'paymentsRefundOutsideParamsSchema#', examples: [refundsParamsExample] },
  body: { $ref: 'paymentsRefundOutsideBodySchema#', examples: [refundOutsideBodyExample] },

  response: {
    200: {
      description: 'The money was recorded.',
      $ref: 'paymentsRefundOutsideResponseSchema#',
      examples: [refundOutsideResponseExample],
    },
    400: {
      description:
        '`VALIDATION_ERROR`: a wrong field. `LATE_REFUND_OUTSIDE_AT_INVALID`: the day is of the ' +
        'future or before the refund was made.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`LATE_REFUND_NOT_FOUND`: the app made no refund of a payment with this id (one made by ' +
        'hand at the provider is none of its refunds).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`LATE_REFUND_NOT_FAILED`: the refund did not fail (it is made, or its money is sent). ' +
        '`LATE_REFUND_ALREADY_MARKED`: root recorded the money of this refund already.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group payment routes under the payments Swagger tag
const taggedPaymentsSchema = withOpenApiTag(
  {
    postCheckoutSessionSchema,
    getRefundsSchema,
    postRefundOutsideSchema,
  },
  'payments',
);

// Add access token security to the user checkout route and to the routes of the refunds
export const paymentsSchema = withOpenApiSecurityFor(
  taggedPaymentsSchema,
  openApiSecurity.accessTokenCookie,
  ['postCheckoutSessionSchema', 'getRefundsSchema', 'postRefundOutsideSchema'],
);
