export const categoriesGetQuerySchema = {
  $id: 'categoriesGetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'number', minimum: 1, maximum: 100 },
    cursor: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' },

    search: { type: 'string' },
    parentId: { type: 'number', minimum: 1 },
  },
} as const;

const categoriesCategoryResponseSchema = {
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
    limit: { type: 'number' },
    nextCursor: {
      anyOf: [{ type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 1 }, { type: 'null' }],
    },
  },
  required: ['items', 'limit'],
} as const;

const categoriesCreateBodySchema = {
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

const categoriesCreateResponseSchema = {
  $id: 'categoriesCreateResponseSchema',
  allOf: [{ $ref: 'categoriesCategoryResponseSchema#' }],
} as const;

const categoriesUpdateParamsSchema = {
  $id: 'categoriesUpdateParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    categoryId: { type: 'number' },
  },
  required: ['categoryId'],
} as const;

const categoriesUpdateBodySchema = {
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

const categoriesUpdateResponseSchema = {
  $id: 'categoriesUpdateResponseSchema',
  allOf: [{ $ref: 'categoriesCategoryResponseSchema#' }],
} as const;

const categoriesDeleteParamsSchema = {
  $id: 'categoriesDeleteParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    categoryId: { type: 'number' },
  },
  required: ['categoryId'],
} as const;

const categoriesDeleteResponseSchema = {
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
