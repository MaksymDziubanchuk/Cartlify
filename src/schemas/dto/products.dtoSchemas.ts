export const getAllProductsQuerySchema = {
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

export const createProductBodySchema = {
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

export const updateProductBodySchema = {
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

export const createReviewBodySchema = {
  $id: 'createReviewBodySchema',
  type: 'object',
  properties: {
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    comment: { type: 'string' },
  },
  required: ['rating'],
  additionalProperties: false,
} as const;

export const updateReviewBodySchema = {
  $id: 'updateReviewBodySchema',
  type: 'object',
  properties: {
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    comment: { type: 'string' },
  },
  additionalProperties: false,
} as const;

export const productsListQuerySchema = {
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

export const productResponseSchema = {
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

export const reviewResponseSchema = {
  $id: 'reviewResponseSchema',
  type: 'object',
  properties: {
    id: { type: 'integer' },
    productId: { type: 'integer' },
    rating: { type: 'integer', minimum: 1, maximum: 5 },
    comment: { type: 'string' },
    userId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
  },
  required: ['id', 'productId', 'rating', 'userId'],
  additionalProperties: false,
} as const;

export const productsListResponseSchema = {
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

export const productsUpdateCategoryParamsSchema = {
  $id: 'productsUpdateCategoryParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'number' },
  },
  required: ['productId'],
} as const;

export const productsUpdateCategoryBodySchema = {
  $id: 'productsUpdateCategoryBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    categoryId: { type: 'number' },
  },
  required: ['categoryId'],
} as const;

export const productsRemoveCategoryParamsSchema = {
  $id: 'productsRemoveCategoryParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'number' },
  },
  required: ['productId'],
} as const;

export const productsUpdateCategoryResponseSchema = {
  $id: 'productsUpdateCategoryResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
} as const;

export const productsRemoveCategoryResponseSchema = {
  $id: 'productsRemoveCategoryResponseSchema',
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
  updateReviewBodySchema,
  productsListQuerySchema,
  productResponseSchema,
  reviewResponseSchema,
  productsListResponseSchema,
  productsUpdateCategoryParamsSchema,
  productsUpdateCategoryBodySchema,
  productsRemoveCategoryParamsSchema,
  productsUpdateCategoryResponseSchema,
  productsRemoveCategoryResponseSchema,
];
