const getAllProductsQuerySchema = {
  $id: 'getAllProductsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    // cursor pagination
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: { type: 'string', minLength: 1 },

    // filters
    search: { type: 'string', minLength: 1 },
    categoryIds: {
      type: 'array',
      items: { type: 'integer', minimum: 1 },
      minItems: 1,
      uniqueItems: true,
    },
    minPrice: { type: 'number', minimum: 0 },
    maxPrice: { type: 'number', minimum: 0 },

    deleted: { type: 'boolean' },
    inStock: { type: 'boolean' },

    // sorting
    sort: {
      type: 'string',
      enum: [
        'createdAt',
        'updatedAt',
        'deletedAt',
        'price',
        'popularity',
        'views',
        'avgRating',
        'reviewsCount',
        'stock',
        'name',
      ],
    },
    order: { type: 'string', enum: ['asc', 'desc'] },
  },
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
    stock: { type: 'number' },
    categoryId: { type: 'integer' },

    images: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url200: { type: 'string' },
          url400: { type: 'string' },
          url800: { type: 'string' },
        },
        required: ['url200', 'url400', 'url800'],
      },
    },

    views: { type: 'integer' },
    popularity: { type: 'integer' },

    avgRating: { type: 'number' },
    reviewsCount: { type: 'integer' },

    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    deletedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
  },
  required: [
    'id',
    'name',
    'price',
    'stock',
    'categoryId',
    'images',
    'views',
    'popularity',
    'avgRating',
    'reviewsCount',
    'createdAt',
    'updatedAt',
  ],
} as const;

const productItemResponseSchema = {
  $id: 'productItemResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'integer' },

    name: { type: 'string' },
    description: { type: 'string' },

    price: { type: 'number' },
    stock: { type: 'integer' },

    categoryId: { type: 'integer' },

    // single "primary" image urls (not array)
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

    popularity: { type: 'integer' },
    views: { type: 'integer' },
    avgRating: { type: 'number' },
    reviewsCount: { type: 'integer' },

    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    deletedAt: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
  },
  required: [
    'id',
    'name',
    'price',
    'stock',
    'categoryId',
    'images',
    'popularity',
    'views',
    'avgRating',
    'reviewsCount',
    'createdAt',
    'updatedAt',
  ],
} as const;

const productsListResponseSchema = {
  $id: 'productsListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      items: { $ref: 'productItemResponseSchema#' },
    },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    nextCursor: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
  },
  required: ['items', 'limit'],
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
  required: ['id', 'productId', 'userId', 'createdAt', 'updatedAt'],
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

const createProductBodySchema = {
  $id: 'createProductBodySchema',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    price: { type: 'number', minimum: 0 },
    stock: { type: 'integer', minimum: 0 },
    categoryId: { type: 'integer', minimum: 1 },
    images: { type: 'array', items: { type: 'object' } },
  },
  required: ['name', 'price', 'stock', 'categoryId'],
  additionalProperties: false,
} as const;

const updateProductBodySchema = {
  $id: 'updateProductBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },

    price: { type: 'number', minimum: 0 },

    stock: { type: 'integer', minimum: 0 },

    categoryId: { type: 'integer', minimum: 1 },

    images: { type: 'array', items: { type: 'object' } },

    popularityOverride: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },

    popularityOverrideUntil: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
  },
} as const;

const bulkUpdateProductsPriceBodySchema = {
  $id: 'bulkUpdateProductsPriceBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    mode: { type: 'string', enum: ['percent', 'fixed'] },
    value: { type: 'number' },

    scope: {
      type: 'object',
      additionalProperties: false,
      properties: {
        categoryId: { type: 'integer', minimum: 1 },
        productIds: {
          type: 'array',
          items: { type: 'integer', minimum: 1 },
          minItems: 1,
          uniqueItems: true,
        },

        minPrice: { type: 'number', minimum: 0 },
        maxPrice: { type: 'number', minimum: 0 },

        inStock: { type: 'boolean' },
        deleted: { type: 'boolean' },
      },
    },

    dryRun: { type: 'boolean' },
    reason: { type: 'string', minLength: 1, maxLength: 200 },
  },
  required: ['mode', 'value'],
} as const;

const bulkUpdateProductsPriceResponseSchema = {
  $id: 'bulkUpdateProductsPriceResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
    updatedCount: { type: 'integer', minimum: 0 },
  },
  required: ['message', 'updatedCount'],
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
  bulkUpdateProductsPriceBodySchema,
  bulkUpdateProductsPriceResponseSchema,
  createReviewBodySchema,
  productResponseSchema,
  getProductReviewsQuerySchema,
  reviewResponseSchema,
  reviewsResponseSchema,
  deleteProductReviewParamsSchema,
  productsListResponseSchema,
  productItemResponseSchema,
  productsUpdateCategoryParamsSchema,
  productsUpdateCategoryBodySchema,
  productsUpdateCategoryResponseSchema,
];
