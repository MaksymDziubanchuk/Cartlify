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
  splitFromId: null,
  splitIds: [],
  statedAt: '2026-11-02T10:00:00.000Z',
  source: 'admin',
  basis: 'other',
  reason: 'defect',
  description: 'The box came open.',
  contact: { name: 'Anna Koval', email: 'anna@example.com' },
  createdBy: person,
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  acceptedAt: null,
  acceptedBy: null,
  closedAt: null,
  closedBy: null,
  closeCode: null,
  closeNote: null,
  createdAt: '2026-11-02T10:00:00.000Z',
  updatedAt: '2026-11-02T10:00:00.000Z',
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
  parcels: [],
  deductible: 0,
  warnings: [],
  refundedTotal: 0,
  disputeOpen: false,
  handRefundPending: false,
  bankMoneyPending: false,
  moneyLeft: {
    rows: 20,
    delivery: 0,
    wayBack: 0,
    total: 20,
    due: 0,
    covered: 0,
    paymentLeft: 20,
    short: false,
  },
  moneyOverpaid: 0,
  money: [],
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
      paid: 0,
      amountNote: null,
      goodsSetAt: null,
      goodsSetBy: null,
      moneyLogId: null,
      refundFailure: null,
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

const closeBodyExample = {
  code: 'goods_not_returned',
  note: 'The goods never came, the buyer did not answer.',
};

const paramsExample = { returnId: '12' };

const shipmentBodyExample = {
  direction: 'to_shop',
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
    'and `lost` come back and go out at once (a line of the stock log for each). Goods that came ' +
    '(`to_stock`, `written_off`, `not_accepted`) or were lost on the way have a result only with the ' +
    'parcel to the shop confirmed: one not confirmed yet, or none (the buyer told of no parcel), is ' +
    'confirmed in the same step by `parcel` (who paid the carrier: `cost` the shop, or `buyerPaid` from ' +
    'the receipt of the buyer, required when the shop pays the way back and did not pay the carrier; ' +
    'the carrier, the number and the link of a parcel nobody told of); `not_arrived` needs none; ' +
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
        '(RETURN_NOT_ACCEPTED_REASON_REQUIRED); the parcel confirmed in the step without the sum of the ' +
        'buyer when the shop pays the way back and did not pay the carrier (RETURN_PARCEL_SUM_REQUIRED), ' +
        'or with a sum that is not money or both sums (RETURN_PARCEL_SUM_INVALID).',
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
        'holds (RETURN_QUANTITY_EXCEEDED); goods that came or were lost without the parcel to the shop ' +
        'confirmed and without `parcel` (RETURN_PARCEL_REQUIRED), or a parcel for goods none of which ' +
        'are on their way to the shop (RETURN_NOTHING_WAITING); goods refused for a row whose money ' +
        'is on its way or back, or a row paid in part (the payment held only some of it: the rest ' +
        'goes outside the app first) refused or given the result of only some of its units ' +
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
    'An admin or a root confirms the parcel the goods go back to the shop in, once: the one the ' +
    'buyer told of, the one the shop recorded, or, from a letter with the photos of the parcel and ' +
    'of the goods, a parcel written now without a carrier (the decision is theirs). The body says who ' +
    'paid the carrier: `cost`, the shop (a line of the money journal on the parcel), or `buyerPaid`, ' +
    'the buyer, from the receipt (0 when the buyer gave none; it replaces what the buyer told), not ' +
    'both; the sum of the buyer is required when the shop pays the way back and did not pay the ' +
    'carrier, and the money given back for the way back is never more than it. Goods lost on the way ' +
    'and money paid ahead of the goods need it. The answer is the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'returnsConfirmProofBodySchema#', examples: [{ buyerPaid: 6.5 }] },

  response: {
    200: {
      description: 'The proof was confirmed: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); no sum of the buyer when the shop pays the ' +
        'way back and did not pay the carrier (RETURN_PARCEL_SUM_REQUIRED); both sums ' +
        '(RETURN_PARCEL_SUM_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'The statement is not there (RETURN_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The proof was confirmed already (RETURN_PROOF_ALREADY_CONFIRMED); no goods of the statement ' +
        'are on their way to the shop, they never left it or are all in (RETURN_NOTHING_WAITING); a ' +
        'statement of the form without the code no admin accepted yet (RETURN_NOT_ACCEPTED).',
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
    'is the sum of the rows, and the delivery goes back, all of it, with the transfer that makes ' +
    'the order whole (no unit left that was not accepted or did not arrive). Only root and an ' +
    'admin root allowed to handle the money (`canManageMoney`) lower what a row refunds (`reductions`); the way back the buyer owes is taken off ' +
    '(`returnShippingDeduction`); money already sent to the buyer another way and tied to the ' +
    'statement (a refund made by hand, what the bank gave for a dispute) is used first, the ' +
    'provider is asked for the rest only. A payment that holds less than the transfer (a ' +
    'compensation or a loss took some of it) gets what is left of it, taken off the goods of the ' +
    'last rows: a row is paid in parts (`paid` of `amount` on the card), the rest goes outside ' +
    'the app (`POST /api/returns/{returnId}/refund/outside`), and the row is refunded once its ' +
    'parts give all of it. The way back the shop owes goes with the transfer that ' +
    'leaves no row owed, when the payment holds it beside the money the other statements of the ' +
    'order still owe; left alone (no row owed), a request without `itemIds`, `reductions` and ' +
    '`returnShippingDeduction` sends it by a transfer of its own, and the buyer is mailed once ' +
    'it is sent. The transfer runs in three steps: it is written into ' +
    'the money journal in parts (the goods, the delivery, the deduction, what is covered), in ' +
    'transit, under a new key; the provider is asked; its answer settles the lines and the rows. ' +
    'A refund that the provider has not decided on (or did not answer) leaves the rows ' +
    '`pending`: the provider tells the end by its event, and a worker asks again with the same ' +
    'key. A refund the provider refuses leaves the rows `failed` with `refundFailure`, and the ' +
    'request still answers 200: the card says what to do. When the money is sent the buyer is ' +
    'mailed. The journal of the admins gets `return.refund` with the lines of the money ' +
    'journal (`moneyLogIds`). The answer is the card of the statement.',

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
        'Invalid request: a wrong field (VALIDATION_ERROR); no row can be refunded and no way ' +
        'back is owed alone (RETURN_ITEMS_REQUIRED), a sum that is not a number or above the price of the units ' +
        '(RETURN_AMOUNT_INVALID), a lowered sum without its note (RETURN_AMOUNT_NOTE_REQUIRED), ' +
        'a row lowered twice (RETURN_ITEMS_REPEATED), nothing to send (RETURN_REFUND_AMOUNT_INVALID), ' +
        'a deduction of the way back that is not a sum above 0 or leaves nothing to send ' +
        '(RETURN_DEDUCTION_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        '`RETURN_FORBIDDEN`: only root and an admin root allowed to handle the money (`canManageMoney`) lower what a row refunds; only an admin or a root refunds.',
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
        '(RETURN_PROOF_REQUIRED); a dispute of the payment is open at the bank and the provider ' +
        'does not let it be refunded: the bank settles it, the money would go twice ' +
        '(RETURN_REFUND_DISPUTED); a refund of the payment made by hand in the dashboard of the ' +
        'provider waits for root to say what it was, it may be this money (RETURN_HAND_REFUND_PENDING), ' +
        'and so does what a bank took for a dispute lost on an order sent (RETURN_BANK_MONEY_PENDING); ' +
        'nothing left of the payment, or a transfer that takes a deduction for the way back off and ' +
        'does not fit in it, or a way back left alone that does not fit in it ' +
        'beside the money the other statements of the order still owe (RETURN_REFUND_EXCEEDS_PAID); the order was never ' +
        'paid (RETURN_ORDER_NOT_RETURNABLE); a ' +
        'deduction of the way back for a statement outside the withdrawal or a contract that ' +
        'does not say the buyer pays (RETURN_DEDUCTION_NOT_ALLOWED), or above what the parcels of ' +
        'the statement cost the shop (RETURN_DEDUCTION_EXCEEDS_COST); a statement of the form without the code no admin accepted yet (RETURN_NOT_ACCEPTED).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postMoneyReceivedSchema = {
  operationId: 'recordReturnMoneyReceived',
  summary: 'Record money the buyer gave back outside the app',
  description:
    'A root (or an admin root allowed to handle the money, `canManageMoney`) records money the ' +
    'buyer gave the shop back outside the app (a bank transfer, cash, another way) for rows of the ' +
    'statement whose money the buyer had: goods paid ahead that never came, more than the statement ' +
    'owed. The rows named are refunded rows of the statement, each at most what it cost less what ' +
    'came back for it already; the day is the one the money really came. The money journal gets one ' +
    'line `money.received` with the rows (the reports take it off the money of those products), the ' +
    'statement has that much less back (`refundedTotal`), its rows stay as they are; the journal of ' +
    'the admins gets `return.money_received`. No mail. The answer is the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: {
    $ref: 'returnsMoneyReceivedBodySchema#',
    examples: [
      {
        items: [{ itemId: 31, amount: 20 }],
        method: 'bank_transfer',
        note: 'The parcel never came: the buyer paid the lamp back.',
        at: '2026-11-12T10:00:00.000Z',
      },
    ],
  },

  response: {
    200: {
      description: 'The money was recorded: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); a row that is not one of the statement, ' +
        'named twice, or a sum that is not above 0 to the cent (MONEY_RECEIVED_INVALID); no way or ' +
        'note (MONEY_RECEIVED_NOTE_REQUIRED); a day of the future or before the statement ' +
        '(MONEY_RECEIVED_AT_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        'INSUFFICIENT_ROLE: only an admin or root; MONEY_MANAGER_REQUIRED: only root and an admin ' +
        'root allowed to handle the money; MONEY_RECEIVED_FORBIDDEN: the database refused the actor ' +
        'the same way.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'The statement is not there (MONEY_RECEIVED_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A row whose money the buyer does not have (MONEY_RECEIVED_NOT_REFUNDED); more than a row ' +
        'cost with what came back for it before (MONEY_RECEIVED_EXCEEDS); RESOURCE_BUSY: try again.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const moneyAdmin403 = {
  description:
    'INSUFFICIENT_ROLE: only an admin or root; MONEY_MANAGER_REQUIRED: only root and an admin root ' +
    'allowed to handle the money; the database refused the actor the same way.',
  $ref: 'errorResponseSchema#',
} as const;

const postOverpaidReceivedSchema = {
  operationId: 'recordOverpaidReceived',
  summary: 'Record money the buyer gave back of what is overpaid',
  description:
    'A root (or an admin root allowed to handle the money, `canManageMoney`) records money the ' +
    'buyer gave the shop back outside the app of what money already with the buyer gave the goods ' +
    'of the order more than its statements took (`moneyOverpaid` of the card: a refund made by ' +
    'hand or what a bank took, given to items whose units came back refused or lowered). At most ' +
    'what is overpaid, on the day it really came. The money journal gets a line `money.received` ' +
    'for each share it pays back (the purpose of the line of the share, naming it; the reports by ' +
    'product take it off the returns of those goods), what the statements had back stays; the ' +
    'journal of the admins gets `return.overpaid_received`. No mail. The answer is the card of the ' +
    'statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: {
    $ref: 'returnsOverpaidReceivedBodySchema#',
    examples: [
      {
        amount: 10,
        method: 'bank_transfer',
        note: 'The buyer paid back the money of the lamp the shop did not accept.',
        at: '2026-11-12T10:00:00.000Z',
      },
    ],
  },

  response: {
    200: {
      description: 'The money was recorded: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); a sum that is not above 0 to the cent ' +
        '(MONEY_RECEIVED_INVALID); no way or note (MONEY_RECEIVED_NOTE_REQUIRED); a day of the ' +
        'future or before the money went to the buyer (MONEY_RECEIVED_AT_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      ...moneyAdmin403,
      description: `${moneyAdmin403.description} MONEY_RECEIVED_FORBIDDEN: the refusal of the database.`,
    },
    404: {
      description: 'The statement is not there (MONEY_RECEIVED_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'More than is overpaid (MONEY_RECEIVED_EXCEEDS); RESOURCE_BUSY: try again.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postOverpaidLostSchema = {
  operationId: 'loseOverpaid',
  summary: 'Give what is overpaid up',
  description:
    'A root (or an admin root allowed to handle the money, `canManageMoney`) gives up what money ' +
    'already with the buyer gave the goods of the order more than its statements took ' +
    '(`moneyOverpaid` of the card): the buyer will not give it back. The money journal gets a line ' +
    '`money.share_moved` of 0 for each share (it moves no money: what part of the line was for ' +
    'changes): a compensation of money given back by hand, a loss of what a bank took; the reports ' +
    'by product take it off the returns of those goods and the summary counts it among the other ' +
    'refunds, in the period of the step. The journal of the admins gets `return.overpaid_lost` with ' +
    'the note. No mail. The answer is the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: {
    $ref: 'returnsOverpaidLostBodySchema#',
    examples: [{ note: 'The buyer does not answer: the money is lost.' }],
  },

  response: {
    200: {
      description: 'Given up: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description: 'Invalid request: a wrong field (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      ...moneyAdmin403,
      description: `${moneyAdmin403.description} MONEY_OVERPAID_FORBIDDEN: the refusal of the database.`,
    },
    404: {
      description: 'The statement is not there (MONEY_OVERPAID_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Nothing is overpaid (MONEY_OVERPAID_NONE); RESOURCE_BUSY: try again.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postKeepSchema = {
  operationId: 'keepReturnGoods',
  summary: 'Keep goods not accepted that are still in the shop',
  description:
    'A root (or an admin root allowed to handle the money, `canManageMoney`) keeps goods the shop ' +
    'did not accept that are still with it (not sent back) when money already with the buyer is on ' +
    'their item (a refund made by hand or what a bank took, given to it): they come back on the ' +
    'shelf or are written off as at the parcel (the stock log), the row owes its money again and ' +
    'the statement opens again; the money already with the buyer pays the rows it covers all of at ' +
    'once (nothing asked of the provider) and their buyer is mailed; the rest goes by the usual ' +
    'transfer (`POST /api/returns/{returnId}/refund`), as for any row. The journal of the admins ' +
    'gets `return.goods_kept` with the note. The answer is the card of the statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: {
    $ref: 'returnsKeepBodySchema#',
    examples: [
      {
        items: [{ itemId: 31, goods: 'written_off' }],
        note: 'The bank paid the buyer for the lamp: the shop keeps it and writes it off.',
      },
    ],
  },

  response: {
    200: {
      description: 'Kept: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field (VALIDATION_ERROR); a row named twice or goods other than ' +
        'to_stock and written_off (RETURN_KEEP_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      ...moneyAdmin403,
      description: `${moneyAdmin403.description} RETURN_FORBIDDEN: the refusal of the database.`,
    },
    404: {
      description:
        'The statement is not there (RETURN_NOT_FOUND); a row that is not one of it ' +
        '(RETURN_ITEM_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A row whose goods were not refused, that went back to the buyer, whose units another ' +
        'statement holds, or whose item no money of the buyer is on (RETURN_KEEP_NOT_ALLOWED); ' +
        'RESOURCE_BUSY: try again.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postRefundOutsideSchema = {
  operationId: 'refundReturnOutside',
  summary: 'Record money sent outside the app',
  description:
    'A root (or an admin root allowed to handle the money, `canManageMoney`) ' +
    'records that the money a statement owes went back outside the app (a bank transfer, cash, ' +
    'another way), on the day it really went: all of the rest of it, or the rows named. The rows ' +
    'whose money is owed (never tried, or whose last transfer failed; their goods in, lost, or on ' +
    'their way with the parcel confirmed) and the way back the shop owes the buyer; the limit of ' +
    'the payment does not hold here, a transfer the payment cannot hold goes this way. Never while ' +
    'a dispute of the payment is open at the bank (the bank settles it), or while money given back ' +
    'by hand or taken by a bank waits for root to say what it was for. Money the buyer already has ' +
    '(what the decisions on a refund made by hand or on what a bank took gave the items and the ' +
    'delivery) covers its part first: only the rest went outside the app. The money is ' +
    'written into the money journal in parts (the goods, the delivery that goes with the rows, ' +
    'the deduction: what failed transfers meant to take and `returnShippingDeduction`, the way ' +
    'back, what is covered), the journal of the admins gets `return.refund_outside` with the lines ' +
    '(`moneyLogIds`). The buyer is mailed. The answer is the card of the statement.',

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
        'Invalid request: a wrong field (VALIDATION_ERROR); no method or note ' +
        '(RETURN_OUTSIDE_NOTE_REQUIRED), a day of the future or before the order was paid ' +
        '(RETURN_OUTSIDE_AT_INVALID); a deduction that leaves nothing (RETURN_DEDUCTION_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The statement is not there (RETURN_NOT_FOUND), or a row is not one of it (RETURN_ITEM_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A row whose money is not owed: refused, or on its way or back (RETURN_ITEM_NOT_REFUNDABLE), ' +
        'or goods on their way with the parcel not confirmed (RETURN_PROOF_REQUIRED); nothing owed ' +
        'at all (RETURN_NOTHING_OWED); a deduction where the buyer owes no way back ' +
        '(RETURN_DEDUCTION_NOT_ALLOWED) or more than the parcel cost (RETURN_DEDUCTION_EXCEEDS_COST); ' +
        'a dispute of the payment is open at the bank (RETURN_REFUND_DISPUTED); a refund made by hand ' +
        'in the dashboard of the provider waits for root to say what it was ' +
        '(RETURN_HAND_REFUND_PENDING), or what a bank took for a dispute lost on an order sent does ' +
        '(RETURN_BANK_MONEY_PENDING); a statement of the form without the code no admin accepted ' +
        'yet (RETURN_NOT_ACCEPTED).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const postCloseSchema = {
  operationId: 'closeReturnRows',
  summary: 'Close rows of a statement without a refund',
  description:
    'A root (or an admin root allowed to handle the money, `canManageMoney`) ' +
    'closes the rows that wait for goods that never came, without a refund: the goods are ' +
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
        'A row whose goods came back, whose money is on its way or back, or that is paid in part ' +
        '(RETURN_ITEM_NOT_CLOSABLE).',
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
  moneyLeft: 49.98,
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
    '`paidAheadForDays`, `proofOlderThanDays`) and whether the money waits for the bank or for ' +
    'root (`moneyHeld`): the count of such an alert is the `total` of this ' +
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
  summary: 'Record a parcel of a statement',
  description:
    'An admin or root records a parcel of a statement. `to_shop`: the parcel the goods come back ' +
    'in, one a statement, while goods of it are on their way to the shop: a label the shop ' +
    'bought, or the carrier of the buyer; it is confirmed later, or when the goods are taken in. ' +
    '`to_buyer`: goods the shop did not accept go back to the buyer; `items` names the rows and ' +
    'their units (a row splits when the parcel carries some of its units), a unit goes back ' +
    'once, and the buyer is mailed the carrier and the number. `shippedAt` is when the parcel was ' +
    'sent, or the moment it was refused: never of the future, never before the order was paid. ' +
    'The cost may be written later (PATCH); it is an expense of the period it is written in, apart ' +
    'from the sends of the orders (`delivery.returnShipping`). The answer is the card of the ' +
    'statement, its parcels with the rows each parcel to the buyer carries.',

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
        'a carrier (RETURN_SHIPMENT_CARRIER_REQUIRED); a parcel to the buyer without `items` ' +
        '(RETURN_ITEMS_REQUIRED), a parcel to the shop with them (RETURN_ITEMS_NOT_ALLOWED).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The statement is not there (RETURN_NOT_FOUND), or a row is not one of it (RETURN_ITEM_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The statement has a parcel with this number already, whatever the spaces and the case ' +
        '(RETURN_SHIPMENT_EXISTS); it has its parcel to the shop already, the one the buyer told of or ' +
        'the one the shop recorded (RETURN_PARCEL_EXISTS: the goods of a statement go back in one parcel; ' +
        'write what the shop paid for it with PATCH .../shipments/:shipmentId); no goods of it are on ' +
        'their way to the shop, they never left it or are all in (RETURN_NOTHING_WAITING); a row of a ' +
        'parcel to the buyer is not of goods not accepted, or went back already ' +
        '(RETURN_NOTHING_TO_SEND_BACK), or holds fewer units (RETURN_QUANTITY_EXCEEDED); a statement of ' +
        'the form without the code no admin accepted yet (RETURN_NOT_ACCEPTED).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const patchShipmentCostSchema = {
  operationId: 'setReturnShipmentCost',
  summary: 'Write what the shop paid for a parcel back, or correct what the buyer paid',
  description:
    'An admin or root writes, or corrects, what the shop paid for a parcel recorded on a ' +
    'statement (cost). The time of the parcel stays, so the cost goes to the period the parcel was ' +
    'sent in. Or corrects what the buyer paid the carrier for the parcel back to the shop ' +
    '(buyerPaid, the sum of the receipt set when the parcel was confirmed), while no money of the ' +
    'way back went; what the statement owes for the way back follows. The answer is the card of ' +
    'the statement.',

  params: { $ref: 'returnsShipmentParamsSchema#', examples: [shipmentParamsExample] },
  body: { $ref: 'returnsShipmentCostBodySchema#', examples: [{ cost: 4.5 }] },

  response: {
    200: {
      description: 'The cost was written: the card of the statement.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description:
        'Invalid request: a wrong field, both or none of the two (VALIDATION_ERROR). ' +
        '`RETURN_PARCEL_SUM_INVALID`: the shop paid the carrier for the parcel, it keeps no sum ' +
        'of the buyer; or a cost of the shop for a parcel back the buyer paid the carrier for (a ' +
        'sum of the receipt above 0): the same way back would be paid twice.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The parcel is not there, or is not one of this statement (RETURN_SHIPMENT_NOT_FOUND); a ' +
        'sum of the buyer is only of the parcel back to the shop.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`RETURN_PROOF_REQUIRED`: the parcel is not confirmed yet, its sum is set with the ' +
        'confirmation. `RETURN_WAY_BACK_PAID`: money of the way back went already. ' +
        '`RETURN_DEDUCTION_EXCEEDS_COST`: the cost would be below what transfers took off for the ' +
        'way back. `RESOURCE_BUSY`: try again.',
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

const postSplitSchema = {
  operationId: 'splitReturn',
  summary: 'Take units of a statement into a new one',
  description:
    'The goods of a statement go back in more than one parcel: an admin or root takes the units ' +
    'named into a new statement of the order, which the buyer sends in a parcel of their own. It ' +
    'keeps the moment, the person, the source, the basis and the reason of the first, with the next ' +
    'number (`splitFromId`; the first lists it in `splitIds`). Only rows whose goods wait and whose ' +
    'money did not move leave; fewer units than a row holds split it, and the statement keeps a ' +
    'row. The buyer is mailed the code of the new statement. The buyer splits a statement the ' +
    'same way by naming the units of the parcel (POST /api/orders/:orderId/returns/:returnId/proof, ' +
    '`items`). The answer is the card of the new statement.',

  params: { $ref: 'returnsParamsSchema#', examples: [paramsExample] },
  body: { $ref: 'returnsSplitBodySchema#', examples: [{ items: [{ itemId: 31, quantity: 1 }] }] },

  response: {
    201: {
      description: 'The units are in a new statement: its card.',
      $ref: 'returnsResponseSchema#',
      examples: [returnExample],
    },
    400: {
      description: 'Invalid request: no rows, or a wrong field (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The statement is not there (RETURN_NOT_FOUND), or a row is not one of it (RETURN_ITEM_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A row whose goods do not wait (RETURN_ITEM_NOT_EXPECTED) or whose money moved, some of it ' +
        'too (RETURN_ITEM_MONEY_SETTLED); more units than a row holds (RETURN_QUANTITY_EXCEEDED); a split ' +
        'that leaves the statement no row (RETURN_SPLIT_INVALID); a statement of the form without ' +
        'the code no admin accepted yet (RETURN_NOT_ACCEPTED).',
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
    postMoneyReceivedSchema,
    postOverpaidReceivedSchema,
    postOverpaidLostSchema,
    postKeepSchema,
    postCloseSchema,
    postShipmentSchema,
    patchShipmentCostSchema,
    postSplitSchema,
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
    'postMoneyReceivedSchema',
    'postCloseSchema',
    'postShipmentSchema',
    'patchShipmentCostSchema',
    'postSplitSchema',
  ],
);
