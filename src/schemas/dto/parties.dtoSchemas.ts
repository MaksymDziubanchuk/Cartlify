import { idPathParam } from '@schemas/idPathParam.js';

// the values of a party are checked by the service (src/helpers/party.ts), which names each wrong
// one in details.fields; the schemas hold only the types

const partyValuesProperties = {
  name: { type: 'string', description: 'The name of the party, up to 200 signs.' },
  address: { type: 'string', description: 'The postal address, up to 500 signs.' },
  email: { type: 'string', description: 'The electronic address, up to 254 signs.' },
  country: {
    type: 'string',
    description: 'The country, two letters of ISO 3166 (es is kept as ES).',
  },
} as const;

export const partiesParamsSchema = {
  $id: 'partiesParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: { partyId: idPathParam('the party') },
  required: ['partyId'],
} as const;

const partiesCreateBodySchema = {
  $id: 'partiesCreateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: partyValuesProperties,
  required: ['name', 'address', 'email', 'country'],
} as const;

const partiesUpdateBodySchema = {
  $id: 'partiesUpdateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: partyValuesProperties,
} as const;

const partiesListQuerySchema = {
  $id: 'partiesListQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 100,
      description: 'The most rows a page holds, from 1 to 100.',
    },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'The nextCursor of the previous page, with the same filters and sort.',
    },
    q: {
      type: 'string',
      maxLength: 200,
      description: 'A part of the name, the address or the email, letter case ignored.',
    },
    country: {
      type: 'string',
      pattern: '^[A-Za-z]{2}$',
      description: 'Only the parties of this country, two letters.',
    },
    sortOrder: {
      type: 'string',
      enum: ['asc', 'desc'],
      default: 'asc',
      description: 'The order of the names, asc by default.',
    },
  },
} as const;

const partyUsageSchema = {
  $id: 'partyUsageSchema',
  type: 'object',
  additionalProperties: false,
  description: 'How many products name the party.',
  properties: {
    manufacturerOf: { type: 'integer', description: 'The products it makes.' },
    euResponsibleOf: {
      type: 'integer',
      description: 'The products it answers for in the EU.',
    },
  },
  required: ['manufacturerOf', 'euResponsibleOf'],
} as const;

const partiesPartyResponseSchema = {
  $id: 'partiesPartyResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    ...partyValuesProperties,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'name', 'address', 'email', 'country', 'createdAt', 'updatedAt'],
} as const;

const partiesDetailResponseSchema = {
  $id: 'partiesDetailResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },
    ...partyValuesProperties,
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    usage: { $ref: 'partyUsageSchema#' },
  },
  required: ['id', 'name', 'address', 'email', 'country', 'createdAt', 'updatedAt', 'usage'],
} as const;

const partiesListResponseSchema = {
  $id: 'partiesListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'partiesDetailResponseSchema#' } },
    total: { type: 'integer', description: 'How many parties match, whatever the page.' },
    limit: { type: 'integer' },
    nextCursor: { type: ['string', 'null'] },
  },
  required: ['items', 'total', 'limit', 'nextCursor'],
} as const;

const partiesDeleteResponseSchema = {
  $id: 'partiesDeleteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: { message: { type: 'string' } },
  required: ['message'],
} as const;

export const partiesDtoSchemas = [
  partiesParamsSchema,
  partiesCreateBodySchema,
  partiesUpdateBodySchema,
  partiesListQuerySchema,
  partyUsageSchema,
  partiesPartyResponseSchema,
  partiesDetailResponseSchema,
  partiesListResponseSchema,
  partiesDeleteResponseSchema,
];
