import { idPathParam } from '@schemas/idPathParam.js';

const favoritesGetQuerySchema = {
  $id: 'favoritesGetQuerySchema',
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
      description: 'The nextCursor of the previous page.',
    },
  },
} as const;

const favoritesFavoriteItemSchema = {
  $id: 'favoritesFavoriteItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    product: { $ref: 'productItemResponseSchema#' },
    variant: { $ref: 'variantShortSchema#' },
    addedAt: { type: 'string', format: 'date-time' },
  },
  required: ['product', 'variant', 'addedAt'],
} as const;

const favoritesGetResponseSchema = {
  $id: 'favoritesGetResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'favoritesFavoriteItemSchema#' } },
    nextCursor: {
      anyOf: [{ type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' }, { type: 'null' }],
    },
  },
  required: ['items', 'nextCursor'],
} as const;

const favoritesAddParamsSchema = {
  $id: 'favoritesAddParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    variantId: idPathParam('the variant'),
  },
  required: ['variantId'],
} as const;

const favoritesAddResponseSchema = {
  $id: 'favoritesAddResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    variantId: { type: 'integer', minimum: 1 },
    isFavorite: { const: true },
  },
  required: ['variantId', 'isFavorite'],
} as const;

const favoritesDeleteParamsSchema = {
  $id: 'favoritesDeleteParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    variantId: idPathParam('the variant'),
  },
  required: ['variantId'],
} as const;

const favoritesDeleteResponseSchema = {
  $id: 'favoritesDeleteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    variantId: { type: 'integer', minimum: 1 },
    isFavorite: { const: false },
  },
  required: ['variantId', 'isFavorite'],
} as const;

export const favoritesDtoSchemas = [
  favoritesGetQuerySchema,
  favoritesFavoriteItemSchema,
  favoritesGetResponseSchema,
  favoritesAddParamsSchema,
  favoritesAddResponseSchema,
  favoritesDeleteParamsSchema,
  favoritesDeleteResponseSchema,
];
