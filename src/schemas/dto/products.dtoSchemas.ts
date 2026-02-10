const getAllProductsQuerySchema = {
  $id: 'getAllProductsQuerySchema',
  type: 'object',
  properties: {
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    sort: { type: 'string', enum: ['price_asc', 'price_desc', 'popular'] },
    categoryId: { type: 'integer', minimum: 1 },
  },
  additionalProperties: false,
} as const;

const createProductBodySchema = {
  $id: 'createProductBodySchema',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    price: { type: 'number', minimum: 0 },
    categoryId: { type: 'integer', minimum: 1 },
    images: { type: 'array', items: { type: 'object' } },
  },
  required: ['name', 'price', 'categoryId'],
  additionalProperties: false,
} as const;

const updateProductBodySchema = {
  $id: 'updateProductBodySchema',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    price: { type: 'number', minimum: 0 },
    categoryId: { type: 'integer', minimum: 1 },
    images: { type: 'array', items: { type: 'object' } },
  },
  additionalProperties: false,
} as const;

const createReviewBodySchema = {
  $id: 'createReviewBodySchema',
  type: 'object',
  properties: {
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    comment: { type: 'string' },
  },
  additionalProperties: false,
} as const;

const productsListQuerySchema = {
  $id: 'productsListQuerySchema',
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
  $id: 'productResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },

    name: { type: 'string' },
    description: { type: 'string' },

    price: { type: 'number' },
    categoryId: { type: 'integer' },

    images: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url200: { type: 'string' },
        url400: { type: 'string' },
        url800: { type: 'string' },
      },
      required: ['url200', 'url400', 'url800'],
    },

    views: { type: 'integer' },
    popularity: { type: 'integer' },

    avgRating: { type: 'number' },
    reviewsCount: { type: 'integer' },

    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: [
    'id',
    'name',
    'price',
    'categoryId',
    'views',
    'popularity',
    'avgRating',
    'reviewsCount',
    'createdAt',
    'updatedAt',
  ],
} as const;

const productsListResponseSchema = {
  $id: 'productsListResponseSchema',
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { $ref: 'productResponseSchema#' },
    },
    total: { type: 'integer', minimum: 0 },
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1 },
  },
  required: ['items', 'total', 'page', 'limit'],
  additionalProperties: false,
} as const;

const getProductReviewsQuerySchema = {
  $id: 'getProductReviewsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    cursorId: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
} as const;

const reviewResponseSchema = {
  $id: 'reviewResponseSchema',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    productId: { type: 'integer' },
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    comment: { type: 'string' },
    userId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'productId', 'rating', 'userId', 'createdAt', 'updatedAt'],
  additionalProperties: false,
} as const;

const reviewsResponseSchema = {
  $id: 'reviewsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: { $ref: 'reviewResponseSchema#' },
    },
    limit: { type: 'integer' },
    total: { type: 'integer' },
    nextCursorId: { type: 'integer' },
  },
  required: ['items', 'limit', 'total'],
} as const;

const deleteProductReviewParamsSchema = {
  $id: 'deleteProductReviewParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'integer', minimum: 1 },
    reviewId: { type: 'integer', minimum: 1 },
  },
  required: ['productId', 'reviewId'],
} as const;

const productsUpdateCategoryParamsSchema = {
  $id: 'productsUpdateCategoryParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'number' },
  },
  required: ['productId'],
} as const;

const productsUpdateCategoryBodySchema = {
  $id: 'productsUpdateCategoryBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    categoryId: { type: 'number' },
  },
  required: ['categoryId'],
} as const;

const productsUpdateCategoryResponseSchema = {
  $id: 'productsUpdateCategoryResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
} as const;

export const productDtoSchemas = [
  getAllProductsQuerySchema,
  createProductBodySchema,
  updateProductBodySchema,
  createReviewBodySchema,
  productsListQuerySchema,
  productResponseSchema,
  getProductReviewsQuerySchema,
  reviewResponseSchema,
  reviewsResponseSchema,
  deleteProductReviewParamsSchema,
  productsListResponseSchema,
  productsUpdateCategoryParamsSchema,
  productsUpdateCategoryBodySchema,
  productsUpdateCategoryResponseSchema,
];
