import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const person = { id: 3, name: 'Admin', email: 'admin@example.com' };

const returnExample = {
  id: 12,
  code: 'R42-1',
  orderId: 42,
  extendsId: null,
  statedAt: '2026-11-02T10:00:00.000Z',
  source: 'admin',
  basis: 'other',
  reason: 'defect',
  description: 'The box came open.',
  contact: { name: 'Anna Koval', email: 'anna@example.com' },
  createdBy: person,
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  proof: {
    providedAt: null,
    carrier: null,
    trackingNumber: null,
    trackingUrl: null,
    confirmedAt: null,
    confirmedBy: null,
  },
  acceptedAt: null,
  acceptedBy: null,
  closedAt: null,
  closedBy: null,
  closeCode: null,
  closeNote: null,
  createdAt: '2026-11-02T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
  shippingReimbursement: null,
  order: {
    id: 42,
    status: 'shipped',
    returnStatus: 'open',
    buyer: { id: 7, name: 'Anna Koval', email: 'anna@example.com', deleted: false },
    recipient: {
      method: 'manual',
      firstName: 'Anna',
      lastName: 'Koval',
      phone: '+380501234567',
      country: 'UA',
      postalCode: '01001',
      city: 'Kyiv',
      street: 'Khreshchatyk',
      house: '1',
      apartment: null,
      note: null,
    },
  },
  history: [
    {
      id: 901,
      createdAt: '2026-11-02T10:05:00.000Z',
      event: 'return.create',
      actorRole: 'ADMIN',
      actor: person,
      changes: [{ field: 'returnId', old: null, new: 12 }],
    },
  ],
  shipments: [],
  deductible: 0,
  warnings: [],
  items: [
    {
      id: 31,
      orderItemId: 77,
      productId: 5,
      variantId: 9,
      name: 'Desk lamp',
      quantity: 2,
      goods: 'expected',
      notAcceptedReason: null,
      money: 'not_refunded',
      amount: 49.98,
      amountNote: null,
      deliveryShare: 0,
      shippingDeduction: 0,
      goodsSetAt: null,
      goodsSetBy: null,
      refundId: null,
      refundedAt: null,
      refundFailure: null,
      outside: null,
      refusedCode: null,
    },
  ],
};

const createBodyExample = {
  orderId: 42,
  items: [{ orderItemId: 77, quantity: 2 }],
  basis: 'other',
  reason: 'defect',
  description: 'The box came open.',
};

const receiveBodyExample = {
  results: [
    { itemId: 31, quantity: 1, goods: 'to_stock' },
    { itemId: 31, quantity: 1, goods: 'not_accepted', notAcceptedReason: 'unsealed' },
  ],
};

const refundBodyExample = { itemIds: [31] };

const refundOutsideBodyExample = {
  itemIds: [31],
  method: 'bank_transfer',
  note: 'Sent to the account the buyer gave by mail.',
  at: '2026-11-03T09:30:00.000Z',
};

const reimbursementBodyExample = {
  amount: 6.5,
  method: 'bank_transfer',
  note: 'The receipt of the carrier came by mail.',
  at: '2026-11-03T09:30:00.000Z',
};

const disputeBodyExample = {
  outcome: 'lost',
  note: 'Stripe: the bank closed the dispute for the buyer.',
  at: '2026-11-03T09:30:00.000Z',
};

const closeBodyExample = {
  code: 'goods_not_returned',
  note: 'The goods never came, the buyer did not answer.',
};

const paramsExample = { returnId: '12' };

const shipmentBodyExample = {
  carrier: 'DHL',
  trackingNumber: 'JD0146000123',
  trackingUrl: 'https://track.example.com/JD0146000123',
  cost: 4.5,
  shippedAt: '2026-11-03T09:30:00.000Z',
};

const shipmentParamsExample = { returnId: '12', shipmentId: '3' };

const postReturnSchema = {
  operationId: 'createReturn',
  summary: 'Make a statement of withdrawal or of return',
  description:
    'An admin or a root makes a statement for the items of a paid, shipped or delivered order: a ' +
    'withdrawal the buyer made outside the shop, or a return outside the withdrawal (`basis` ' +
    'other: a defect, a wrong item, damage, goodwill). Two reasons cancel the order. ' +
    '`shop_cancel` (`basis` other, a paid order that was not sent): the shop cancels it; the ' +
    'goods come back to the stock at once, in the batches they were sold from, the order is ' +
    'cancelled when all of it is back, and the money goes back at once in the three steps of a ' +
    'refund (the card answers with the result; a refund that could not be started is logged and ' +
    'the rows wait for `POST /api/returns/:returnId/refund`). `refused` (`basis` withdrawal, a ' +
    'shipped order, `statedAt` required: the moment the carrier gives, not before the send and ' +
    'not of the future): the buyer refused the parcel; it takes whatever is left of the order, ' +
    'whatever items were named and whatever the right of withdrawal of their products (the ' +
    'money is a decision of the admin), and waits for the parcel and then for its money; the ' +
    'order cannot become delivered while the statement is open, and is cancelled when the ' +
    'parcel is back with all the money and the delivery. A statement of withdrawal takes no item whose product has no right of withdrawal, and ' +
    'for a delivered order only until the end of the period (the days of the contract the order ' +
    'kept and the days of grace). Each item is named once, with whole units: not more than the ' +
    'order bought less what other statements hold (the units of a row whose money was refused ' +
    'come free again). The statement goes to the buyer of the order: the name and the email of ' +
    'the account are the ones its answers go to, and the buyer is mailed that the shop ' +
    'registered a return. An extension is a statement of its own that points at the one it ' +
    'extends (`extendsId`). The answer is the card of the statement.',

  body: { $ref: 'returnsCreateBodySchema#', examples: [createBodyExample] },

  response: {
    201: {
      description: 'The statement was made: its card.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); no items (RETURN_ITEMS_REQUIRED), an ' +
        'item that is not a whole number or is named wrong (RETURN_ITEMS_INVALID), an item named ' +
        'twice (RETURN_ITEMS_REPEATED), units that are not whole units above 0 ' +
        '(RETURN_QUANTITY_INVALID), a statement to extend that is not one of the same order ' +
        '(RETURN_EXTENDS_INVALID), a moment of the future or before the order was paid ' +
        '(RETURN_STATED_AT_INVALID), no name or email of the buyer to answer to ' +
        '(RETURN_CONTACT_REQUIRED), a reason that does not go with the basis ' +
        '(RETURN_REASON_INVALID: shop_cancel needs the basis other, refused the basis withdrawal).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The order is not there (RETURN_ORDER_NOT_FOUND), or an item is not one of the order ' +
        '(RETURN_ITEM_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The order is not paid, shipped or delivered, or not in the state the reason needs ' +
        '(RETURN_ORDER_NOT_RETURNABLE: shop_cancel is for a paid order, refused for a shipped ' +
        'one); more units ' +
        'than are left (RETURN_QUANTITY_EXCEEDED); a statement of withdrawal for an item that has ' +
        'no right of withdrawal (RETURN_ITEM_NOT_RETURNABLE); a withdrawal after the period of a ' +
        'delivered order (RETURN_PERIOD_OVER).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const getReturnSchema = {
  operationId: 'getReturn',
  summary: 'Get a statement of withdrawal or of return',
  description:
    'The card of a statement for an admin or a root: what was stated, when, by whom and from ' +
    'where (the address and the browser of the request), the name and the email the answers go ' +
    'to, the proof of the buyer, the rows with the state of their goods and of their money, and ' +
    'where the order stands (`order.returnStatus`).',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },

  response: {
    200: {
      description: 'The card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    404: {
      description: 'The statement is not there (RETURN_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postReceiveItemsSchema = {
  operationId: 'receiveReturnItems',
  summary: 'Set what became of the goods of a statement',
  description:
    'An admin or a root sets the result of the goods of the rows of a statement, all the results ' +
    'or none. Fewer units than a row holds split it: the units with the result are a row of ' +
    'their own, the rest waits on, so one unit may come late or be refused alone. The units that ' +
    '`to_stock` go back into the stock and into the batches they were sold from; `written_off` ' +
    'and `lost` come back and go out at once (a line of the stock log for each); `lost` needs the ' +
    'proof of the buyer confirmed first (POST /api/returns/{returnId}/proof/confirm); ' +
    '`not_accepted` (with `notAcceptedReason`) and `not_arrived` refuse the money of the row with ' +
    'the goods; goods paid ahead that never came are `not_arrived` with their money left refunded ' +
    '(the shop gets it back outside the app). A statement of the form without the code is handled ' +
    'once an admin accepted it (POST /api/returns/{returnId}/accept). The statement is closed when ' +
    'every row has its goods and its money settled, and `order.returnStatus` follows. The answer is ' +
    'the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'returnsReceiveBodySchema#', examples: [receiveBodyExample] },

  response: {
    200: {
      description: 'The results were set: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); no results (RETURN_ITEMS_REQUIRED), a ' +
        'row that is not a whole number (RETURN_ITEMS_INVALID), units that are not whole units ' +
        'above 0 (RETURN_QUANTITY_INVALID), goods there are not or a reason with goods that take ' +
        'none (RETURN_GOODS_INVALID), a refusal to accept without its reason ' +
        '(RETURN_NOT_ACCEPTED_REASON_REQUIRED).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The statement is not there (RETURN_NOT_FOUND), or a row is not one of it (RETURN_ITEM_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A row that has its result already (RETURN_ITEM_NOT_EXPECTED); more units than the row ' +
        'holds (RETURN_QUANTITY_EXCEEDED); goods lost before the proof is confirmed ' +
        '(RETURN_PROOF_REQUIRED); goods refused for a row whose money is on its way or back ' +
        '(RETURN_ITEM_MONEY_SETTLED); the order is cancelled, a cancel puts the units back itself ' +
        '(RETURN_ORDER_NOT_RETURNABLE); the order did not take so many units from batches ' +
        '(RETURN_ALLOCATIONS_MISSING); a statement of the form without the code no admin accepted yet (RETURN_NOT_ACCEPTED).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postConfirmProofSchema = {
  operationId: 'confirmReturnProof',
  summary: 'Confirm the proof of a statement',
  description:
    'An admin or a root confirms the proof the buyer sent the goods back, once. The admin may ' +
    'confirm it without a number from the buyer (a letter with the photos of the parcel and of ' +
    'the goods): the decision is theirs. Goods lost on the way need it. The answer is the card of ' +
    'the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },

  response: {
    200: {
      description: 'The proof was confirmed: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    404: {
      description: 'The statement is not there (RETURN_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The proof was confirmed already (RETURN_PROOF_ALREADY_CONFIRMED); a statement of the form without the code no admin accepted yet (RETURN_NOT_ACCEPTED).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postRefundSchema = {
  operationId: 'refundReturn',
  summary: 'Give the money of a statement back',
  description:
    'An admin or a root gives the money of the rows of a statement back to the buyer, through the ' +
    'provider that took the payment. The rows must have come back (to the shelf, written off, or ' +
    'lost with the proof confirmed), or wait for their goods with the proof of the buyer ' +
    'confirmed. Without `itemIds` all the rows that can be refunded go in one transfer; the sum ' +
    'is the sum of the rows, a row the buyer disputed at the bank is never sent again, and the ' +
    'delivery goes back, all of it, with the transfer that makes ' +
    'the order whole (no unit left that was not accepted or did not arrive). Only a root lowers ' +
    'what a row refunds (`reductions`). The transfer runs in three steps: the rows are put on ' +
    'their way, the provider is asked, the rows are settled by its answer. A refund that the ' +
    'provider has not decided on (or did not answer) leaves the rows `pending`: the provider ' +
    'tells the end by its event, and a worker asks again with the same key. A refund the ' +
    'provider refuses leaves the rows `not_refunded` with `refundFailure`, and the request still ' +
    'answers 200: the card says what to do. When the money is back the buyer is mailed. The ' +
    'answer is the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'returnsRefundBodySchema#', examples: [refundBodyExample] },

  response: {
    200: {
      description: 'The transfer was made or is on its way: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); no row can be refunded ' +
        '(RETURN_ITEMS_REQUIRED), a sum that is not a number or above the price of the units ' +
        '(RETURN_AMOUNT_INVALID), a lowered sum without its note (RETURN_AMOUNT_NOTE_REQUIRED), ' +
        'a row lowered twice (RETURN_ITEMS_REPEATED), nothing to send (RETURN_REFUND_AMOUNT_INVALID), ' +
        'a deduction of the way back that is not a sum above 0 or leaves nothing to send ' +
        '(RETURN_DEDUCTION_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        'Only a root lowers what a row refunds (RETURN_FORBIDDEN), and only an admin or a root refunds.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The statement is not there (RETURN_NOT_FOUND), or a row is not one of it (RETURN_ITEM_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A row whose goods were not accepted or did not arrive, or whose money is on its way or ' +
        'back (RETURN_ITEM_NOT_REFUNDABLE); goods that still wait without the proof confirmed ' +
        '(RETURN_PROOF_REQUIRED); a row whose transfer the buyer disputed at the bank: the bank ' +
        'gives the money back (RETURN_REFUND_DISPUTED); more than the order was paid ' +
        '(RETURN_REFUND_EXCEEDS_PAID); the order was never paid (RETURN_ORDER_NOT_RETURNABLE); a ' +
        'deduction of the way back for a statement outside the withdrawal or a contract that ' +
        'does not say the buyer pays (RETURN_DEDUCTION_NOT_ALLOWED), or above what the parcels of ' +
        'the statement cost the shop (RETURN_DEDUCTION_EXCEEDS_COST); a statement of the form without the code no admin accepted yet (RETURN_NOT_ACCEPTED).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postRefundOutsideSchema = {
  operationId: 'refundReturnOutside',
  summary: 'Record money sent outside the app',
  description:
    'A root records that the money of rows whose transfer failed went back outside the app (a ' +
    'bank transfer, cash, another way), on the day it really went. Only rows whose last transfer ' +
    'failed, and never one the buyer disputed at the bank (`disputed`): the bank settles that. ' +
    'The sum is the sum of the rows, the day is the day of the money in the reports. The buyer is ' +
    'mailed. The answer is the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'returnsRefundOutsideBodySchema#', examples: [refundOutsideBodyExample] },

  response: {
    200: {
      description: 'The money was recorded: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); no failed row to record ' +
        '(RETURN_ITEMS_REQUIRED), no method or note (RETURN_OUTSIDE_NOTE_REQUIRED), a day of the ' +
        'future or before the order was paid (RETURN_OUTSIDE_AT_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The statement is not there (RETURN_NOT_FOUND), or a row is not one of it (RETURN_ITEM_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A row whose last transfer did not fail (RETURN_ITEM_NOT_FAILED); a transfer the buyer ' +
        'disputed at the bank (RETURN_REFUND_DISPUTED).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postReimbursementSchema = {
  operationId: 'recordReturnReimbursement',
  summary: 'Record the cost of the way back paid back to the buyer',
  description:
    'A root records that the shop paid the buyer back what they paid the carrier to send the goods ' +
    'back, outside the app (a payment of the card is never more than the order was paid): only ' +
    'when the shop pays the way back (a statement outside the withdrawal, or a contract that does ' +
    'not say the buyer pays), once a statement. The day it went is the day of the expense in the ' +
    'reports. The buyer is mailed. The answer is the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'returnsReimbursementBodySchema#', examples: [reimbursementBodyExample] },

  response: {
    200: {
      description: 'The money was recorded: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); a sum that is not above 0 ' +
        '(RETURN_REIMBURSEMENT_INVALID), no method or note (RETURN_OUTSIDE_NOTE_REQUIRED), a day ' +
        'of the future or before the statement (RETURN_OUTSIDE_AT_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'The statement is not there (RETURN_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The buyer pays the way back of this withdrawal (RETURN_REIMBURSEMENT_NOT_ALLOWED); the ' +
        'cost of the way back was paid back already (RETURN_REIMBURSEMENT_EXISTS); a statement of the form without the code no admin accepted yet (RETURN_NOT_ACCEPTED).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postDisputeSchema = {
  operationId: 'settleReturnDispute',
  summary: 'Record the end of a dispute at the bank',
  description:
    'A root records how a dispute of the payment of the order ended at the bank, for every row of ' +
    'the order whose transfer failed as disputed: lost (the bank gave the buyer the money: the rows ' +
    'are refunded with the way chargeback on the day it closed; no mail, the bank told the buyer) or ' +
    'won (the bank gave the money back to the shop: the rows lose the mark and can be refunded ' +
    'again the usual way). The webhook of the provider will record the same later. The answer is ' +
    'the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'returnsDisputeBodySchema#', examples: [disputeBodyExample] },

  response: {
    200: {
      description: 'The end of the dispute was recorded: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); no note (RETURN_OUTSIDE_NOTE_REQUIRED); ' +
        'a lost dispute without its day, with a day of the future or before the order was paid ' +
        '(RETURN_OUTSIDE_AT_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'The statement is not there (RETURN_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'No row of the order waits on a dispute (RETURN_NOT_DISPUTED).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postCloseSchema = {
  operationId: 'closeReturnRows',
  summary: 'Close rows of a statement without a refund',
  description:
    'A root closes the rows that wait for goods that never came, without a refund: the goods are ' +
    'marked not arrived and the money refused, with the code and the note (the note is for the ' +
    'shop). The stock does not move. When no row waits any more the statement is closed, the ' +
    'order says so and the buyer is mailed. The units can be stated again whatever the code. The ' +
    'answer is the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'returnsCloseBodySchema#', examples: [closeBodyExample] },

  response: {
    200: {
      description: 'The rows were closed: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); no row waits (RETURN_ITEMS_REQUIRED), ' +
        'no code or note (RETURN_CLOSE_NOTE_REQUIRED).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The statement is not there (RETURN_NOT_FOUND), or a row is not one of it (RETURN_ITEM_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A row whose goods came back or whose money is on its way or back (RETURN_ITEM_NOT_CLOSABLE).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const listItemExample = {
  code: 'W43-1',
  id: 12,
  orderId: 42,
  order: { status: 'shipped', returnStatus: 'open' },
  buyer: { id: 3, alive: true },
  contact: { name: 'Anna Koval', email: 'anna@example.com' },
  statedAt: '2026-11-02T10:00:00.000Z',
  daysSince: 1,
  source: 'account',
  basis: 'withdrawal',
  reason: null,
  extendsId: null,
  closedAt: null,
  updatedAt: '2026-11-02T10:00:00.000Z',
  proof: { providedAt: null, confirmedAt: null },
  acceptedAt: null,
  units: 2,
  amount: 49.98,
  refundedAmount: 0,
  goods: { expected: 2, received: 0, declined: 0 },
  money: { notRefunded: 2, pending: 0, refunded: 0, refused: 0, failed: false },
};

const getReturnsSchema = {
  operationId: 'listReturns',
  summary: 'List the statements of withdrawal and of return',
  description:
    'The statements of the shop, newest first by default, a page at a time (`limit`, `cursor`, ' +
    '`total` of the filter). Each line has the buyer, the units and the money, the units by what ' +
    'became of the goods (`goods`) and by the state of the money (`money`) and the days since the ' +
    'statement. Filters: `state`, `goods` (waiting, waiting_no_proof, proof_provided, received), ' +
    '`money` (not_refunded, pending, failed, refunded, refused), `source`, `basis`, `reason`, ' +
    '`orderId`, `userId`, `productId`, `variantId`, `q` (the number of an order, or a part of a ' +
    'name or an email), the periods of the statement, the closing and the money, and the ' +
    'periods of days the alerts of the admins use (`olderThanDays`, `moneyDueForDays`, ' +
    '`paidAheadForDays`, `proofOlderThanDays`): the count of such an alert is the `total` of this ' +
    'list with its filters. `format=csv` gives every statement of the filter as a file. Only ' +
    'admin and root read it.',

  querystring: {
    $ref: 'returnsListQuerySchema#',
    examples: [{ state: 'open', goods: 'waiting', sortBy: 'statedAt', sortDir: 'asc' }],
  },

  response: {
    200: {
      description: 'The page of statements, or a csv file with format=csv.',
      content: {
        'application/json': {
          schema: { $ref: 'returnsListResponseSchema#' },
          examples: {
            page: {
              value: { items: [listItemExample], total: 1, limit: 20, nextCursor: null },
            },
          },
        },
        'text/csv': { schema: { type: 'string' } },
      },
    },
    400: {
      description:
        'Invalid query: a wrong field (VALIDATION_ERROR), a cursor of another sort (CURSOR_INVALID).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postShipmentSchema = {
  operationId: 'recordReturnShipment',
  summary: 'Record a parcel the shop paid to carry goods back',
  description:
    'An admin or root records a parcel the shop paid to carry the goods of a statement back from ' +
    'the buyer: a label the shop bought, or the carrier of the buyer that the shop paid back ' +
    'outside the app. `shippedAt` is when the parcel was sent back, or the moment it was ' +
    'refused: never of the future, never before the order was paid. The cost may be written ' +
    'later (PATCH). The reports count the cost as an expense of the period of `shippedAt`, ' +
    'apart from the sends to buyers (`delivery.returnShipping`). Nothing is taken from the ' +
    'refund of the buyer for it: when the contract makes the buyer pay for the way back, root ' +
    'lowers the amount of a row with a note. The answer is the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'returnsShipmentBodySchema#', examples: [shipmentBodyExample] },

  response: {
    201: {
      description: 'The parcel was recorded: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); a time that is of the future or ' +
        'before the order was paid (RETURN_SHIPMENT_TIME_INVALID); a number or a link without ' +
        'a carrier (RETURN_SHIPMENT_CARRIER_REQUIRED).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'The statement is not there (RETURN_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The statement has a parcel with this number already, whatever the spaces and the case ' +
        '(RETURN_SHIPMENT_EXISTS); a statement of the form without the code no admin accepted yet (RETURN_NOT_ACCEPTED).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const patchShipmentCostSchema = {
  operationId: 'setReturnShipmentCost',
  summary: 'Write what the shop paid for a parcel back',
  description:
    'An admin or root writes, or corrects, what the shop paid for a parcel recorded on a ' +
    'statement. The time of the parcel stays, so the cost goes to the period the parcel was sent ' +
    'in. The answer is the card of the statement.',

  params: { $ref: 'returnsShipmentParamsSchema#', examples: [shipmentParamsExample] },
  body: { $ref: 'returnsShipmentCostBodySchema#', examples: [{ cost: 4.5 }] },

  response: {
    200: {
      description: 'The cost was written: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description: 'Invalid request: a wrong field (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The parcel is not there, or is not one of this statement (RETURN_SHIPMENT_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postAcceptSchema = {
  operationId: 'acceptReturn',
  summary: 'Accept a statement of the form without the code',
  description:
    'Anybody who knows an order and its recipient can send the public form without the code, so ' +
    'such a statement waits for the check of an admin, outside the app (a letter to the email of ' +
    "the statement, the order). An admin or a root accepts it as the buyer's, once: only then its " +
    'goods and its money are handled (RETURN_NOT_ACCEPTED before), it leaves the alert ' +
    'returns_manual_check, a statement of the buyer no longer takes its units over, and the form ' +
    'may take another statement without the code for the units left. A statement that is not the ' +
    "buyer's is closed by root instead (POST /api/returns/:returnId/close, not_buyer). The answer " +
    'is the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },

  response: {
    200: {
      description: 'The statement was accepted: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    404: {
      description: 'The statement is not there (RETURN_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The statement is not one of the form without the code (RETURN_NOT_MANUAL), was accepted ' +
        'already (RETURN_ALREADY_ACCEPTED) or is closed (RETURN_ALREADY_CLOSED).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const taggedReturnsSchemas = withOpenApiTag(
  {
    getReturnsSchema,
    postReturnSchema,
    getReturnSchema,
    postReceiveItemsSchema,
    postConfirmProofSchema,
    postAcceptSchema,
    postRefundSchema,
    postRefundOutsideSchema,
    postReimbursementSchema,
    postDisputeSchema,
    postCloseSchema,
    postShipmentSchema,
    patchShipmentCostSchema,
  },
  'returns',
);

export const returnsSchema = withOpenApiSecurityFor(
  taggedReturnsSchemas,
  openApiSecurity.accessTokenCookie,
  [
    'getReturnsSchema',
    'postReturnSchema',
    'getReturnSchema',
    'postReceiveItemsSchema',
    'postConfirmProofSchema',
    'postAcceptSchema',
    'postRefundSchema',
    'postRefundOutsideSchema',
    'postReimbursementSchema',
    'postDisputeSchema',
    'postCloseSchema',
    'postShipmentSchema',
    'patchShipmentCostSchema',
  ],
);
