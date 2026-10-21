import { idPathParam, MAX_ID } from '@schemas/idPathParam.js';

// the id of a parent category, a whole number in the range of the ids of postgres
const parentIdField = {
  type: 'integer',
  minimum: 1,
  maximum: MAX_ID,
  description: `The parent category, a whole number from 1 to ${MAX_ID}.`,
} as const;

export const categoriesGetQuerySchema = {
  $id: 'categoriesGetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' },

    search: { type: 'string' },
    parentId: { ...parentIdField, description: 'Only the direct children of this category.' },
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
    slug: {
      type: 'string',
      description:
        'The part of the address of the category page, for example phones. The server keeps small ' +
        'latin letters and digits, any other sign becomes a dash, so a slug of other letters only ' +
        'is refused (CATEGORY_SLUG_INVALID). Unique (CATEGORY_SLUG_TAKEN).',
    },
    description: { type: 'string' },
    parentId: parentIdField,
  },
  required: ['name', 'slug'],
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
    categoryId: idPathParam('the category'),
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
    parentId: {
      type: ['integer', 'null'],
      minimum: 1,
      maximum: MAX_ID,
      description:
        `The new parent category, a whole number from 1 to ${MAX_ID}; null moves the category to the ` +
        'top. The category moves with its whole branch, never inside its own branch ' +
        '(CATEGORY_PARENT_CYCLE).',
    },
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
    categoryId: idPathParam('the category'),
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
