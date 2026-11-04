import { RETURN_DESCRIPTION_MAX } from '@helpers/returns.js';
import { MAX_ID } from '@schemas/idPathParam.js';

// WITHDRAWALS: the public form of withdrawal and the proof of a parcel by the code of the mail

const orderIdField = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_ID,
  description: 'The number of the order.',
} as const;

const codeField = {
  type: 'string',
  maxLength: 40,
  description:
    'The code after the # of the link of the mail (K7QM-4XTP-9RHD); the page of the frontend ' +
    'takes it from the link, the visitor does not type it. An empty text, a missing code and a ' +
    'wrong one are the same: no code.',
} as const;

const withdrawalRouteBodySchema = {
  $id: 'withdrawalRouteBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: { orderId: orderIdField, code: codeField },
  required: ['orderId'],
} as const;

const withdrawalRouteResponseSchema = {
  $id: 'withdrawalRouteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    where: {
      type: 'string',
      enum: ['account', 'form', 'closed'],
      description:
        'account: the order is theirs, sign in and use the button of the order; form: the public ' +
        'form of withdrawal; closed: the period of withdrawal of the order is over.',
    },
  },
  required: ['where'],
} as const;

const recipientNameField = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  description:
    'The name of the recipient of the order, as written in it (the first and the last name in ' +
    'either order, any case and spaces).',
} as const;

// the facts of the recipient a visitor gives without the code of the mail
const factsFields = {
  phone: {
    type: 'string',
    minLength: 1,
    maxLength: 32,
    description:
      'Without the code: the phone of the recipient of the order; only its digits are compared.',
  },
  country: {
    type: 'string',
    pattern: '^[A-Za-z]{2}$',
    description:
      'Without the code, for a delivery to an address: the country of the address (two letters).',
  },
  postalCode: {
    type: 'string',
    minLength: 1,
    maxLength: 16,
    description:
      'Without the code, for a delivery to an address that has one: the postal code; the spaces ' +
      'and the case do not count.',
  },
} as const;

const withdrawalItemsBodySchema = {
  $id: 'withdrawalItemsBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: orderIdField,
    code: codeField,
    recipientName: recipientNameField,
    ...factsFields,
  },
  required: ['orderId', 'recipientName'],
} as const;

const withdrawalItemsResponseSchema = {
  $id: 'withdrawalItemsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description:
        'The units free to withdraw from, by item; an item without the right of withdrawal and ' +
        'the units in statements already are left out. No prices.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          orderItemId: { type: 'integer' },
          name: { type: 'string', description: 'The name the item was bought under.' },
          quantity: { type: 'integer', description: 'The units free to withdraw from.' },
        },
        required: ['orderItemId', 'name', 'quantity'],
      },
    },
    signIn: {
      type: 'boolean',
      description:
        'The account of the order is alive: signing in withdraws at once from the order page; ' +
        'the form works too.',
    },
    underReview: {
      type: 'boolean',
      description:
        'Without the code: a statement of the form without the code for this order waits for the ' +
        'check of an admin; another one is taken once it is accepted (409 WITHDRAWAL_UNDER_REVIEW ' +
        'until then). With the code or from the account a statement is taken at once.',
    },
  },
  required: ['items', 'signIn', 'underReview'],
} as const;

const withdrawalFormBodySchema = {
  $id: 'withdrawalFormBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: orderIdField,
    recipientName: recipientNameField,
    ...factsFields,
    email: {
      type: 'string',
      minLength: 3,
      maxLength: 320,
      format: 'email',
      description: 'Where the shop answers.',
    },
    code: codeField,
    items: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      description:
        'The units to withdraw from. Without it: whatever is left of the order that has the right ' +
        'of withdrawal.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          orderItemId: { type: 'integer', minimum: 1, maximum: MAX_ID },
          quantity: { type: 'integer', minimum: 1, maximum: MAX_ID },
        },
        required: ['orderItemId', 'quantity'],
      },
    },
    description: {
      type: 'string',
      minLength: 1,
      maxLength: RETURN_DESCRIPTION_MAX,
      description: 'The own words of the buyer, for the shop.',
    },
  },
  required: ['orderId', 'recipientName', 'email'],
} as const;

const withdrawalProofBodySchema = {
  $id: 'withdrawalProofBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: orderIdField,
    code: codeField,
    returnId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'The statement the parcel belongs to.',
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
      description: 'The number of the parcel.',
    },
    trackingUrl: {
      type: 'string',
      maxLength: 500,
      pattern: '^https://[^\\s]+$',
      description: 'A link to follow the parcel (https).',
    },
  },
  required: ['orderId', 'code', 'returnId', 'carrier', 'trackingNumber'],
} as const;

const withdrawalReceivedResponseSchema = {
  $id: 'withdrawalReceivedResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: { received: { type: 'boolean', enum: [true] } },
  required: ['received'],
} as const;

export const withdrawalsDtoSchemas = [
  withdrawalRouteBodySchema,
  withdrawalRouteResponseSchema,
  withdrawalItemsBodySchema,
  withdrawalItemsResponseSchema,
  withdrawalFormBodySchema,
  withdrawalProofBodySchema,
  withdrawalReceivedResponseSchema,
];
