import { parcelSumsProperties, receiveParcelField } from '@schemas/parcelFields.js';
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
  RETURN_REASONS,
  RETURN_SOURCES,
  RETURN_STATUSES,
  MONEY_PARTS,
  MONEY_PURPOSES,
  OUTSIDE_METHODS,
  REFUND_FAILURES,
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
    moneyHeld: {
      type: 'boolean',
      description:
        'true: the money of the statement waits for the bank or for root, not for the shop: a ' +
        'dispute of the payment of the order is open at the bank, or money of the payment waits ' +
        'for root to say what it was for: a refund made by hand in the dashboard of the provider, ' +
        'what a bank took for a dispute lost on an order sent (a transfer is refused meanwhile, ' +
        'RETURN_REFUND_DISPUTED, RETURN_HAND_REFUND_PENDING, RETURN_BANK_MONEY_PENDING); false: the ' +
        'others.',
    },
    moneyShort: {
      type: 'boolean',
      description:
        'true: a transfer of what the statement owes now would ask the provider for more than is ' +
        'left of the payment, money already with the buyer taken off, or the way back does not fit ' +
        'in it with them beside the money the other statements of the order still owe (`moneyLeft` ' +
        'of the card): it waits for them, or goes outside the app ' +
        '(`POST /api/returns/{returnId}/refund/outside`); false: the others.',
    },
    moneyOverpaid: {
      type: 'boolean',
      description:
        'true: money already with the buyer (a refund made by hand, what a bank took, by the ' +
        'decisions on them) gave goods of the order that came back more than its statements, all ' +
        'over, took (a row lowered or refused): the buyer had more than the shop owed. Root records ' +
        'what the buyer gave back (`POST /api/returns/{returnId}/money-received`) or puts the case ' +
        'aside; false: the others.',
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
    moneyLeft: {
      type: ['number', 'null'],
      description:
        'What an open statement still has to send the buyer: the rows owed, the delivery that ' +
        'goes with them and the way back the shop pays (the total of moneyLeft of its card). ' +
        'Null for a closed statement.',
    },
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
    'moneyLeft',
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
    direction: {
      type: 'string',
      enum: ['to_shop', 'to_buyer'],
      description:
        'to_shop: the parcel the goods of the statement come back in (one a statement, while goods ' +
        'are on their way to the shop); to_buyer: goods the shop did not accept go back to the buyer ' +
        '(with `items`).',
    },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: LIST_MAX,
      description:
        'The rows of goods not accepted a parcel to the buyer carries, and their units: fewer ' +
        'units than a row holds split it. Only with to_buyer (RETURN_ITEMS_NOT_ALLOWED).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          itemId: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_ID,
            description: 'A row of the statement whose goods were not accepted.',
          },
          quantity: { type: 'integer', minimum: 1, maximum: UNITS_MAX },
        },
        required: ['itemId', 'quantity'],
      },
    },
    carrier: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'Who carries the parcel.',
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
        'When the parcel was sent, or the moment it was refused: never of the future, never ' +
        'before the order was paid (RETURN_SHIPMENT_TIME_INVALID). The cost is a line of the ' +
        'money journal and counts in the period it is written.',
    },
  },
  required: ['direction', 'shippedAt'],
} as const;

const returnsShipmentCostBodySchema = {
  $id: 'returnsShipmentCostBodySchema',
  type: 'object',
  additionalProperties: false,
  description: 'One of the two: what the shop paid the carrier, or what the buyer paid it.',
  properties: {
    cost: costField,
    buyerPaid: {
      type: 'number',
      minimum: 0,
      maximum: 99_999_999.99,
      multipleOf: 0.01,
      description:
        'What the buyer paid the carrier for the parcel back to the shop, as the receipt says: ' +
        'corrects the sum set when the parcel was confirmed, while no money of the way back went. ' +
        'The page shows the sum the buyer told beside the field, never in it.',
    },
  },
  oneOf: [{ required: ['cost'] }, { required: ['buyerPaid'] }],
} as const;

const returnParcelSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'A parcel of the statement: the goods on their way back to the shop (one a statement: the one ' +
    'the buyer told of, or the one the shop sent for them) or the goods the shop did not accept ' +
    'sent back to the buyer. What the shop paid the carrier is an expense of the period it was ' +
    'written in.',
  properties: {
    id: { type: 'integer' },
    direction: { type: 'string', enum: ['to_shop', 'to_buyer'] },
    carrier: { type: ['string', 'null'] },
    trackingNumber: { type: ['string', 'null'] },
    trackingUrl: { type: ['string', 'null'] },
    shippedAt: {
      type: 'string',
      format: 'date-time',
      description:
        'When the parcel was sent: when the buyer told of it, or the time the admin gave (a parcel ' +
        'refused at the door: the moment of the refusal).',
    },
    recordedBy: {
      ...person,
      description: 'Who wrote it: an admin, or the buyer of an account; none for the public form.',
    },
    confirmedAt: {
      ...nullableDateTime,
      description:
        'A parcel to the shop: when an admin confirmed it (the money may then go before the goods ' +
        'arrive); none until then.',
    },
    confirmedBy: person,
    buyerPaid: {
      type: ['number', 'null'],
      description:
        'A parcel to the shop: what the buyer paid the carrier, as they told it or as the admin ' +
        'set it from the receipt; none when nobody told it.',
    },
    cost: {
      type: ['number', 'null'],
      description:
        'What the shop paid the carrier, from the money journal (the first cost and its ' +
        'corrections); none until an admin writes one above 0.',
    },
    itemIds: {
      type: 'array',
      items: { type: 'integer' },
      description: 'The rows a parcel to the buyer carried back; none for a parcel to the shop.',
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'direction',
    'carrier',
    'trackingNumber',
    'trackingUrl',
    'shippedAt',
    'recordedBy',
    'confirmedAt',
    'confirmedBy',
    'buyerPaid',
    'cost',
    'itemIds',
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
              '(the parcel must be confirmed); not_arrived: never came, their ' +
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
    parcel: receiveParcelField,
  },
  required: ['results'],
} as const;

const returnsConfirmProofBodySchema = {
  $id: 'returnsConfirmProofBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: parcelSumsProperties,
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
      enum: [...OUTSIDE_METHODS],
      description: 'How the money went: a bank transfer, cash or another way.',
    },
    note: noteField('How the money was sent: for the shop, not mailed to the buyer.'),
    at: {
      ...dateTime,
      description:
        'The day the money really went: never of the future and never before the order was paid.',
    },
    returnShippingDeduction: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 99_999_999.99,
      description:
        'The cost of the way back the buyer owes, taken off as with a transfer (a withdrawal whose ' +
        'contract says the buyer pays it).',
    },
  },
  required: ['method', 'note', 'at'],
} as const;

const returnsMoneyReceivedBodySchema = {
  $id: 'returnsMoneyReceivedBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'method', 'note', 'at'],
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description:
        'The rows of the statement the money came back for, each once, with the money: at most what ' +
        'a row cost less what came back for it already.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['itemId', 'amount'],
        properties: {
          itemId: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_ID,
            description: 'A row of the statement.',
          },
          amount: {
            type: 'number',
            exclusiveMinimum: 0,
            maximum: 99_999_999.99,
            multipleOf: 0.01,
            description: 'The money that came back for it, to the cent.',
          },
        },
      },
    },
    method: {
      type: 'string',
      enum: [...OUTSIDE_METHODS],
      description: 'How the money came: a bank transfer, cash or another way.',
    },
    note: noteField('How the money came: for the shop.'),
    at: {
      ...dateTime,
      description:
        'The day the money really came: never of the future, never before the statement.',
    },
  },
} as const;

const returnsOverpaidReceivedBodySchema = {
  $id: 'returnsOverpaidReceivedBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['amount', 'method', 'note', 'at'],
  properties: {
    amount: {
      type: 'number',
      exclusiveMinimum: 0,
      maximum: 99_999_999.99,
      multipleOf: 0.01,
      description: 'What the buyer gave back, to the cent: at most what is overpaid.',
    },
    method: {
      type: 'string',
      enum: [...OUTSIDE_METHODS],
      description: 'How the money came: a bank transfer, cash or another way.',
    },
    note: noteField('How the money came: for the shop.'),
    at: {
      ...dateTime,
      description:
        'The day the money really came: never of the future, never before the money went to the ' +
        'buyer.',
    },
  },
} as const;

const returnsOverpaidLostBodySchema = {
  $id: 'returnsOverpaidLostBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['note'],
  properties: {
    note: noteField('Why the shop gives the money up: for the shop.'),
  },
} as const;

const returnsKeepBodySchema = {
  $id: 'returnsKeepBodySchema',
  type: 'object',
  additionalProperties: false,
  required: ['items', 'note'],
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description:
        'The rows of goods not accepted the shop keeps, each once, with what becomes of the goods.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['itemId', 'goods'],
        properties: {
          itemId: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_ID,
            description: 'A row of the statement whose goods were not accepted.',
          },
          goods: {
            type: 'string',
            enum: ['to_stock', 'written_off'],
            description: 'Back on the shelf, or written off (in and out at once).',
          },
        },
      },
    },
    note: noteField('Why the shop keeps the goods: for the shop.'),
  },
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
    paid: {
      type: 'number',
      description:
        'What the buyer has had of the amount: the transfers sent or on their way and the money ' +
        'sent outside the app. A transfer sends what is left of the payment, so a row may be paid ' +
        'in parts ("paid X of Y"): the rest goes outside the app, and the row is refunded once ' +
        'the parts give all of it.',
    },
    amountNote: { type: ['string', 'null'] },
    goodsSetAt: nullableDateTime,
    goodsSetBy: person,
    moneyLogId: {
      type: ['integer', 'null'],
      description:
        'The line of the money journal that put the money of the row where it is (the goods of ' +
        'its transfer, the money sent outside the app, or the failure): one of `money`.',
    },
    refundFailure: {
      type: ['object', 'null'],
      additionalProperties: false,
      description:
        'Why the last transfer failed (money failed), until it is tried again: card_unavailable ' +
        '(the card can no longer take money: a retry is useless), shop_balance (top up the ' +
        'balance of the shop and retry), disputed (the buyer disputed the payment at the bank: ' +
        'the bank settles it), already_refunded (the money of the payment went back already, by ' +
        'hand in the dashboard), unknown (retry once, then send it outside the app).',
      properties: {
        code: { type: 'string', enum: [...REFUND_FAILURES] },
        text: { type: ['string', 'null'], description: 'The words of the provider.' },
      },
      required: ['code', 'text'],
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
    'paid',
    'amountNote',
    'goodsSetAt',
    'goodsSetBy',
    'moneyLogId',
    'refundFailure',
    'refusedCode',
  ],
} as const;

// a movement of the money of a statement, a line of the money journal (db/05, money_log)
const returnMoneyMoveSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer', description: 'The line of the money journal.' },
    event: {
      type: 'string',
      description:
        'money.refund (a transfer, in parts, or a refund made by hand tied to the statement), ' +
        'money.refund_failed (its failure, the sum back), money.outside (sent outside the app), ' +
        'money.return_parcel_cost (what a ' +
        'parcel back cost the shop), money.correction (a cost corrected), money.dispute_withdrawn ' +
        '(what the bank gave the buyer for a dispute, tied to the statement).',
    },
    purpose: { type: 'string', enum: [...MONEY_PURPOSES] },
    part: {
      type: 'string',
      enum: [...MONEY_PARTS],
      description:
        'goods, delivery: what goes back; deduction: kept for the way back; covered: what money ' +
        'already sent another way covered; whole: a movement without parts.',
    },
    amount: {
      type: 'number',
      description: 'Signed: above 0 to the shop, below 0 to the buyer or to a carrier.',
    },
    currency: { type: ['string', 'null'] },
    state: {
      type: ['string', 'null'],
      enum: ['in_transit', 'sent', null],
      description: 'Where a refund stands; null for any other line.',
    },
    stateAt: { ...nullableDateTime, description: 'Since when it stands there.' },
    createdAt: { ...dateTime, description: 'When it was written: the day of the reports.' },
    happenedAt: {
      ...nullableDateTime,
      description: 'The day a person wrote the money really went (outside the app).',
    },
    refundId: { type: ['string', 'null'], description: 'The refund at the provider.' },
    bankReference: {
      type: ['string', 'null'],
      description: 'The number the bank of the buyer knows the refund by.',
    },
    byDashboard: {
      type: 'boolean',
      description: 'Made by hand in the dashboard of the provider, not by this server.',
    },
    failure: { type: ['string', 'null'], enum: [...REFUND_FAILURES, null] },
    failureText: { type: ['string', 'null'], description: 'The words of the provider.' },
    method: { type: ['string', 'null'], enum: [...OUTSIDE_METHODS, null] },
    note: { type: ['string', 'null'], description: 'The note of root, for the shop.' },
    coversId: {
      type: ['integer', 'null'],
      description: 'The line this one reverses, corrects or uses.',
    },
    shipmentId: { type: ['integer', 'null'], description: 'The parcel back of a cost.' },
    by: { ...person, description: 'Who wrote it; null for the work of the system.' },
  },
  required: [
    'id',
    'event',
    'purpose',
    'part',
    'amount',
    'currency',
    'state',
    'stateAt',
    'createdAt',
    'happenedAt',
    'refundId',
    'bankReference',
    'byDashboard',
    'failure',
    'failureText',
    'method',
    'note',
    'coversId',
    'shipmentId',
    'by',
  ],
} as const;

const returnsSplitBodySchema = {
  $id: 'returnsSplitBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      minItems: 1,
      maxItems: LIST_MAX,
      description:
        'The rows and the units that go into the new statement: rows whose goods wait and whose ' +
        'money did not move; fewer units than a row holds split it. The statement keeps a row.',
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
        },
        required: ['itemId', 'quantity'],
      },
    },
  },
  required: ['items'],
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
    splitFromId: {
      type: ['integer', 'null'],
      description:
        'The statement this one was split from: its units went back in a parcel of their own.',
    },
    splitIds: {
      type: 'array',
      items: { type: 'integer' },
      description: 'The statements split from this one.',
    },
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
    refundedTotal: {
      type: 'number',
      description:
        'How much of the money went back to the buyer by this statement in all: what the ' +
        'transfers sent or have on their way less what failed, the money sent outside the app, the way back paid ' +
        'back, what a refund made by hand or the bank covered. The database counts it from the ' +
        'money journal.',
    },
    disputeOpen: {
      type: 'boolean',
      description:
        'A dispute of the payment of the order is open at the bank: a transfer waits for its end ' +
        '(RETURN_REFUND_DISPUTED) unless the provider lets the payment be refunded.',
    },
    handRefundPending: {
      type: 'boolean',
      description:
        'A refund of the payment made by hand in the dashboard of the provider waits for root to ' +
        'say what it was: no transfer goes until then (RETURN_HAND_REFUND_PENDING).',
    },
    bankMoneyPending: {
      type: 'boolean',
      description:
        'What a bank took for a dispute lost on an order sent waits for root to say what it was for ' +
        '(`POST /api/payments/money-lines/{moneyLogId}/decision`): no transfer goes until then ' +
        '(RETURN_BANK_MONEY_PENDING).',
    },
    moneyLeft: {
      type: 'object',
      additionalProperties: false,
      required: ['rows', 'delivery', 'wayBack', 'total', 'due', 'covered', 'paymentLeft', 'short'],
      description:
        'What the statement still owes the buyer: the rows whose money is owed (never sent, or ' +
        'whose transfer failed), the delivery that goes with them and the way back the shop pays ' +
        '(total). due: of it, what a transfer takes now (the goods in, lost, or on their way with ' +
        'the parcel confirmed). covered: what money already with the buyer pays of that (a refund ' +
        'made by hand, what a bank took, by the decisions on them: "the bank already gave X for ' +
        'these goods"). paymentLeft: what the provider can still give back of the payment. short: a ' +
        'transfer of what is due would ask the provider for more than that, or the way back does ' +
        'not fit in it with them beside the money the other statements of the order still owe: it ' +
        'waits for them, or goes outside the app; left alone (no row owed), it goes by a transfer ' +
        'of its own once it fits. A statement that gave the buyer money for goods stays open while ' +
        'the way back is owed.',
      properties: {
        rows: { type: 'number' },
        delivery: { type: 'number' },
        wayBack: { type: 'number' },
        total: { type: 'number' },
        due: { type: 'number' },
        covered: { type: 'number' },
        paymentLeft: { type: 'number' },
        short: { type: 'boolean' },
      },
    },
    moneyOverpaid: {
      type: 'number',
      description:
        'What money already with the buyer (a refund made by hand, what a bank took, by the ' +
        'decisions on them) gave the goods of the order more than its statements took: the items ' +
        'whose every unit came back in statements that are over, a row refused or lowered. 0 when ' +
        'none. Root or an admin with the right of the money records what the buyer gave back ' +
        '(`POST /api/returns/{returnId}/overpaid/received`), gives it up ' +
        '(`POST /api/returns/{returnId}/overpaid/lost`), or keeps the goods not accepted that are ' +
        'still in the shop (`POST /api/returns/{returnId}/keep`).',
    },
    money: {
      type: 'array',
      items: returnMoneyMoveSchema,
      description: 'The movements of the money of the statement, the oldest first.',
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
    parcels: {
      type: 'array',
      items: returnParcelSchema,
      description:
        'The parcels of the statement in the order they were recorded: the parcel to the shop (one a ' +
        'statement; the proof the goods went back) and the parcels to the buyer.',
    },
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
      items: { type: 'string', enum: ['shop_paid_parcel', 'buyer_paid_over_total'] },
      description:
        'What the admin should see before acting. shop_paid_parcel: the shop paid the carrier for ' +
        'the parcel of the goods back to the shop: no way back is owed to the buyer (the money left ' +
        'has none), and a withdrawal whose contract makes the buyer pay it may have it taken off the ' +
        'transfer (returnShippingDeduction). buyer_paid_over_total: what the buyer paid the ' +
        'carrier for the parcel back is more than the order cost: a typo to check before money goes.',
    },
  },
  required: [
    'id',
    'code',
    'orderId',
    'extendsId',
    'splitFromId',
    'splitIds',
    'statedAt',
    'source',
    'basis',
    'reason',
    'description',
    'contact',
    'createdBy',
    'ip',
    'userAgent',
    'acceptedAt',
    'acceptedBy',
    'closedAt',
    'closedBy',
    'closeCode',
    'closeNote',
    'createdAt',
    'updatedAt',
    'order',
    'history',
    'items',
    'parcels',
    'deductible',
    'warnings',
    'refundedTotal',
    'disputeOpen',
    'handRefundPending',
    'bankMoneyPending',
    'moneyLeft',
    'moneyOverpaid',
    'money',
  ],
} as const;

export const returnsDtoSchemas = [
  returnsListQuerySchema,
  returnsListResponseSchema,
  returnsParamsSchema,
  returnsShipmentParamsSchema,
  returnsShipmentBodySchema,
  returnsShipmentCostBodySchema,
  returnsSplitBodySchema,
  returnsCreateBodySchema,
  returnsReceiveBodySchema,
  returnsConfirmProofBodySchema,
  returnsRefundBodySchema,
  returnsRefundOutsideBodySchema,
  returnsMoneyReceivedBodySchema,
  returnsOverpaidReceivedBodySchema,
  returnsOverpaidLostBodySchema,
  returnsKeepBodySchema,
  returnsCloseBodySchema,
  returnsResponseSchema,
];
