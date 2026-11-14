import type { FastifySchema } from 'fastify';

import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const routeBodyExample = { orderId: 42, code: 'K7QM-4XTP-9RHD' };

const itemsBodyExample = {
  orderId: 42,
  recipientName: 'Anna Koval',
  phone: '+380 50 123 45 67',
  country: 'UA',
  postalCode: '01001',
};

const formBodyExample = {
  orderId: 42,
  recipientName: 'Anna Koval',
  email: 'anna@example.com',
  code: 'K7QM-4XTP-9RHD',
  items: [{ orderItemId: 77, quantity: 1 }],
  description: 'It does not fit.',
};

const proofBodyExample = {
  orderId: 42,
  code: 'K7QM-4XTP-9RHD',
  returnId: 12,
  carrier: 'DHL',
  trackingNumber: 'JD0146000123',
  trackingUrl: 'https://track.example.com/JD0146000123',
};

const postRouteSchema = {
  operationId: 'routeWithdrawal',
  summary: 'Where the link of withdrawal in a mail leads',
  description:
    'The page of the frontend the link of a mail opens asks where to send the visitor, with the ' +
    'number of the order and the code after the # of the link. The server decides at the moment of ' +
    'the click: `account` when the code is the code of the order, the period of withdrawal is open ' +
    'and the account of the order is alive (the button of the order withdraws from it, after a ' +
    'login if one is needed); `form` when the account is deleted, and for a code that is not the ' +
    'code of the order, a missing code or an order there is not (these answers are the same, so ' +
    'nothing tells whether an order exists); `closed` when the code is right and the period is over. ' +
    'At most `LIMIT_WITHDRAWAL_FORM_PER_ADDRESS` requests an hour from an address and ' +
    '`LIMIT_WITHDRAWAL_FORM_PER_ORDER` for an order from one address.',

  body: { $ref: 'withdrawalRouteBodySchema#', examples: [routeBodyExample] },

  response: {
    200: {
      description: 'Where to send the visitor.',
      $ref: 'withdrawalRouteResponseSchema#',
      examples: [{ where: 'account' }],
    },
    400: { description: 'Invalid body (VALIDATION_ERROR).', $ref: 'errorResponseSchema#' },
    429: { description: 'Too many requests (RATE_LIMITED).', $ref: 'errorResponseSchema#' },
    500: { description: 'Unexpected server error.', $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const postItemsSchema = {
  operationId: 'listWithdrawableItems',
  summary: 'The units of an order the public form may withdraw from',
  description:
    'The page of the public form shows the units a visitor may withdraw from, once they showed ' +
    'the order is theirs. The number of the order is always needed. With the code after the # of ' +
    'the link of a mail: the name of the recipient (also for an account that is alive, without a ' +
    'login). Without the code: the name, the phone of the recipient and, for a delivery to an ' +
    'address, its country and its postal code when the order has one (a pickup: the name and the ' +
    'phone). The answer gives only the units with the right of withdrawal that no statement holds, ' +
    'while the period is open, without prices; `signIn` says the account is alive, `underReview` ' +
    'that a statement without the code waits for the check of an admin. Every failure (an order ' +
    'there is not, facts that do not match, a period that is over) is the same answer, ' +
    '`400 WITHDRAWAL_REJECTED`, and the server does the same work whatever was wrong. ' +
    'At most `LIMIT_WITHDRAWAL_FORM_PER_ADDRESS` requests an hour from an address, ' +
    '`LIMIT_WITHDRAWAL_FORM_PER_ORDER` for an order and `LIMIT_WITHDRAWAL_FORM_PER_DATA` for the ' +
    'same phone (or name) of a recipient, both from every address and only without the code.',

  body: { $ref: 'withdrawalItemsBodySchema#', examples: [itemsBodyExample] },

  response: {
    200: {
      description: 'The units free to withdraw from.',
      $ref: 'withdrawalItemsResponseSchema#',
      examples: [
        {
          items: [{ orderItemId: 77, name: 'Desk lamp, white', quantity: 2 }],
          signIn: false,
          underReview: false,
        },
      ],
    },
    400: {
      description:
        'Invalid body (VALIDATION_ERROR), or `WITHDRAWAL_REJECTED`: nothing is shown, for a ' +
        'reason the answer does not give.',
      $ref: 'errorResponseSchema#',
    },
    409: { description: '`RESOURCE_BUSY`: try again.', $ref: 'errorResponseSchema#' },
    429: { description: 'Too many requests (RATE_LIMITED).', $ref: 'errorResponseSchema#' },
    500: { description: 'Unexpected server error.', $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const postFormSchema = {
  operationId: 'submitWithdrawalForm',
  summary: 'Withdraw from the contract through the public form',
  description:
    'A buyer with no account to sign in to (it was deleted) or without the mail at hand withdraws ' +
    'from the contract: the number of the order, the facts of its recipient checked against the ' +
    'delivery of the order as POST /api/withdrawals/items checks them, an email for the answers, ' +
    'and the units the page showed (without them whatever is left of the order that has the right ' +
    'of withdrawal). With the code of the order from the link of a ' +
    'mail the statement is the one of an account: for a paid order that was not sent the goods ' +
    'come back at once, the order is cancelled when it is all of it, and the money goes back ' +
    'right away. Without the code the statement waits for an admin who checks it by hand and ' +
    'accepts it, and nothing moves on its own; one such statement waits per order at a time ' +
    '(`409 WITHDRAWAL_UNDER_REVIEW`, told only once the facts matched: the shop answers it by ' +
    'email, and the link of a mail or the account withdraw at once). The shop mails the notice to ' +
    'the email given. Every other failure (an order there is not, facts that do not match, a ' +
    'period that is over, units that cannot be taken) is the same answer, ' +
    '`400 WITHDRAWAL_REJECTED`, which does not say which. ' +
    'At most `LIMIT_WITHDRAWAL_FORM_PER_ADDRESS` requests an hour from an address, ' +
    '`LIMIT_WITHDRAWAL_FORM_PER_ORDER` for an order and `LIMIT_WITHDRAWAL_FORM_PER_DATA` for the ' +
    'same phone (or name) of a recipient, both from every address and only without the code.',

  body: { $ref: 'withdrawalFormBodySchema#', examples: [formBodyExample] },

  response: {
    201: {
      description: 'The statement was made.',
      $ref: 'withdrawalReceivedResponseSchema#',
      examples: [{ received: true }],
    },
    400: {
      description:
        'Invalid body (VALIDATION_ERROR), or `WITHDRAWAL_REJECTED`: the statement was not made, ' +
        'for a reason the answer does not give.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`WITHDRAWAL_UNDER_REVIEW`: a statement without the code for this order waits for the ' +
        'check of an admin; `RESOURCE_BUSY`: try again.',
      $ref: 'errorResponseSchema#',
    },
    429: { description: 'Too many requests (RATE_LIMITED).', $ref: 'errorResponseSchema#' },
    500: { description: 'Unexpected server error.', $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const postProofSchema = {
  operationId: 'provideWithdrawalProof',
  summary: 'Tell how the goods were sent back, by the code of the mail',
  description:
    'A buyer writes the carrier and the number of the parcel they sent the goods back with (and ' +
    'a link to follow it, and what they paid the carrier when they want to tell it), with the code of ' +
    'the order from the link of a mail, for a statement of ' +
    'this order made from an account or from the form with the code. Every failure (a wrong ' +
    'code, a statement there is not or of another kind, one that is closed, has nothing to wait ' +
    'for, is confirmed by the shop already or has a parcel the shop recorded itself) is the same ' +
    'answer, `400 WITHDRAWAL_REJECTED`. At ' +
    'most `LIMIT_WITHDRAWAL_FORM_PER_ADDRESS` requests an hour from an address and ' +
    '`LIMIT_WITHDRAWAL_FORM_PER_ORDER` for an order from one address.',

  body: { $ref: 'withdrawalProofBodySchema#', examples: [proofBodyExample] },

  response: {
    200: {
      description: 'The proof was written.',
      $ref: 'withdrawalReceivedResponseSchema#',
      examples: [{ received: true }],
    },
    400: {
      description: 'Invalid body (VALIDATION_ERROR), or `WITHDRAWAL_REJECTED`.',
      $ref: 'errorResponseSchema#',
    },
    409: { description: '`RESOURCE_BUSY`: try again.', $ref: 'errorResponseSchema#' },
    429: { description: 'Too many requests (RATE_LIMITED).', $ref: 'errorResponseSchema#' },
    500: { description: 'Unexpected server error.', $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const withdrawalsSchema = withOpenApiTag(
  { postRouteSchema, postItemsSchema, postFormSchema, postProofSchema },
  'withdrawals',
);
