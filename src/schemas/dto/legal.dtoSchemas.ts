import { idPathParam, MAX_ID } from '@schemas/idPathParam.js';

// LEGAL: the versions of the terms and of the contract of the shop and the consents to them

export const LEGAL_DOCUMENT_MAX_TITLE = 200;
export const LEGAL_DOCUMENT_MAX_CONTENT = 200_000;

const kindSchema = {
  type: 'string',
  enum: ['terms', 'contract'],
  description: 'terms: the terms of use of the shop; contract: the contract of sale.',
} as const;

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
  },
  required: ['id', 'kind', 'version', 'title', 'content', 'sha256', 'publishedAt'],
} as const;

const legalDocumentsCurrentResponseSchema = {
  $id: 'legalDocumentsCurrentResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description: 'The latest version of each kind that has one, terms first.',
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
      description: 'The versions in force, terms first, without their texts.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          kind: kindSchema,
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
          kind: kindSchema,
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
      items: kindSchema,
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
