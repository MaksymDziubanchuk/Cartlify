import { avatarIsDefaultField, avatarUrlsField } from '@schemas/avatarFields.js';
import { MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';
import { idPathParam } from '@schemas/idPathParam.js';

const MAX_IMAGE_MB = MAX_UPLOAD_SIZE_BYTES / 1_000_000;

// the image files of a product form, in their order: the first is the main image
const productImagesFormField = {
  type: 'array',
  items: { type: 'string', format: 'binary' },
  description:
    'Product images in their order, the first is the main one: jpeg, png or webp files by their ' +
    `content, each up to ${MAX_IMAGE_MB} MB.`,
} as const;

const getAllProductsQuerySchema = {
  $id: 'getAllProductsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    // cursor pagination
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description:
        'nextCursor of the previous page, with the same sort and order. A changed cursor, or one ' +
        'from another sort, is CURSOR_INVALID.',
    },

    // filters
    search: { type: 'string', minLength: 1 },
    categoryIds: {
      type: 'string',
      pattern: '^[0-9]+(,[0-9]+)*$',
      description:
        'Category ids separated by commas, for example 1,2. Ids that are not positive are ' +
        'dropped; a list with no valid id is CATEGORY_IDS_INVALID.',
    },
    minPrice: { type: 'number', minimum: 0 },
    maxPrice: { type: 'number', minimum: 0 },

    deleted: {
      type: 'boolean',
      description:
        'Admin and root only: true lists only deleted products. Without it, or with false, ' +
        'every role gets products that are not deleted.',
    },
    inStock: {
      type: 'boolean',
      description:
        'Free units, the stock the list shows: true lists products with some free, false ' +
        'products with none. Units reserved by confirmed orders are not free.',
    },

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
    nextCursor: {
      anyOf: [{ type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 1 }, { type: 'null' }],
    },
  },
  required: ['items', 'limit'],
} as const;

const getProductReviewsQuerySchema = {
  $id: 'getProductReviewsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', minLength: 1, pattern: '^[A-Za-z0-9_-]+$' },
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
    user: {
      type: 'object',
      additionalProperties: false,
      description:
        'The author. A deleted account stays as the author with deleted: true and the name Guest.',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        avatarUrls: avatarUrlsField,
        avatarIsDefault: avatarIsDefaultField,
        deleted: { type: 'boolean' },
      },
      required: ['id', 'avatarUrls', 'avatarIsDefault', 'deleted'],
    },

    upVotes: { type: 'integer', minimum: 0 },
    downVotes: { type: 'integer', minimum: 0 },
    // null in the enum too: swagger shows the field as nullable, and openapi 3.0 lets null
    // through a nullable enum only when the enum names it
    userVote: { type: 'string', enum: ['up', 'down', null], nullable: true },

    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'productId', 'userId', 'user', 'createdAt', 'updatedAt'],
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
    nextCursor: { type: 'string', pattern: '^[A-Za-z0-9_-]+$', minLength: 1 },
  },
  required: ['items', 'limit', 'total'],
} as const;

const deleteProductReviewParamsSchema = {
  $id: 'deleteProductReviewParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: idPathParam('the product'),
    reviewId: idPathParam('the review'),
  },
  required: ['productId', 'reviewId'],
} as const;

// documentation only: the form of POST /api/products. A form is not checked against a schema,
// the controller and the service check its fields
const productCreateFormSchema = {
  $id: 'productCreateFormSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    price: { type: 'number', minimum: 0 },
    stock: { type: 'integer', minimum: 0, description: 'Units in stock.' },
    categoryId: { type: 'integer', minimum: 1 },
    images: productImagesFormField,
  },
  required: ['name', 'price', 'stock', 'categoryId', 'images'],
} as const;

const updateProductBodySchema = {
  $id: 'updateProductBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },

    price: { type: 'number', minimum: 0 },

    // stock is a delta: positive adds units, negative takes free units off
    stock: { type: 'integer' },

    categoryId: { type: 'integer', minimum: 1 },

    popularityOverride: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },

    popularityOverrideUntil: { anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
  },
} as const;

// documentation only: the form of PATCH /api/products/:productId, the fields of the json body
// and the images; empty or null clears a popularity override
const productUpdateFormSchema = {
  $id: 'productUpdateFormSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    description: { type: 'string' },
    price: { type: 'number', minimum: 0 },
    stock: {
      type: 'integer',
      description: 'A delta: positive adds units, negative takes free units off.',
    },
    categoryId: { type: 'integer', minimum: 1 },
    popularityOverride: {
      type: 'string',
      description: 'A whole number from 0; empty or null clears it.',
    },
    popularityOverrideUntil: {
      type: 'string',
      description: 'A date-time; empty or null clears it.',
    },
    images: {
      ...productImagesFormField,
      description: `${productImagesFormField.description} They replace all images of the product.`,
    },
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
  // the same rule as the db: a review has a rating, a comment or both
  anyOf: [{ required: ['rating'] }, { required: ['comment'] }],
  additionalProperties: false,
} as const;

const productsUpdateCategoryParamsSchema = {
  $id: 'productsUpdateCategoryParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: idPathParam('the product'),
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
  allOf: [{ $ref: 'productResponseSchema#' }],
} as const;

export const productDtoSchemas = [
  getAllProductsQuerySchema,
  productCreateFormSchema,
  updateProductBodySchema,
  productUpdateFormSchema,
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
