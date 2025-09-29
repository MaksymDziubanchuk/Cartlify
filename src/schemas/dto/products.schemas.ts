export const createProductSchema = {
  $id: 'products.createBody',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    price: { type: 'number', minimum: 0 },
    categoryId: { type: 'integer', minimum: 1 },
    imageUrl: { type: 'string', format: 'uri' },
  },
  required: ['name', 'price', 'categoryId'],
  additionalProperties: false,
} as const;

export const updateProductSchema = {
  $id: 'products.updateBody',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    price: { type: 'number', minimum: 0 },
    categoryId: { type: 'integer', minimum: 1 },
    imageUrl: { type: 'string', format: 'uri' },
  },
  additionalProperties: false,
} as const;

export const createReviewSchema = {
  $id: 'reviews.createBody',
  type: 'object',
  properties: {
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    comment: { type: 'string' },
  },
  required: ['rating'],
  additionalProperties: false,
} as const;

export const updateReviewSchema = {
  $id: 'reviews.updateBody',
  type: 'object',
  properties: {
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    comment: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export const productsListQuerySchema = {
  $id: 'products.listQuery',
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    search: { type: 'string' },
    categoryId: { type: 'integer', minimum: 1 },
    minPrice: { type: 'number', minimum: 0 },
    maxPrice: { type: 'number', minimum: 0 },
    sortBy: { type: 'string', enum: ['price', 'name', 'createdAt'] },
    order: { type: 'string', enum: ['asc', 'desc'] },
  },
  additionalProperties: false,
} as const;

const productResponseSchema = {
  $id: 'products.item',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    name: { type: 'string' },
    description: { type: 'string' },
    price: { type: 'number' },
    categoryId: { type: 'integer' },
    imageUrl: { type: 'string', format: 'uri' },
  },
  required: ['id', 'name', 'price', 'categoryId'],
  additionalProperties: false,
} as const;

const reviewResponseSchema = {
  $id: 'reviews.item',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    productId: { type: 'integer' },
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    comment: { type: 'string' },
    userId: { type: 'string' },
  },
  required: ['id', 'productId', 'rating', 'userId'],
  additionalProperties: false,
} as const;

const productsListResponseSchema = {
  $id: 'products.listResponse',
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { $ref: 'products.item#' },
    },
    total: { type: 'integer', minimum: 0 },
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1 },
  },
  required: ['items', 'total', 'page', 'limit'],
  additionalProperties: false,
} as const;

export const productDtoSchemas = {
  createProductSchema,
  updateProductSchema,
  createReviewSchema,
  updateReviewSchema,
  productsListQuerySchema,
  productResponseSchema,
  reviewResponseSchema,
  productsListResponseSchema,
};
