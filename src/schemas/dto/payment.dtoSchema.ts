import { idPathParam, MAX_ID } from '@schemas/idPathParam.js';
import { OUTSIDE_METHODS, REFUND_FAILURES, RETURN_NOTE_MAX } from '@helpers/returns.js';
import { PAYMENT_PROVIDER_NAMES } from '@routes/api/payments/providers/names.js';
import {
  MONEY_REFUND_NEEDS,
  MONEY_REFUND_PURPOSES,
  MONEY_REFUND_STATES,
} from '@routes/api/payments/services/helpers/moneyRefunds.helper.js';

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

const dateTime = { type: 'string', format: 'date-time' } as const;

const refundFailureField = {
  type: ['string', 'null'],
  enum: [...REFUND_FAILURES, null],
  description:
    'Why the money did not reach the buyer, in our words: card_unavailable (the card can no ' +
    'longer take money), shop_balance (the balance of the shop at the provider), disputed (the ' +
    'buyer disputed the payment at the bank: the bank settles it), already_refunded (the money ' +
    'of the payment went back already, by hand in the dashboard: the refunds made by hand count ' +
    'it), unknown. null while the refund did not fail.',
} as const;

const paymentsRefundsQuerySchema = {
  $id: 'paymentsRefundsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    purpose: {
      type: 'string',
      enum: [...MONEY_REFUND_PURPOSES],
      description:
        'Only the refunds of this kind: return (the money of a statement of return), ' +
        'dispute_remainder (what the system sent of a statement after a dispute the shop lost: ' +
        'what the bank did not give back), late_payment (a payment the order could not take), ' +
        'hand (made by hand in the dashboard of the provider). All of them when not given.',
    },
    state: {
      type: 'string',
      enum: ['in_transit', 'failed', 'unassigned', 'any'],
      description:
        'any (the default): every refund. in_transit: asked of the provider and not told sent. ' +
        'failed: a failure the shop still has to act on: the rows of the statement still owe the ' +
        'money of the transfer (`POST /api/returns/{returnId}/refund` again or `/refund/outside`), ' +
        'or root has not sent the money of a late payment or of a refund made by hand another ' +
        'way (`POST /api/payments/refunds/{refundId}/outside`); a refusal because the money went ' +
        'back already waits for nothing. A failure waits for the bank, not for the shop, while a ' +
        'dispute of the payment is open (its end decides where the money goes), and so does a ' +
        'refund of a late payment the bank refused for a dispute (the app sends it again when ' +
        'the shop wins); the transfer of a statement also waits while a refund of the payment ' +
        'made by hand waits for root. unassigned: a refund made by hand that root has not ' +
        'said what it was for yet.',
    },
    need: {
      type: 'string',
      enum: [...MONEY_REFUND_NEEDS],
      description:
        'Only the refunds made by hand that need this of root: explain (the order went or was ' +
        'cancelled, or a statement of the order waits for its money: root says what it was for, ' +
        '`POST /api/payments/money-lines/{moneyLogId}/decision`). A refund made by hand of an ' +
        'order not sent yet with nothing waiting needs none: root decides with the hold of the order.',
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
    from: {
      ...dateTime,
      description: 'Only the refunds that came to their state at this time or later.',
    },
    to: {
      ...dateTime,
      description: 'Only the refunds that came to their state before this time.',
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

const refundItemProperties = {
  id: {
    type: 'integer',
    description:
      'The refund: its first line in the money journal. The id of a case, the one an alert puts ' +
      'aside and root names to send the money another way.',
  },
  purpose: {
    type: 'string',
    enum: [...MONEY_REFUND_PURPOSES],
    description:
      'return: the money of a statement of return; dispute_remainder: what the system sent of a ' +
      'statement after a dispute the shop lost; late_payment: the refund of a payment the order ' +
      'could not take; hand: made by hand in the dashboard of the provider; compensation: money ' +
      'root gave by the button of the app (`POST /api/payments/compensations`).',
  },
  state: {
    type: 'string',
    enum: [...MONEY_REFUND_STATES],
    description:
      'in_transit: asked, the provider has not told it sent; sent; failed: the last word of the ' +
      'provider is a failure (also after it was sent: the bank sent the money back); outside: ' +
      'root sent the money another way after it failed.',
  },
  need: {
    type: ['string', 'null'],
    enum: [...MONEY_REFUND_NEEDS, null],
    description:
      'A refund made by hand that waits for root to say what it was for: explain. null for any ' +
      'other refund.',
  },
  orderId: {
    type: ['integer', 'null'],
    description: 'The order; null for a late payment of an order that is gone.',
  },
  userId: { type: ['integer', 'null'], description: 'The buyer; null when nobody is known.' },
  returnId: {
    type: ['integer', 'null'],
    description: 'The statement the refund is the money of; null for any other refund.',
  },
  returnCode: {
    type: ['string', 'null'],
    description: 'The code of that statement, as the buyer and the admins know it (W42-2).',
  },
  provider: { type: ['string', 'null'], description: 'The provider of the payment.' },
  paymentId: { type: ['string', 'null'], description: 'The payment at the provider.' },
  refundId: {
    type: ['string', 'null'],
    description:
      'The refund at the provider; null while the provider has not said, and for a request it ' +
      'refused without making one.',
  },
  amount: {
    type: 'number',
    description:
      'What the provider was asked for: all of the parts of a transfer (the goods and the ' +
      'delivery less what was kept for the way back and what other money covered).',
  },
  currency: { type: ['string', 'null'], description: 'The currency of the money.' },
  failure: refundFailureField,
  failureText: {
    type: ['string', 'null'],
    description: 'The words of the provider for the failure, for the shop.',
  },
  bankReference: {
    type: ['string', 'null'],
    description:
      'The number the bank of the buyer knows the refund by (for a card the acquirer reference ' +
      'number), for the buyer to follow the money; null until the provider has it.',
  },
  byDashboard: {
    type: 'boolean',
    description:
      'The refund was made by hand in the dashboard of the provider, not by this server.',
  },
  createdAt: { ...dateTime, description: 'When the refund was asked, or made by hand.' },
  at: {
    ...dateTime,
    description:
      'When it came to its state: asked, told sent, failed, or sent another way; the list is ' +
      'sorted by it, the oldest first.',
  },
  paymentLeft: {
    type: ['number', 'null'],
    description:
      'What is left of the payment at the provider: as much as it can still give back (the rest of ' +
      'a refund that does not fit goes another way); null without a payment.',
  },
  returnLeft: {
    type: ['number', 'null'],
    description:
      'What the open statement of the refund still has to send the buyer: the rows owed, their ' +
      'delivery and the way back (the total of moneyLeft of its card); null without a statement ' +
      'or once it is closed.',
  },
} as const;

const refundItemRequired = Object.keys(
  refundItemProperties,
) as (keyof typeof refundItemProperties)[];

const paymentsRefundItemSchema = {
  type: 'object',
  additionalProperties: false,
  required: refundItemRequired,
  properties: refundItemProperties,
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
    refundId: idPathParam('the refund (`id` of the list of the refunds)'),
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
      enum: [...OUTSIDE_METHODS],
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
        'The day the money really went: never of the future and never before the refund was asked.',
    },
  },
} as const;

const paymentsRefundOutsideResponseSchema = {
  $id: 'paymentsRefundOutsideResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: [...refundItemRequired, 'outside'],
  properties: {
    ...refundItemProperties,
    outside: {
      type: 'object',
      additionalProperties: false,
      required: ['method', 'note', 'at', 'by'],
      description: 'The money root sent another way.',
      properties: {
        method: { type: 'string', enum: [...OUTSIDE_METHODS] },
        note: { type: 'string' },
        at: { ...dateTime, description: 'The day the money went.' },
        by: { type: 'integer', description: 'Root who recorded it.' },
      },
    },
  },
} as const;

const paymentsCompensationBodySchema = {
  $id: 'paymentsCompensationBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['orderId', 'amount', 'note'],
  properties: {
    orderId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'The order whose buyer gets the money, through its payment.',
    },
    amount: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 99_999_999.99,
      multipleOf: 0.01,
      description: 'The money, to the cent: at most what is left of the payment.',
    },
    note: {
      type: 'string',
      minLength: 1,
      maxLength: RETURN_NOTE_MAX,
      description: 'Why: for the journal of the admins, not mailed to the buyer.',
    },
  },
} as const;

const paymentsRefundResponseSchema = {
  $id: 'paymentsRefundResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: refundItemRequired,
  properties: refundItemProperties,
} as const;

const paymentsMoneyLineParamsSchema = {
  $id: 'paymentsMoneyLineParamsSchema',
  type: 'object',
  additionalProperties: false,
  required: ['moneyLogId'],
  properties: {
    moneyLogId: idPathParam(
      'the line of the money journal: a refund made by hand (`id` of the list of the refunds) or ' +
        'what a bank took for a lost dispute',
    ),
  },
} as const;

const moneySum = {
  type: 'number',
  maximum: 99_999_999.99,
  multipleOf: 0.01,
} as const;

const paymentsMoneyDecisionBodySchema = {
  $id: 'paymentsMoneyDecisionBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'note'],
  properties: {
    items: {
      type: 'array',
      maxItems: 100,
      description:
        'The items of the order the money went for, each with the units and the money: empty when ' +
        'none did (all of it a compensation or a loss).',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['orderItemId', 'quantity', 'amount'],
        properties: {
          orderItemId: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_ID,
            description: 'An item of the order of the line.',
          },
          quantity: {
            type: 'integer',
            minimum: 1,
            maximum: 999_999,
            description: 'The units of it the money went for.',
          },
          amount: {
            ...moneySum,
            exclusiveMinimum: 0,
            description: 'The money that went for them, to the cent.',
          },
        },
      },
    },
    delivery: {
      ...moneySum,
      minimum: 0,
      description: 'The money of the line that went for the delivery of the order; 0 by default.',
    },
    note: {
      type: 'string',
      minLength: 1,
      maxLength: RETURN_NOTE_MAX,
      description: 'Why: for the journal of the admins, not mailed to the buyer.',
    },
  },
} as const;

const paymentsMoneyDecisionResponseSchema = {
  $id: 'paymentsMoneyDecisionResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: ['moneyLogId', 'orderId', 'use', 'distributed', 'rest', 'covered', 'note'],
  properties: {
    moneyLogId: { type: 'integer', description: 'The line decided on.' },
    orderId: { type: 'integer', description: 'Its order.' },
    use: {
      type: 'string',
      enum: ['goods', 'compensation', 'loss'],
      description:
        'goods: all of the line went for the items and the delivery; compensation: a refund made ' +
        'by hand whose rest the shop gave apart; loss: what a bank took whose rest the shop lost.',
    },
    distributed: {
      type: 'string',
      pattern: '^[0-9]+\\.[0-9]{2}$',
      description: 'What went for the items and the delivery, two decimals.',
    },
    rest: {
      type: 'string',
      pattern: '^[0-9]+\\.[0-9]{2}$',
      description: 'The rest of the line, two decimals.',
    },
    covered: {
      type: 'array',
      description: 'The rows of open statements of the order paid with it at once.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['returnId', 'itemIds'],
        properties: {
          returnId: { type: 'integer' },
          itemIds: { type: 'array', items: { type: 'integer' } },
        },
      },
    },
    note: { type: 'string', description: 'The note, trimmed.' },
  },
} as const;

// the states of a dispute the app follows (payment_disputes.status)
const DISPUTE_STATUSES = [
  'warning_needs_response',
  'warning_under_review',
  'warning_closed',
  'needs_response',
  'under_review',
  'won',
  'lost',
  'prevented',
] as const;

const paymentsDisputesQuerySchema = {
  $id: 'paymentsDisputesQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      pattern: `^(${DISPUTE_STATUSES.join('|')})(,(${DISPUTE_STATUSES.join('|')}))*$`,
      description:
        'Only the disputes in these states, through commas: an inquiry of the bank ' +
        '(warning_needs_response, warning_under_review, warning_closed), a dispute ' +
        '(needs_response, under_review, won, lost, prevented).',
    },
    open: {
      type: 'boolean',
      description: 'true: only the disputes that did not end; false: only the ended ones.',
    },
    toAnswer: {
      type: 'boolean',
      description:
        'true: only the open disputes no evidence was submitted for yet (the draft of the app is ' +
        'not submitted evidence).',
    },
    closedFrom: { ...dateTime, description: 'Only the disputes that ended at this time or later.' },
    moneyUndecided: {
      type: 'boolean',
      description:
        'true: only the disputes whose money the bank took waits for root to say what it was for ' +
        '(lost on an order sent: `POST /api/payments/money-lines/{moneyLogId}/decision`; the ' +
        'transfers of the order wait meanwhile); false: the others.',
    },
    orderId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'Only the disputes of this order.',
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

const disputeItemProperties = {
  id: { type: 'integer', description: 'The dispute in the app.' },
  provider: { type: 'string', description: 'The provider of the payment.' },
  stripeId: { type: 'string', description: 'The id of the dispute at the provider.' },
  paymentId: { type: 'string', description: 'The payment disputed.' },
  orderId: {
    type: ['integer', 'null'],
    description: 'The order of the payment, or of the late payment; null when it is gone.',
  },
  userId: { type: ['integer', 'null'], description: 'The buyer.' },
  late: {
    type: 'boolean',
    description: 'The payment is one the order could not take: the shop gives it back.',
  },
  reason: { type: ['string', 'null'], description: 'Why the bank disputes it, in its words.' },
  status: { type: 'string', enum: [...DISPUTE_STATUSES] },
  open: { type: 'boolean', description: 'The dispute did not end.' },
  evidenceDueBy: {
    type: ['string', 'null'],
    format: 'date-time',
    description: 'The last moment the evidence can be submitted at the provider.',
  },
  hasEvidence: {
    type: 'boolean',
    description: 'Evidence is on it: the draft of the app, or what a person submitted.',
  },
  submissionCount: {
    type: 'integer',
    description: 'How many times evidence was submitted; 0 while the dispute waits for an answer.',
  },
  isChargeRefundable: {
    type: 'boolean',
    description: 'The payment can still be refunded to settle the dispute.',
  },
  withdrawn: {
    type: 'number',
    description: 'What the dispute took from the balance less what it gave back.',
  },
  returnOpen: { type: 'boolean', description: 'A statement of return of the order is open.' },
  openedAt: { ...dateTime, description: 'When the bank opened it.' },
  closedAt: { type: ['string', 'null'], format: 'date-time', description: 'When it ended.' },
  draftedAt: {
    type: ['string', 'null'],
    format: 'date-time',
    description: 'When the app put its draft of the evidence at the provider.',
  },
  createdAt: dateTime,
  updatedAt: dateTime,
} as const;

const disputeItemRequired = Object.keys(
  disputeItemProperties,
) as (keyof typeof disputeItemProperties)[];

const paymentsDisputesResponseSchema = {
  $id: 'paymentsDisputesResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'total', 'limit', 'nextCursor'],
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: disputeItemRequired,
        properties: disputeItemProperties,
      },
    },
    total: { type: 'integer', minimum: 0, description: 'Of the filter, not only of the page.' },
    limit: { type: 'integer' },
    nextCursor: { type: ['string', 'null'], description: 'null on the last page.' },
  },
} as const;

const paymentsDisputeParamsSchema = {
  $id: 'paymentsDisputeParamsSchema',
  type: 'object',
  additionalProperties: false,
  required: ['disputeId'],
  properties: { disputeId: idPathParam('the dispute (`id` of the list of the disputes)') },
} as const;

const paymentsDisputeResponseSchema = {
  $id: 'paymentsDisputeResponseSchema',
  type: 'object',
  additionalProperties: false,
  required: [...disputeItemRequired, 'money', 'order', 'returns'],
  properties: {
    ...disputeItemProperties,
    money: {
      type: 'array',
      description: 'What the dispute moved on the balance: the lines of the money journal.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'event', 'amount', 'currency', 'stripeTxId', 'moneyUse', 'createdAt'],
        properties: {
          id: { type: 'integer' },
          event: { type: 'string', enum: ['money.dispute_withdrawn', 'money.dispute_reinstated'] },
          amount: { type: 'number', description: 'Below 0 taken, above 0 given back.' },
          currency: { type: ['string', 'null'] },
          stripeTxId: { type: ['string', 'null'], description: 'The balance transaction.' },
          moneyUse: {
            type: ['string', 'null'],
            enum: ['goods', 'compensation', 'loss', null],
            description:
              'What the bank took for a lost dispute was for, once decided: goods (all of it went ' +
              'to the items and the delivery of the order, which the statements take first), loss ' +
              '(the rest the shop lost). null while it waits for root ' +
              '(`POST /api/payments/money-lines/{id}/decision`; the transfers of the order wait ' +
              'meanwhile), and for the money given back.',
          },
          createdAt: dateTime,
        },
      },
    },
    order: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['id', 'status', 'total', 'holds'],
      properties: {
        id: { type: 'integer' },
        status: { type: 'string' },
        total: { type: 'number' },
        holds: {
          type: 'array',
          description: 'What holds the order from its sending.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['reason', 'since', 'ref'],
            properties: {
              reason: { type: 'string' },
              since: { type: 'string' },
              ref: { type: ['string', 'integer'] },
            },
          },
        },
      },
    },
    returns: {
      type: 'array',
      description: 'The statements of return of the order.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'code', 'reason', 'refundedTotal', 'moneyLeft', 'closedAt'],
        properties: {
          id: { type: 'integer' },
          code: { type: 'string' },
          reason: { type: ['string', 'null'] },
          refundedTotal: { type: 'number' },
          moneyLeft: {
            type: ['number', 'null'],
            description:
              'What an open statement still owes the buyer: the rows owed, their delivery and the ' +
              'way back (the total of moneyLeft of its card), for the decision on the money of ' +
              'the bank. Null once it is closed.',
          },
          closedAt: { type: ['string', 'null'], format: 'date-time' },
        },
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
  paymentsCompensationBodySchema,
  paymentsRefundResponseSchema,
  paymentsMoneyLineParamsSchema,
  paymentsMoneyDecisionBodySchema,
  paymentsMoneyDecisionResponseSchema,
  paymentsDisputesQuerySchema,
  paymentsDisputesResponseSchema,
  paymentsDisputeParamsSchema,
  paymentsDisputeResponseSchema,
];
