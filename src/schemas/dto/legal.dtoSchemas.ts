import { idPathParam, MAX_ID } from '@schemas/idPathParam.js';

// LEGAL: the versions of the terms, of the contract and of the privacy policy of the shop, and the
// consents to the terms and to the contract

export const LEGAL_DOCUMENT_MAX_TITLE = 200;
export const LEGAL_DOCUMENT_MAX_CONTENT = 200_000;
export const LEGAL_DOCUMENT_MAX_ADDRESS = 500;
// the least days of withdrawal a contract may give (the law) and the most of any term in days
export const LEGAL_WITHDRAWAL_MIN_DAYS = 14;
export const LEGAL_MAX_DAYS = 36_500;

const kindSchema = {
  type: 'string',
  enum: ['terms', 'contract', 'privacy'],
  description:
    'terms: the terms of use of the shop; contract: the contract of sale; privacy: the privacy ' +
    'policy. A customer accepts the terms and the contract, the privacy policy only informs.',
} as const;

// the kinds a customer accepts
const consentKindSchema = {
  type: 'string',
  enum: ['terms', 'contract'],
  description: 'terms: the terms of use of the shop; contract: the contract of sale.',
} as const;

const returnShippingPayerSchema = {
  type: 'string',
  enum: ['buyer', 'shop'],
  description:
    'Who pays the carrier for the parcel a buyer sends back when they withdraw: the buyer, or ' +
    'the shop. The buyer is charged only when the contract said it before the purchase.',
} as const;

// what a contract says on top of its text, in a version as it is published and as it is read
const contractTermsProperties = {
  withdrawalDays: {
    type: 'integer',
    minimum: LEGAL_WITHDRAWAL_MIN_DAYS,
    maximum: LEGAL_MAX_DAYS,
    description:
      `The days a buyer has to withdraw from an order after its delivery, ${LEGAL_WITHDRAWAL_MIN_DAYS} ` +
      'at least (the law). An order keeps the days of the contract in force at its confirmation.',
  },
  returnAddress: {
    type: 'string',
    minLength: 1,
    maxLength: LEGAL_DOCUMENT_MAX_ADDRESS,
    description:
      `Where a buyer sends the goods back, up to ${LEGAL_DOCUMENT_MAX_ADDRESS} characters, without ` +
      'the spaces at its edges. The one of the contract in force is shown, whatever contract an ' +
      'order was confirmed with.',
  },
  returnShippingPaidBy: returnShippingPayerSchema,
} as const;

// how long each kind of personal data is kept, in days, in a privacy policy
const retentionProperties = {
  loginAddressesDays: {
    type: 'integer',
    minimum: 1,
    maximum: LEGAL_MAX_DAYS,
    description: 'The address and the browser of a login.',
  },
  guestDataDays: {
    type: 'integer',
    minimum: 1,
    maximum: LEGAL_MAX_DAYS,
    description: 'The favorites and the chats of a guest, from their last activity.',
  },
  deletedChatsDays: {
    type: 'integer',
    minimum: 1,
    maximum: LEGAL_MAX_DAYS,
    description: 'The chats of a deleted account, from its deletion.',
  },
  returnAddressesDays: {
    type: 'integer',
    minimum: 1,
    maximum: LEGAL_MAX_DAYS,
    description: 'The address and the browser of a statement of withdrawal, from its closing.',
  },
  returnPersonalDays: {
    type: 'integer',
    minimum: 1,
    maximum: LEGAL_MAX_DAYS,
    description:
      'The name, the email, the phone and the text of a statement of withdrawal, from its closing.',
  },
  recipientDays: {
    type: 'integer',
    minimum: 1,
    maximum: LEGAL_MAX_DAYS,
    description:
      'The recipient and the address of an order, from the deletion of the account of its buyer.',
  },
  newsletterConsentDays: {
    type: 'integer',
    minimum: 1,
    maximum: LEGAL_MAX_DAYS,
    description:
      'The proof of the consent to the newsletters: a subscription that ended, or that a ' +
      'bounce stopped, with its journal (when, from which address and browser, under which ' +
      'version of the policy) is kept this many days after it ended, then removed. A request ' +
      'to subscribe that nobody confirmed has no term here: it goes with its link after three ' +
      'days.',
  },
  newsletterRecipientsDays: {
    type: 'integer',
    minimum: 1,
    maximum: LEGAL_MAX_DAYS,
    description:
      'The rows of the mails of a newsletter campaign (one for each subscriber it went to) ' +
      'are kept this many days after the campaign ended (finished, stopped or cancelled), then ' +
      'removed; the campaign with its totals stays.',
  },
} as const;

const contractRequired = ['withdrawalDays', 'returnAddress', 'returnShippingPaidBy'] as const;
const retentionRequired = [
  'loginAddressesDays',
  'guestDataDays',
  'deletedChatsDays',
  'returnAddressesDays',
  'returnPersonalDays',
  'recipientDays',
  'newsletterConsentDays',
  'newsletterRecipientsDays',
] as const;

const dateTimeSchema = { type: 'string', format: 'date-time' } as const;

// the ids of versions a customer accepts, each one once
export const legalDocumentIdsSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 10,
  uniqueItems: true,
  items: { type: 'integer', minimum: 1, maximum: MAX_ID },
} as const;

const legalDocumentSchema = {
  $id: 'legalDocumentSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    kind: kindSchema,
    version: { type: 'integer', minimum: 1, description: 'The number of the version of its kind.' },
    title: { type: 'string' },
    content: { type: 'string', description: 'The text of the version, as root published it.' },
    sha256: {
      type: 'string',
      pattern: '^[0-9a-f]{64}$',
      description: 'The sha256 of the text in hex: what the customer accepted, to the letter.',
    },
    publishedAt: dateTimeSchema,
    contract: {
      type: ['object', 'null'],
      additionalProperties: false,
      description: 'What a contract says on top of its text; null for the other kinds.',
      properties: contractTermsProperties,
      required: contractRequired,
    },
    retention: {
      type: ['object', 'null'],
      additionalProperties: false,
      description:
        'How long a privacy policy keeps each kind of personal data, in days; null for the ' +
        'other kinds. The page of the policy shows these numbers beside its text.',
      properties: retentionProperties,
      required: retentionRequired,
    },
  },
  required: [
    'id',
    'kind',
    'version',
    'title',
    'content',
    'sha256',
    'publishedAt',
    'contract',
    'retention',
  ],
} as const;

const legalDocumentsCurrentResponseSchema = {
  $id: 'legalDocumentsCurrentResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description:
        'The latest version of each kind that has one: the terms, the contract, the privacy policy.',
      items: { $ref: 'legalDocumentSchema#' },
    },
  },
  required: ['items'],
} as const;

const legalDocumentParamsSchema = {
  $id: 'legalDocumentParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: { documentId: idPathParam('the version') },
  required: ['documentId'],
} as const;

const legalDocumentPublishBodySchema = {
  $id: 'legalDocumentPublishBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: kindSchema,
    title: {
      type: 'string',
      minLength: 1,
      maxLength: LEGAL_DOCUMENT_MAX_TITLE,
      description: `Up to ${LEGAL_DOCUMENT_MAX_TITLE} characters, without the spaces at its edges.`,
    },
    content: {
      type: 'string',
      minLength: 1,
      maxLength: LEGAL_DOCUMENT_MAX_CONTENT,
      description:
        `The text, plain or markdown, up to ${LEGAL_DOCUMENT_MAX_CONTENT} characters; it is kept ` +
        'as it is sent. The details of the seller (name, address) belong in the text of the ' +
        'contract: the mail of the contract carries it.',
    },
    contract: {
      type: 'object',
      additionalProperties: false,
      description:
        'What a contract says on top of its text; required for a contract, refused for any ' +
        'other kind.',
      properties: contractTermsProperties,
      required: contractRequired,
    },
    retention: {
      type: 'object',
      additionalProperties: false,
      description:
        'How long a privacy policy keeps each kind of personal data; required for a privacy ' +
        'policy, refused for any other kind. All the terms are needed, each in whole days from ' +
        `1 to ${LEGAL_MAX_DAYS}. Data is kept for the shorter of the term of the version in ` +
        'force when it was collected and of the version in force now, and cleaned a day before ' +
        'the term ends; with no privacy policy published nothing is cleaned.',
      properties: retentionProperties,
      required: retentionRequired,
    },
  },
  required: ['kind', 'title', 'content'],
} as const;

const legalDocumentsHistoryQuerySchema = {
  $id: 'legalDocumentsHistoryQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: kindSchema,
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'Rows on a page, 20 unless given.',
    },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'nextCursor of the page before.',
    },
  },
} as const;

const legalDocumentsHistoryResponseSchema = {
  $id: 'legalDocumentsHistoryResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description: 'Every version, the latest first, without its text.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          kind: kindSchema,
          version: { type: 'integer' },
          title: { type: 'string' },
          sha256: { type: 'string' },
          publishedAt: dateTimeSchema,
          publishedBy: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'integer' },
              name: { type: ['string', 'null'] },
              email: {
                type: ['string', 'null'],
                description: 'null for an account that was deleted.',
              },
            },
            required: ['id', 'name', 'email'],
          },
        },
        required: ['id', 'kind', 'version', 'title', 'sha256', 'publishedAt', 'publishedBy'],
      },
    },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'nextCursor'],
} as const;

const legalAcceptanceStatusSchema = {
  $id: 'legalAcceptanceStatusSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    current: {
      type: 'array',
      description:
        'The versions in force of the kinds a customer accepts, terms first, without their texts.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          kind: consentKindSchema,
          version: { type: 'integer' },
          title: { type: 'string' },
        },
        required: ['id', 'kind', 'version', 'title'],
      },
    },
    accepted: {
      type: 'array',
      description: 'The version of each kind the customer accepted last, in force or older.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          documentId: { type: 'integer' },
          kind: consentKindSchema,
          version: { type: 'integer' },
          acceptedAt: dateTimeSchema,
        },
        required: ['documentId', 'kind', 'version', 'acceptedAt'],
      },
    },
    required: {
      type: 'array',
      description:
        'The kinds whose version in force the customer has to accept before an order is ' +
        'confirmed; empty when nothing is to accept.',
      items: consentKindSchema,
    },
  },
  required: ['current', 'accepted', 'required'],
} as const;

const legalAcceptBodySchema = {
  $id: 'legalAcceptBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    documentIds: {
      ...legalDocumentIdsSchema,
      description: 'The versions in force the customer accepts.',
    },
  },
  required: ['documentIds'],
} as const;

export const legalDtoSchemas = [
  legalDocumentSchema,
  legalDocumentsCurrentResponseSchema,
  legalDocumentParamsSchema,
  legalDocumentPublishBodySchema,
  legalDocumentsHistoryQuerySchema,
  legalDocumentsHistoryResponseSchema,
  legalAcceptanceStatusSchema,
  legalAcceptBodySchema,
];
