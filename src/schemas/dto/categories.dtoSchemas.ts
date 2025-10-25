export const categoriesGetQuerySchema = {
  $id: 'categoriesGetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'number', minimum: 1 },
    limit: { type: 'number', minimum: 1 },
    search: { type: 'string' },
    parentId: { type: 'number', minimum: 1 },
  },
} as const;

export const categoriesCategoryResponseSchema = {
  $id: 'categoriesCategoryResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    name: { type: 'string' },
    slug: { type: 'string' },
    description: { type: 'string' },
    parentId: { type: 'number' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },

  required: ['id', 'name', 'createdAt', 'updatedAt'],
} as const;

export const categoriesListResponseSchema = {
  $id: 'categoriesListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'categoriesCategoryResponseSchema#' } },
    page: { type: 'number' },
    limit: { type: 'number' },
    total: { type: 'number' },
  },
  required: ['items'],
} as const;

export const categoriesCreateBodySchema = {
  $id: 'categoriesCreateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    slug: { type: 'string' },
    description: { type: 'string' },
    parentId: { type: 'number' },
  },
  required: ['name'],
} as const;

export const categoriesCreateResponseSchema = {
  $id: 'categoriesCreateResponseSchema',
  allOf: [{ $ref: 'categoriesCategoryResponseSchema#' }],
} as const;

export const categoriesUpdateParamsSchema = {
  $id: 'categoriesUpdateParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    categoryId: { type: 'number' },
  },
  required: ['categoryId'],
} as const;

export const categoriesUpdateBodySchema = {
  $id: 'categoriesUpdateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    slug: { type: 'string' },
    description: { type: 'string' },
    parentId: { type: 'number' },
  },
} as const;

export const categoriesUpdateResponseSchema = {
  $id: 'categoriesUpdateResponseSchema',
  allOf: [{ $ref: 'categoriesCategoryResponseSchema#' }],
} as const;

export const categoriesDeleteParamsSchema = {
  $id: 'categoriesDeleteParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    categoryId: { type: 'number' },
  },
  required: ['categoryId'],
} as const;

export const categoriesDeleteResponseSchema = {
  $id: 'categoriesDeleteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
} as const;

export const categoriesDtoSchemas = [
  categoriesGetQuerySchema,
  categoriesCategoryResponseSchema,
  categoriesListResponseSchema,
  categoriesCreateBodySchema,
  categoriesCreateResponseSchema,
  categoriesUpdateParamsSchema,
  categoriesUpdateBodySchema,
  categoriesUpdateResponseSchema,
  categoriesDeleteParamsSchema,
  categoriesDeleteResponseSchema,
];
