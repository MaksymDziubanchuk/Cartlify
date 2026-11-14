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

const refundsParamsExample = { refundId: '812' };

const refundItemExample = {
  id: 812,
  purpose: 'late_payment',
  state: 'failed',
  need: null,
  orderId: 42,
  userId: 7,
  returnId: null,
  returnCode: null,
  provider: 'stripe',
  paymentId: 'pi_3QxYzAbCdEfGhIjK',
  refundId: 're_3QxYzAbCdEfGhIjK',
  amount: 51,
  currency: 'eur',
  failure: 'card_unavailable',
  failureText: 'expired_or_canceled_card',
  bankReference: null,
  byDashboard: false,
  createdAt: '2026-11-10T09:00:00.000Z',
  at: '2026-11-10T09:30:00.000Z',
  paymentLeft: 51,
  returnLeft: null,
};

const refundOutsideBodyExample = {
  method: 'bank_transfer',
  note: 'Sent to the account the buyer wrote by mail.',
  at: '2026-11-10T09:30:00.000Z',
};

const refundOutsideResponseExample = {
  ...refundItemExample,
  state: 'outside',
  at: '2026-11-11T08:00:00.000Z',
  outside: {
    method: 'bank_transfer',
    note: 'Sent to the account the buyer wrote by mail.',
    at: '2026-11-10T09:30:00.000Z',
    by: 1,
  },
};

// Schema for the list of the refunds of the money journal
const getRefundsSchema = {
  operationId: 'listPaymentRefunds',
  summary: 'List the refunds of the money journal',
  description:
    'The refunds of the money journal with where each stands, the oldest state first, a page at ' +
    'a time (`limit`, `cursor`, `total` of the filter): the transfers of the statements of ' +
    'return (`return`), what the system sent of a statement after a dispute the shop lost ' +
    '(`dispute_remainder`), the refunds of the payments an order could not take ' +
    '(`late_payment`) and the refunds made by hand in the dashboard of the provider (`hand`). A ' +
    'refund is the lines of one request of the app (a transfer in its parts) or one refund made ' +
    'by hand; `id` is its first line, the one root names to send the money another way (`POST ' +
    '/api/payments/refunds/{refundId}/outside`). `state=failed` holds the failures the shop still ' +
    'has to act on, `state=unassigned` the refunds made by hand root has not tied to a statement ' +
    'or explained (`need`). Filters: `purpose`, `need`, `userId`, `orderId`, `from` and `to` (the ' +
    'time it came to its state). The alerts of the refunds name this list with the filters of ' +
    'their cases, so the count of an alert is the `total` of its list. Only admin and root read it.',

  querystring: { $ref: 'paymentsRefundsQuerySchema#', examples: [{ state: 'failed' }] },

  response: {
    200: {
      description: 'The page of refunds.',
      $ref: 'paymentsRefundsResponseSchema#',
      examples: [{ items: [refundItemExample], total: 1, limit: 20, nextCursor: null }],
    },
    400: {
      description:
        '`CURSOR_INVALID`: the cursor is not one of this list. `VALIDATION_ERROR`: a wrong field.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for root marking a failed refund as sent another way
const postRefundOutsideSchema = {
  operationId: 'markPaymentRefundOutside',
  summary: 'Record a failed refund sent another way',
  description:
    'A root (or an admin root allowed to handle the money, `canManageMoney`) ' +
    'records that the money of a refund that failed, of a payment an order could not take ' +
    'or made by hand in the dashboard of the provider, went to the buyer another way (a bank ' +
    'transfer, cash, another way), on the day it really went. The refund is named by its `id` ' +
    'in the list `GET /api/payments/refunds?state=failed` (a refusal of the provider made no ' +
    'refund there to name). The money journal gets one line `money.outside` of all its sum that ' +
    'names the refund (and the statement a refund made by hand is tied to), the journal of the ' +
    'admins the line `payment.refund_outside` with both lines; the refund leaves the failures ' +
    'that wait and the alert of its kind (`late_refunds_failed`, `hand_refunds_failed`); the ' +
    'buyer is mailed how much, how and when (the ' +
    'note is for the shop). The money of a statement goes by `POST ' +
    '/api/returns/{returnId}/refund/outside`. Two marks at the same time make one: the second ' +
    'is refused.',

  params: { $ref: 'paymentsRefundOutsideParamsSchema#', examples: [refundsParamsExample] },
  body: { $ref: 'paymentsRefundOutsideBodySchema#', examples: [refundOutsideBodyExample] },

  response: {
    200: {
      description: 'The money was recorded: the refund with its new state.',
      $ref: 'paymentsRefundOutsideResponseSchema#',
      examples: [refundOutsideResponseExample],
    },
    400: {
      description:
        '`VALIDATION_ERROR`: a wrong field. `PAYMENT_REFUND_OUTSIDE_AT_INVALID`: the day is of the ' +
        'future or before the refund was asked. `PAYMENT_REFUND_OUTSIDE_NOTE_REQUIRED`: a note of ' +
        'spaces only.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`PAYMENT_REFUND_NOT_FOUND`: no refund of a late payment or made by hand has this id (a ' +
        'transfer of a statement goes by its own route).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`PAYMENT_REFUND_NOT_FAILED`: the refund did not fail (it is on its way, or its money is ' +
        'sent), or its money went back already (by hand, by the bank for a dispute, or the app ' +
        'sent the payment back again after a dispute the shop won). ' +
        '`PAYMENT_REFUND_ALREADY_MARKED`: root recorded the money of this refund already. ' +
        '`PAYMENT_REFUND_DISPUTED`: a dispute of the payment is open at the bank, whose end ' +
        'decides where the money goes.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for root giving the buyer of an order a compensation by the button of the app
const postCompensationSchema = {
  operationId: 'giveCompensation',
  summary: 'Give the buyer of an order a compensation',
  description:
    'Root (or an admin root allowed to handle the money, `canManageMoney`) gives the buyer of an ' +
    'order money through its payment at the provider: a compensation (a gesture, money for a part ' +
    'the buyer kept), at most what is left of the payment, not while a dispute of the payment is ' +
    'open at the bank. It goes the steps of every refund of the app: one line `money.refund` of ' +
    'the purpose `compensation` in transit, the provider asked, the answer settles it (no answer ' +
    'leaves it in transit, the worker asks again with the same key). The buyer is mailed "We sent ' +
    'you a compensation" once it is sent; a failure is not mailed, it is among the failed refunds ' +
    '(`GET /api/payments/refunds?purpose=compensation&state=failed`) for root to send another way ' +
    '(`POST /api/payments/refunds/{refundId}/outside`). The journal of the admins gets ' +
    '`payment.compensation` with the line of the money journal, the sum and the note. The answer ' +
    'is the refund as the list of the refunds shows it.',

  body: {
    $ref: 'paymentsCompensationBodySchema#',
    examples: [{ orderId: 42, amount: 5, note: 'A gesture for the parcel that came late.' }],
  },

  response: {
    200: {
      description: 'The compensation is asked of the provider (sent, failed or on its way).',
      $ref: 'paymentsRefundResponseSchema#',
      examples: [
        {
          ...refundItemExample,
          id: 816,
          purpose: 'compensation',
          state: 'sent',
          need: null,
          returnId: null,
          amount: 5,
          failure: null,
          failureText: null,
        },
      ],
    },
    400: {
      description:
        '`VALIDATION_ERROR`: a wrong field. `COMPENSATION_AMOUNT_INVALID`: a sum that is not above 0 ' +
        'to the cent. `COMPENSATION_NOTE_REQUIRED`: a note of spaces only.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        '`INSUFFICIENT_ROLE`: only an admin or root reaches the route; `MONEY_MANAGER_REQUIRED`: ' +
        'only root and an admin root allowed to handle the money give it; ' +
        '`COMPENSATION_FORBIDDEN`: the database refused the actor the same way.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`COMPENSATION_ORDER_INVALID`: no order with a payment of the provider has this id.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`COMPENSATION_EXCEEDS_PAID`: more than is left of the payment (the provider gives back no ' +
        'more than it took: send it another way). `COMPENSATION_DISPUTED`: a dispute of the payment ' +
        'is open at the bank, whose end decides where the money goes. `COMPENSATION_IN_TRANSIT`: ' +
        'another compensation of the order is still on its way (a second press would give the ' +
        'money twice): the next one goes once it is sent or failed. `RESOURCE_BUSY`: try again.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const moneyLineParamsExample = { moneyLogId: '815' };

const moneyDecisionBodyExample = {
  items: [{ orderItemId: 31, quantity: 1, amount: 20 }],
  delivery: 5,
  note: 'The buyer sent the lamp back by post, the refund was for it.',
};

const moneyDecisionExample = {
  moneyLogId: 815,
  orderId: 42,
  use: 'compensation',
  distributed: '25.00',
  rest: '5.00',
  covered: [{ returnId: 12, itemIds: [31] }],
  note: 'The buyer sent the lamp back by post, the refund was for it.',
};

// Schema for root saying what money given back by hand or taken by a bank was for
const postMoneyDecisionSchema = {
  operationId: 'decideMoneyUse',
  summary: 'Say what money given back by hand or taken by a bank was for',
  description:
    'Root (or an admin root allowed to handle the money, `canManageMoney`) says what a line of ' +
    'the money journal was for: a refund made by hand in the dashboard of the provider (the ' +
    '`id` of a refund of purpose hand in `GET /api/payments/refunds`), or what a bank took ' +
    'for a dispute the shop lost (a line `money.dispute_withdrawn` of the money journal of the ' +
    'admins). `items` are items of its order with the units and the money that went for them, ' +
    'never more than they cost with the other decisions of the order; `delivery` the money of ' +
    'the delivery. All of the line spent so, it was for the goods; the rest was a compensation ' +
    '(by hand) or a loss of the shop (the bank). A hold the refund put on the order goes. The ' +
    'decision is made again while no statement took its shares: the new split takes the place ' +
    'of the old one, which the journal of the admins keeps (`old` of the line ' +
    '`payment.money_decision`). The transfers and the money sent another way of the order ' +
    'wait while such a line has no decision (`RETURN_HAND_REFUND_PENDING`, ' +
    '`RETURN_BANK_MONEY_PENDING`); after it they take what the decisions gave the items and the ' +
    'delivery as money the buyer has back, and ask the provider for the rest only. The rows of ' +
    'the open statements of the order that the shares pay all of are paid at once (`covered`), ' +
    'nothing asked of the provider, and the buyer is mailed that the money is back. The journal ' +
    'of the admins gets `payment.money_decision` with the line, the decision and the note (the ' +
    'note is not mailed).',

  params: { $ref: 'paymentsMoneyLineParamsSchema#', examples: [moneyLineParamsExample] },
  body: { $ref: 'paymentsMoneyDecisionBodySchema#', examples: [moneyDecisionBodyExample] },

  response: {
    200: {
      description: 'The decision is written.',
      $ref: 'paymentsMoneyDecisionResponseSchema#',
      examples: [moneyDecisionExample],
    },
    400: {
      description:
        '`VALIDATION_ERROR`: the id is not a whole number from 1 to 2147483647, or a wrong field. ' +
        '`MONEY_DECISION_INVALID`: an item is not one of the order, or more units than it has. ' +
        '`MONEY_DECISION_NOTE_REQUIRED`: a note of spaces only.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        '`INSUFFICIENT_ROLE`: only an admin or root reaches the route; `MONEY_MANAGER_REQUIRED`: ' +
        'only root and an admin root allowed to handle the money decide on it; ' +
        '`MONEY_DECISION_FORBIDDEN`: the database refused the actor the same way.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`MONEY_DECISION_NOT_FOUND`: the line is not money given back by hand or taken by a bank ' +
        'of an order (a refund of the app, another line of the money journal, or none).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`MONEY_DECISION_DONE`: a statement took the shares of its decision already (a transfer, ' +
        'money sent another way, money the buyer gave back), or it failed and no money ' +
        'went. `MONEY_DECISION_DISPUTE_NOT_LOST`: the dispute the bank took the money for is not ' +
        'lost: the bank holds the money until it ends and gives it back when the shop wins. ' +
        '`MONEY_DECISION_EXCEEDS`: an item or the delivery would get more than it cost with ' +
        'the other decisions of the order, or the items and the delivery more than the line. ' +
        '`RESOURCE_BUSY`: try again.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const disputeItemExample = {
  id: 7,
  provider: 'stripe',
  stripeId: 'du_1QxYzAbCdEfGhIjKlMnOpQrS',
  paymentId: 'pi_3QxYzAbCdEfGhIjK',
  orderId: 42,
  userId: 7,
  late: false,
  reason: 'fraudulent',
  status: 'needs_response',
  open: true,
  evidenceDueBy: '2026-11-18T23:59:59.000Z',
  hasEvidence: true,
  submissionCount: 0,
  isChargeRefundable: false,
  withdrawn: 25,
  returnOpen: false,
  openedAt: '2026-11-11T09:00:00.000Z',
  closedAt: null,
  draftedAt: '2026-11-11T09:00:02.000Z',
  createdAt: '2026-11-11T09:00:01.000Z',
  updatedAt: '2026-11-11T09:00:02.000Z',
};

// Schema for the list of the disputes
const getDisputesSchema = {
  operationId: 'listPaymentDisputes',
  summary: 'List the disputes of the payments',
  description:
    'The disputes of the payments at the bank, the inquiries of the bank among them, as the app ' +
    'follows them from the provider (every event of a dispute reads it from the provider again): ' +
    'the state, when the evidence is due, whether evidence was submitted (`submissionCount`; the ' +
    'draft the app puts on every open dispute is not submitted), what the dispute took less what ' +
    'it gave back (`withdrawn`), whether a statement of the order is open (`returnOpen`: its money ' +
    'waits for the dispute). The nearest due first (one without a date last), a page at a time ' +
    '(`limit`, `cursor`, `total` of the filter). Filters: `status` (states through commas), ' +
    '`open`, `toAnswer` (open, nothing submitted), `closedFrom`, `orderId`. The alerts of the ' +
    'disputes name this list with the filters of their cases. Only admin and root read it.',

  querystring: { $ref: 'paymentsDisputesQuerySchema#', examples: [{ toAnswer: true }] },

  response: {
    200: {
      description: 'The page of disputes.',
      $ref: 'paymentsDisputesResponseSchema#',
      examples: [{ items: [disputeItemExample], total: 1, limit: 20, nextCursor: null }],
    },
    400: {
      description:
        '`CURSOR_INVALID`: the cursor is not one of this list. `VALIDATION_ERROR`: a wrong field ' +
        '(a state that is none, a date that is none).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the card of a dispute
const getDisputeSchema = {
  operationId: 'getPaymentDispute',
  summary: 'Get a dispute of a payment',
  description:
    'One dispute as the list gives it, with the money it moved on the balance (its lines of the ' +
    'money journal: what the bank took and gave back, the statement the money of a lost dispute ' +
    'pays), its order (the status, the total, what holds it from its sending) and the statements ' +
    'of return of the order. Only admin and root read it.',

  params: { $ref: 'paymentsDisputeParamsSchema#', examples: [{ disputeId: '7' }] },

  response: {
    200: {
      description: 'The dispute.',
      $ref: 'paymentsDisputeResponseSchema#',
      examples: [
        {
          ...disputeItemExample,
          money: [
            {
              id: 901,
              event: 'money.dispute_withdrawn',
              amount: -25,
              currency: 'eur',
              stripeTxId: 'txn_1QxYzAbCdEfGhIjKlMnOpQr',
              moneyUse: null,
              createdAt: '2026-11-11T09:00:01.000Z',
            },
          ],
          order: {
            id: 42,
            status: 'paid',
            total: 25,
            holds: [{ reason: 'dispute', since: '2026-11-11T09:00:01.000Z', ref: 7 }],
          },
          returns: [],
        },
      ],
    },
    400: {
      description: '`VALIDATION_ERROR`: the id is not a whole number from 1 to 2147483647.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`DISPUTE_NOT_FOUND`: no dispute has this id.',
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
    postCompensationSchema,
    postMoneyDecisionSchema,
    getDisputesSchema,
    getDisputeSchema,
  },
  'payments',
);

// Add access token security to the user checkout route and to the routes of the refunds
export const paymentsSchema = withOpenApiSecurityFor(
  taggedPaymentsSchema,
  openApiSecurity.accessTokenCookie,
  [
    'postCheckoutSessionSchema',
    'getRefundsSchema',
    'postRefundOutsideSchema',
    'postCompensationSchema',
    'postMoneyDecisionSchema',
    'getDisputesSchema',
    'getDisputeSchema',
  ],
);
