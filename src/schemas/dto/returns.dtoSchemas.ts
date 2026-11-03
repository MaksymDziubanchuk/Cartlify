import {
  RETURN_BASES,
  RETURN_CLOSE_CODES,
  RETURN_ROOT_CLOSE_CODES,
  RETURN_DESCRIPTION_MAX,
  RETURN_GOODS,
  RETURN_GOODS_RESULTS,
  RETURN_MONEY,
  RETURN_NOT_ACCEPTED_REASONS,
  RETURN_NOTE_MAX,
  RETURN_OUTSIDE_METHODS,
  RETURN_OUTSIDE_PAYMENT_METHODS,
  RETURN_REASONS,
  RETURN_REFUND_FAILURES,
  RETURN_SOURCES,
  RETURN_STATUSES,
} from '@helpers/returns.js';
import { MAX_ID, idPathParam } from '@schemas/idPathParam.js';

// RETURNS: the statements of withdrawal and of return an admin makes and settles

const dateTime = { type: 'string', format: 'date-time' } as const;
const nullableDateTime = { type: ['string', 'null'], format: 'date-time' } as const;

// the most items or results one request carries
const LIST_MAX = 100;
// the most units of one item a request names: whole units a database column holds
const UNITS_MAX = 999_999_999;

export const returnStatusField = {
  type: 'string',
  enum: [...RETURN_STATUSES],
  description:
    'Where the order stands as to its statements of withdrawal and return: none (no statement), ' +
    'open (a statement is open, no money went back yet), open_partial (one is open and part of ' +
    'the money went back), partial (all are closed, part went back), full (all are closed, ' +
    'everything went back with the delivery), declined (all are closed, nothing went back).',
} as const;

const person = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    name: { type: ['string', 'null'] },
    email: { type: 'string' },
  },
  required: ['id', 'name', 'email'],
} as const;

const returnsParamsSchema = {
  $id: 'returnsParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: { returnId: idPathParam('the statement') },
  required: ['returnId'],
} as const;

const listIdField = (description: string) =>
  ({ type: 'integer', minimum: 1, maximum: MAX_ID, description }) as const;

const listDateField = (description: string) =>
  ({ type: 'string', format: 'date-time', description }) as const;

const listDaysField = (description: string) =>
  ({ type: 'integer', minimum: 1, maximum: 3650, description }) as const;

const returnsListQuerySchema = {
  $id: 'returnsListQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: ['open', 'closed'], description: 'Open or closed statements.' },
    goods: {
      type: 'string',
      enum: ['waiting', 'waiting_no_proof', 'proof_provided', 'received'],
      description:
        'waiting: some row waits for its goods; waiting_no_proof: and the buyer has told nothing ' +
        'of the parcel and the shop has confirmed none; proof_provided: and the buyer told, the ' +
        'shop has not confirmed it; received: no row waits for goods.',
    },
    money: {
      type: 'string',
      enum: ['not_refunded', 'pending', 'failed', 'refunded', 'refused'],
      description:
        'Statements with a row in this state of the money; failed: a row whose last transfer ' +
        'failed (its money is not back).',
    },
    source: { type: 'string', enum: [...RETURN_SOURCES], description: 'Where it was made.' },
    basis: {
      type: 'string',
      enum: [...RETURN_BASES],
      description: 'withdrawal (the right of withdrawal) or other (outside it).',
    },
    reason: {
      type: 'string',
      enum: [...RETURN_REASONS],
      description: 'The reason an admin gave; a statement of the right of withdrawal has none.',
    },
    orderId: listIdField('Only the statements of this order.'),
    userId: listIdField('Only the statements of the orders of this buyer.'),
    productId: listIdField('Only the statements with a row of this product.'),
    variantId: listIdField('Only the statements with a row of this variant.'),
    q: {
      type: 'string',
      minLength: 1,
      maxLength: 200,
      description:
        'The code of a statement (W42-2, R42-1) is that statement; a whole number is the number ' +
        'of an order (or a part of a name or an email); any other text is a part of the name or ' +
        'the email of the statement.',
    },
    statedFrom: listDateField('Stated at this time or later.'),
    statedTo: listDateField('Stated before this time.'),
    closedFrom: listDateField('Closed at this time or later.'),
    closedTo: listDateField('Closed before this time.'),
    refundedFrom: listDateField('Some row whose money went back at this time or later.'),
    refundedTo: listDateField('Some row whose money went back before this time.'),
    olderThanDays: listDaysField('Stated more than so many days ago.'),
    moneyDueForDays: listDaysField(
      'The money is due (the goods are in, or the shop confirmed the proof of the parcel) and ' +
        'not back, more than so many days after the statement.',
    ),
    paidAheadForDays: listDaysField(
      'The money went back more than so many days ago and the goods are not in yet.',
    ),
    proofOlderThanDays: listDaysField('The buyer told of the parcel more than so many days ago.'),
    accepted: {
      type: 'boolean',
      description:
        'The statements of the form without the code by the check of an admin: false, the ones no ' +
        'admin accepted yet (they wait for the check, their goods and money too); true, the ones ' +
        'accepted. A statement of another source is neither.',
    },
    moneyOverdue: {
      type: 'boolean',
      description:
        'true: the money of some row is due (the goods are in, or the shop confirmed the proof of ' +
        'the parcel) and not back (or on its way), and the 14 days the law gives from the ' +
        'statement are over; false: the others. A statement whose goods were not sent is a case ' +
        'of the goods, not of the money.',
    },
    moneyDueWithinDays: listDaysField(
      'The money of some row is due and not back (or on its way), and its 14 days from the ' +
        'statement end within so many days from now.',
    ),
    extended: {
      type: 'boolean',
      description:
        'true: the statement is a part of a chain of extensions (it extends one, or one extends ' +
        'it); false: a statement on its own.',
    },
    sortBy: {
      type: 'string',
      enum: ['statedAt', 'closedAt', 'updatedAt', 'amount', 'moneyDeadline'],
      description:
        'statedAt by default; closedAt puts the statements not closed after the closed ones, ' +
        'newest first; moneyDeadline goes by the end of the 14 days of the money from the ' +
        'statement for the statements whose money is due, the others last when the nearest come ' +
        'first.',
    },
    sortDir: {
      type: 'string',
      enum: ['asc', 'desc'],
      description: 'desc (the newest) by default.',
    },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: '20 by default.' },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'nextCursor of the page before, with the same sort (CURSOR_INVALID).',
    },
    format: {
      type: 'string',
      enum: ['json', 'csv'],
      description: 'csv gives a file of every statement of the filter, in the order asked.',
    },
  },
} as const;

const returnCodeField = {
  type: 'string',
  description:
    'The code of the statement the buyer and the admins see: W for a withdrawal, R for a return ' +
    'outside it, the order and the number of the statement in it (W42-2).',
} as const;

const returnListItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    code: returnCodeField,
    orderId: { type: 'integer' },
    order: {
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string' }, returnStatus: returnStatusField },
      required: ['status', 'returnStatus'],
    },
    buyer: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'integer' },
        alive: { type: 'boolean', description: 'False once the account is deleted.' },
      },
      required: ['id', 'alive'],
    },
    contact: {
      type: 'object',
      additionalProperties: false,
      properties: { name: { type: 'string' }, email: { type: 'string' } },
      required: ['name', 'email'],
    },
    statedAt: { type: 'string', format: 'date-time' },
    daysSince: { type: 'integer', description: 'Whole days since the statement.' },
    source: { type: 'string', enum: [...RETURN_SOURCES] },
    basis: { type: 'string', enum: [...RETURN_BASES] },
    reason: { type: ['string', 'null'], enum: [...RETURN_REASONS, null] },
    extendsId: { type: ['integer', 'null'] },
    closedAt: { type: ['string', 'null'], format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    proof: {
      type: 'object',
      additionalProperties: false,
      properties: {
        providedAt: { type: ['string', 'null'], format: 'date-time' },
        confirmedAt: { type: ['string', 'null'], format: 'date-time' },
      },
      required: ['providedAt', 'confirmedAt'],
    },
    acceptedAt: {
      type: ['string', 'null'],
      format: 'date-time',
      description: 'A statement of the form without the code: when an admin accepted it.',
    },
    units: { type: 'integer' },
    amount: { type: 'number', description: 'The money of all the rows.' },
    refundedAmount: { type: 'number', description: 'The money of the rows that went back.' },
    goods: {
      type: 'object',
      additionalProperties: false,
      description: 'The units by what became of the goods.',
      properties: {
        expected: { type: 'integer' },
        received: { type: 'integer', description: 'Back on the shelf, written off or lost.' },
        declined: { type: 'integer', description: 'Not accepted or never arrived.' },
      },
      required: ['expected', 'received', 'declined'],
    },
    money: {
      type: 'object',
      additionalProperties: false,
      description: 'The units by the state of the money.',
      properties: {
        notRefunded: { type: 'integer' },
        pending: { type: 'integer' },
        refunded: { type: 'integer' },
        refused: { type: 'integer' },
        failed: { type: 'boolean', description: 'The last transfer of some row failed.' },
      },
      required: ['notRefunded', 'pending', 'refunded', 'refused', 'failed'],
    },
  },
  required: [
    'id',
    'code',
    'orderId',
    'order',
    'buyer',
    'contact',
    'statedAt',
    'daysSince',
    'source',
    'basis',
    'reason',
    'extendsId',
    'closedAt',
    'updatedAt',
    'proof',
    'acceptedAt',
    'units',
    'amount',
    'refundedAmount',
    'goods',
    'money',
  ],
} as const;

const returnsListResponseSchema = {
  $id: 'returnsListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: returnListItemSchema },
    total: { type: 'integer', description: 'Of the filter, not only of the page.' },
    limit: { type: 'integer' },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'total', 'limit', 'nextCursor'],
} as const;

const returnsShipmentParamsSchema = {
  $id: 'returnsShipmentParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    returnId: idPathParam('the statement'),
    shipmentId: idPathParam('the parcel back'),
  },
  required: ['returnId', 'shipmentId'],
} as const;

const costField = {
  type: 'number',
  minimum: 0,
  maximum: 99_999_999.99,
  multipleOf: 0.01,
  description: 'What the shop paid for the parcel, to the cent.',
} as const;

const returnsShipmentBodySchema = {
  $id: 'returnsShipmentBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    carrier: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'Who carried the parcel.',
    },
    trackingNumber: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'The number of the parcel; needs the carrier.',
    },
    trackingUrl: {
      type: 'string',
      maxLength: 500,
      pattern: '^https://[^\\s]+$',
      description: 'A link to follow the parcel (https); needs the carrier.',
    },
    cost: { ...costField, description: 'What the shop paid; it may be written later.' },
    shippedAt: {
      type: 'string',
      format: 'date-time',
      description:
        'When the parcel was sent back, or the moment it was refused: never of the future, never ' +
        'before the order was paid (RETURN_SHIPMENT_TIME_INVALID). The cost counts in the period ' +
        'of this time.',
    },
  },
  required: ['shippedAt'],
} as const;

const returnsShipmentCostBodySchema = {
  $id: 'returnsShipmentCostBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: { cost: costField },
  required: ['cost'],
} as const;

const returnShipmentSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'A parcel the shop paid to carry the goods back from the buyer: an expense of the period it ' +
    'was sent in.',
  properties: {
    id: { type: 'integer' },
    carrier: { type: ['string', 'null'] },
    trackingNumber: { type: ['string', 'null'] },
    trackingUrl: { type: ['string', 'null'] },
    cost: { type: ['number', 'null'], description: 'None until an admin writes it.' },
    shippedAt: { type: 'string', format: 'date-time' },
    recordedBy: person,
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'carrier',
    'trackingNumber',
    'trackingUrl',
    'cost',
    'shippedAt',
    'recordedBy',
    'createdAt',
  ],
} as const;

const returnsCreateBodySchema = {
  $id: 'returnsCreateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'The order the statement is for.',
    },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: LIST_MAX,
      description: 'The items of the order the statement names, each once, with the units.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          orderItemId: { type: 'integer', minimum: 1, maximum: MAX_ID },
          quantity: {
            type: 'integer',
            minimum: 1,
            maximum: UNITS_MAX,
            description:
              'Whole units: not more than the order bought less what other statements hold.',
          },
        },
        required: ['orderItemId', 'quantity'],
      },
    },
    basis: {
      type: 'string',
      enum: [...RETURN_BASES],
      description:
        'withdrawal: the right the law gives within the period (checked against the period and the ' +
        'rule of each product); other: a return outside it.',
    },
    reason: {
      type: 'string',
      enum: [...RETURN_REASONS],
      description:
        'Why the admin makes it: defect, wrong_item, damaged, goodwill, shop_cancel (a cancel of a ' +
        'paid order by the shop), refused (a parcel refused at the door), other.',
    },
    description: {
      type: 'string',
      maxLength: RETURN_DESCRIPTION_MAX,
      description:
        `The words of the admin, up to ${RETURN_DESCRIPTION_MAX} characters. They are shown to the ` +
        'buyer in the mail that says the shop registered a return: not a place for an internal remark.',
    },
    statedAt: {
      ...dateTime,
      description:
        'A moment of the past the statement states (a parcel refused at the door, at the time the ' +
        'carrier gives); the server dates it now without it. A moment of the future is refused ' +
        '(RETURN_STATED_AT_INVALID).',
    },
    extendsId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'The statement of the same order this one extends.',
    },
  },
  required: ['orderId', 'items', 'basis', 'reason'],
} as const;

const returnsReceiveBodySchema = {
  $id: 'returnsReceiveBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      minItems: 1,
      maxItems: LIST_MAX,
      description:
        'What became of the goods of the rows, all or none. Fewer units than a row holds split it: ' +
        'the units with the result are a row of their own, the rest waits on.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          itemId: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_ID,
            description: 'A row of the statement.',
          },
          quantity: { type: 'integer', minimum: 1, maximum: UNITS_MAX },
          goods: {
            type: 'string',
            enum: [...RETURN_GOODS_RESULTS],
            description:
              'to_stock: back on the shelf, in the batches they were sold from; written_off: ' +
              'came back and went out of the stock at once; not_accepted: the shop does not take ' +
              'them (notAcceptedReason says why), their money is refused; lost: gone on the way ' +
              '(the proof of the buyer must be confirmed first); not_arrived: never came, their ' +
              'money is refused.',
          },
          notAcceptedReason: {
            type: 'string',
            enum: [...RETURN_NOT_ACCEPTED_REASONS],
            description: 'Required with not_accepted, refused with any other result.',
          },
        },
        required: ['itemId', 'quantity', 'goods'],
      },
    },
  },
  required: ['results'],
} as const;

// the rows a request names; none named means all that the action applies to
const itemIdsField = {
  type: 'array',
  minItems: 1,
  maxItems: LIST_MAX,
  uniqueItems: true,
  items: { type: 'integer', minimum: 1, maximum: MAX_ID },
  description:
    'The rows of the statement the action applies to. Without it, all the rows it can apply to.',
} as const;

const noteField = (what: string) =>
  ({
    type: 'string',
    minLength: 1,
    maxLength: RETURN_NOTE_MAX,
    description: what,
  }) as const;

const returnsRefundBodySchema = {
  $id: 'returnsRefundBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    itemIds: itemIdsField,
    reductions: {
      type: 'array',
      minItems: 1,
      maxItems: LIST_MAX,
      description:
        'Root only: lower what a row refunds. The amount is not above what its units cost; ' +
        'lowering it needs a note that says why.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          itemId: { type: 'integer', minimum: 1, maximum: MAX_ID, description: 'A row to refund.' },
          amount: {
            type: 'number',
            minimum: 0,
            maximum: 99_999_999.99,
            description: 'The sum to refund for the row, with up to two decimals.',
          },
          note: noteField('Why the sum is lowered.'),
        },
        required: ['itemId', 'amount'],
      },
    },
    returnShippingDeduction: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 99_999_999.99,
      description:
        'Take the cost of the way back off this transfer, with up to two decimals: only for a ' +
        'withdrawal whose contract says the buyer pays the way back, at most what the parcels of ' +
        'the statement cost the shop less what other transfers took for them, and the transfer ' +
        'stays above 0. An admin or a root.',
    },
  },
} as const;

const returnsRefundOutsideBodySchema = {
  $id: 'returnsRefundOutsideBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    itemIds: itemIdsField,
    method: {
      type: 'string',
      enum: [...RETURN_OUTSIDE_PAYMENT_METHODS],
      description: 'How the money went: a bank transfer, cash or another way.',
    },
    note: noteField('How the money was sent: for the shop, not mailed to the buyer.'),
    at: {
      ...dateTime,
      description:
        'The day the money really went: never of the future and never before the order was paid.',
    },
  },
  required: ['method', 'note', 'at'],
} as const;

const returnsReimbursementBodySchema = {
  $id: 'returnsReimbursementBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    amount: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 99_999_999.99,
      description: 'What the shop paid the buyer back for the carrier, with up to two decimals.',
    },
    method: {
      type: 'string',
      enum: [...RETURN_OUTSIDE_PAYMENT_METHODS],
      description: 'How the money went: a bank transfer, cash or another way.',
    },
    note: noteField('How the money was sent: for the shop, not mailed to the buyer.'),
    at: {
      ...dateTime,
      description:
        'The day the money really went: never of the future and never before the statement.',
    },
  },
  required: ['amount', 'method', 'note', 'at'],
} as const;

const returnsDisputeBodySchema = {
  $id: 'returnsDisputeBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    outcome: {
      type: 'string',
      enum: ['won', 'lost'],
      description:
        'lost: the bank gave the buyer the money (the rows are refunded by chargeback, on the day ' +
        'of at); won: the bank gave the money back to the shop (the rows can be refunded again the ' +
        'usual way).',
    },
    note: noteField('What the bank decided: for the shop, not mailed to the buyer.'),
    at: {
      ...dateTime,
      description:
        'With lost: the day the dispute closed, never of the future and never before the order was ' +
        'paid (RETURN_OUTSIDE_AT_INVALID); the reports count the money in its period.',
    },
  },
  required: ['outcome', 'note'],
} as const;

const returnsCloseBodySchema = {
  $id: 'returnsCloseBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    itemIds: itemIdsField,
    code: {
      type: 'string',
      enum: [...RETURN_ROOT_CLOSE_CODES],
      description:
        'Why the rows are closed without a refund: buyer_changed_mind, not_buyer, ' +
        'goods_not_returned or other. The buyer is told in words; the code does not decide ' +
        'whether the same units can be stated again.',
    },
    note: noteField('For the shop only, not mailed to the buyer.'),
  },
  required: ['code', 'note'],
} as const;

const returnItemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    orderItemId: { type: 'integer' },
    productId: { type: 'integer' },
    variantId: { type: 'integer' },
    name: {
      type: 'string',
      description: 'The name the item went by when the order was confirmed.',
    },
    quantity: { type: 'integer' },
    goods: {
      type: 'string',
      enum: [...RETURN_GOODS],
      description: 'expected until a result is set.',
    },
    notAcceptedReason: { type: ['string', 'null'], enum: [...RETURN_NOT_ACCEPTED_REASONS, null] },
    money: { type: 'string', enum: [...RETURN_MONEY] },
    amount: {
      type: 'number',
      description: 'What the units cost the buyer, lowered by root when amountNote says why.',
    },
    amountNote: { type: ['string', 'null'] },
    deliveryShare: {
      type: 'number',
      description:
        'The part of the delivery that goes back with this row: the row that makes the order ' +
        'whole carries all of it, the others 0.',
    },
    shippingDeduction: {
      type: 'number',
      description:
        'The cost of the way back the buyer owes, taken off the transfer of this row (0 for none).',
    },
    goodsSetAt: nullableDateTime,
    goodsSetBy: person,
    refundId: { type: ['string', 'null'], description: 'The id the provider gave the transfer.' },
    refundedAt: {
      ...nullableDateTime,
      description: 'The day the money went back; for money sent outside the app, the day it went.',
    },
    refundFailure: {
      type: ['object', 'null'],
      additionalProperties: false,
      description:
        'Why the last transfer failed, until it is tried again: card_unavailable (the card ' +
        'can no longer take money: a retry is useless), shop_balance (top up the balance of the ' +
        'shop and retry), disputed (the buyer disputed it at the bank: never send it again), ' +
        'unknown (retry once, then send it outside the app).',
      properties: {
        code: { type: 'string', enum: [...RETURN_REFUND_FAILURES] },
        text: { type: ['string', 'null'], description: 'The words of the provider.' },
      },
      required: ['code', 'text'],
    },
    outside: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'Money root sent outside the app.',
      properties: {
        method: { type: 'string', enum: [...RETURN_OUTSIDE_METHODS] },
        note: { type: 'string' },
        by: person,
      },
      required: ['method', 'note', 'by'],
    },
    refusedCode: {
      type: ['string', 'null'],
      enum: [...RETURN_CLOSE_CODES, null],
      description: 'Why root closed the row without a refund.',
    },
  },
  required: [
    'id',
    'orderItemId',
    'productId',
    'variantId',
    'name',
    'quantity',
    'goods',
    'notAcceptedReason',
    'money',
    'amount',
    'amountNote',
    'deliveryShare',
    'goodsSetAt',
    'goodsSetBy',
    'refundId',
    'refundedAt',
    'refundFailure',
    'outside',
    'refusedCode',
  ],
} as const;

const returnsResponseSchema = {
  $id: 'returnsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    code: returnCodeField,
    orderId: { type: 'integer' },
    extendsId: { type: ['integer', 'null'], description: 'The statement this one extends.' },
    statedAt: { ...dateTime, description: 'The moment the statement states.' },
    source: { type: 'string', enum: [...RETURN_SOURCES] },
    basis: { type: 'string', enum: [...RETURN_BASES] },
    reason: { type: ['string', 'null'], enum: [...RETURN_REASONS, null] },
    description: { type: ['string', 'null'] },
    contact: {
      type: 'object',
      additionalProperties: false,
      description: 'Where the answers go: the name and the email of the statement.',
      properties: { name: { type: 'string' }, email: { type: 'string' } },
      required: ['name', 'email'],
    },
    createdBy: person,
    ip: { type: ['string', 'null'] },
    userAgent: { type: ['string', 'null'] },
    proof: {
      type: 'object',
      additionalProperties: false,
      description:
        'The proof the buyer sent the goods back: given by the buyer (the carrier and the number ' +
        'of the parcel, and a link to follow it), confirmed by an admin.',
      properties: {
        providedAt: nullableDateTime,
        carrier: { type: ['string', 'null'] },
        trackingNumber: { type: ['string', 'null'] },
        trackingUrl: { type: ['string', 'null'] },
        confirmedAt: nullableDateTime,
        confirmedBy: person,
      },
      required: [
        'providedAt',
        'carrier',
        'trackingNumber',
        'trackingUrl',
        'confirmedAt',
        'confirmedBy',
      ],
    },
    acceptedAt: {
      ...nullableDateTime,
      description:
        "A statement of the form without the code: when an admin accepted it as the buyer's " +
        '(POST /api/returns/:returnId/accept). Until then its goods and its money wait ' +
        '(RETURN_NOT_ACCEPTED).',
    },
    acceptedBy: person,
    closedAt: { ...nullableDateTime, description: 'When every row had its result.' },
    closedBy: person,
    closeCode: {
      type: ['string', 'null'],
      enum: [...RETURN_CLOSE_CODES, null],
      description: 'The code of the last time root closed rows without a refund.',
    },
    closeNote: { type: ['string', 'null'] },
    shippingReimbursement: {
      type: ['object', 'null'],
      additionalProperties: false,
      description:
        'The cost of the way back root paid back to the buyer outside the app, none until then.',
      properties: {
        amount: { type: 'number' },
        at: dateTime,
        method: { type: 'string', enum: [...RETURN_OUTSIDE_METHODS] },
        note: { type: 'string' },
        by: person,
      },
      required: ['amount', 'at', 'method', 'note', 'by'],
    },
    createdAt: dateTime,
    updatedAt: dateTime,
    order: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'integer' },
        status: { type: 'string' },
        returnStatus: returnStatusField,
        buyer: {
          type: ['object', 'null'],
          additionalProperties: false,
          description: 'The account of the order; a deleted one has no email.',
          properties: {
            id: { type: 'integer' },
            name: { type: ['string', 'null'] },
            email: { type: ['string', 'null'] },
            deleted: { type: 'boolean' },
          },
          required: ['id', 'name', 'email', 'deleted'],
        },
        recipient: {
          type: ['object', 'null'],
          additionalProperties: false,
          description:
            'To whom and where the order went, as the buyer wrote it at the confirmation (made ' +
            'up after the retention term of a deleted account).',
          properties: {
            method: { type: 'string' },
            firstName: { type: 'string' },
            lastName: { type: 'string' },
            phone: { type: 'string' },
            country: { type: ['string', 'null'] },
            postalCode: { type: ['string', 'null'] },
            city: { type: ['string', 'null'] },
            street: { type: ['string', 'null'] },
            house: { type: ['string', 'null'] },
            apartment: { type: ['string', 'null'] },
            note: { type: ['string', 'null'] },
          },
          required: [
            'method',
            'firstName',
            'lastName',
            'phone',
            'country',
            'postalCode',
            'city',
            'street',
            'house',
            'apartment',
            'note',
          ],
        },
      },
      required: ['id', 'status', 'returnStatus', 'buyer', 'recipient'],
    },
    history: {
      type: 'array',
      description:
        'What was done with the statement: the lines of the journal of the admins that name it, ' +
        'the oldest first (root is hidden from an admin, as in the journals).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          createdAt: dateTime,
          event: { type: 'string' },
          actorRole: { type: ['string', 'null'] },
          actor: person,
          changes: {
            type: 'array',
            items: {
              type: 'object',
              properties: { field: { type: 'string' }, old: {}, new: {} },
              required: ['field'],
            },
          },
        },
        required: ['id', 'createdAt', 'event', 'actorRole', 'actor', 'changes'],
      },
    },
    items: { type: 'array', items: returnItemSchema },
    shipments: { type: 'array', items: returnShipmentSchema },
    deductible: {
      type: 'number',
      minimum: 0,
      description:
        'The most the next transfer may still take off for the way back (returnShippingDeduction of ' +
        'POST /api/returns/:returnId/refund), 0 when it may take none: a withdrawal whose contract ' +
        'says the buyer pays, with rows that wait for their money, the cost of the parcels of the ' +
        'statement less what the transfers sent took for them. A hint: the admin decides.',
    },
    warnings: {
      type: 'array',
      items: { type: 'string', enum: ['shop_paid_parcel'] },
      description:
        'What the admin should see before acting. shop_paid_parcel: the shop paid a parcel of the ' +
        'statement back, so a reimbursement of the way back to the buyer would pay for it twice; ' +
        'it is still allowed (the buyer may have sent two parcels), the front asks first.',
    },
  },
  required: [
    'id',
    'code',
    'orderId',
    'extendsId',
    'statedAt',
    'source',
    'basis',
    'reason',
    'description',
    'contact',
    'createdBy',
    'ip',
    'userAgent',
    'proof',
    'acceptedAt',
    'acceptedBy',
    'closedAt',
    'closedBy',
    'closeCode',
    'closeNote',
    'shippingReimbursement',
    'createdAt',
    'updatedAt',
    'order',
    'history',
    'items',
    'shipments',
    'deductible',
    'warnings',
  ],
} as const;

export const returnsDtoSchemas = [
  returnsListQuerySchema,
  returnsListResponseSchema,
  returnsParamsSchema,
  returnsShipmentParamsSchema,
  returnsShipmentBodySchema,
  returnsShipmentCostBodySchema,
  returnsCreateBodySchema,
  returnsReceiveBodySchema,
  returnsRefundBodySchema,
  returnsRefundOutsideBodySchema,
  returnsReimbursementBodySchema,
  returnsDisputeBodySchema,
  returnsCloseBodySchema,
  returnsResponseSchema,
];
