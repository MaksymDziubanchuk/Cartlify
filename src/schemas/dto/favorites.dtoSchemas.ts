export const favoritesGetQuerySchema = {
  $id: 'favoritesGetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' },
  },
} as const;

export const favoritesFavoriteItemSchema = {
  $id: 'favoritesFavoriteItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    product: { $ref: 'productItemResponseSchema#' },
    addedAt: { type: 'string', format: 'date-time' },
  },
  required: ['product', 'addedAt'],
} as const;

export const favoritesGetResponseSchema = {
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

export const favoritesAddParamsSchema = {
  $id: 'favoritesAddParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'number' },
  },
  required: ['productId'],
} as const;

export const favoritesAddResponseSchema = {
  $id: 'favoritesAddResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'integer', minimum: 1 },
    isFavorite: { const: true },
  },
  required: ['productId', 'isFavorite'],
} as const;

export const favoritesDeleteParamsSchema = {
  $id: 'favoritesDeleteParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'integer', minimum: 1 },
  },
  required: ['productId'],
} as const;

export const favoritesDeleteResponseSchema = {
  $id: 'favoritesDeleteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'integer', minimum: 1 },
    isFavorite: { const: false },
  },
  required: ['productId', 'isFavorite'],
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
