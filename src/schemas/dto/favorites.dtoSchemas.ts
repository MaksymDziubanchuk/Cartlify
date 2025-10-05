export const favoritesGetQuerySchema = {
  $id: 'favoritesGetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'number', minimum: 1 },
    limit: { type: 'number', minimum: 1 },
  },
} as const;

export const favoritesFavoriteItemSchema = {
  $id: 'favoritesFavoriteItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    product: { $ref: 'productsProductResponseSchema#' },
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
    page: { type: 'number' },
    limit: { type: 'number' },
    total: { type: 'number' },
  },
  required: ['items'],
} as const;

export const favoritesToggleParamsSchema = {
  $id: 'favoritesToggleParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'number' },
  },
  required: ['productId'],
} as const;

export const favoritesToggleResponseSchema = {
  $id: 'favoritesToggleResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    isFavorite: { type: 'boolean' },
  },
  required: ['isFavorite'],
} as const;

export const favoritesDeleteParamsSchema = {
  $id: 'favoritesDeleteParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'number' },
  },
  required: ['productId'],
} as const;

export const favoritesDeleteResponseSchema = {
  $id: 'favoritesDeleteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
} as const;

export const favoritesDtoSchemas = [
  favoritesGetQuerySchema,
  favoritesFavoriteItemSchema,
  favoritesGetResponseSchema,
  favoritesToggleParamsSchema,
  favoritesToggleResponseSchema,
  favoritesDeleteParamsSchema,
  favoritesDeleteResponseSchema,
];
