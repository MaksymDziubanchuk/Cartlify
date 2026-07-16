import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const productImageUrlsExample = {
  url200: 'https://example.com/products/headphones-200.webp',
  url400: 'https://example.com/products/headphones-400.webp',
  url800: 'https://example.com/products/headphones-800.webp',
};

const productListItemExample = {
  id: 10,
  name: 'Wireless headphones',
  description: 'Bluetooth headphones with noise cancellation.',
  price: 49.99,
  stock: 15,
  categoryId: 1,
  images: productImageUrlsExample,
  popularity: 120,
  views: 350,
  avgRating: 4.7,
  reviewsCount: 18,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  deletedAt: null,
};

const productResponseExample = {
  ...productListItemExample,
  images: [productImageUrlsExample],
};

const productsQueryExample = {
  limit: 20,
  search: 'headphones',
  categoryIds: '1,2',
  minPrice: 10,
  maxPrice: 100,
  deleted: false,
  inStock: true,
  sort: 'popularity',
  order: 'desc',
};

const productsListResponseExample = {
  items: [productListItemExample],
  limit: 20,
  nextCursor: 'eyJpZCI6MTB9',
};

const productIdParamsExample = {
  productId: 10,
};

const productReviewsQueryExample = {
  limit: 10,
  cursor: 'eyJpZCI6MX0',
};

const reviewExample = {
  id: 1,
  productId: 10,
  rating: 5,
  comment: 'Great product.',
  userId: 1,
  upVotes: 3,
  downVotes: 0,
  userVote: 'up',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
};

const reviewsResponseExample = {
  items: [reviewExample],
  limit: 10,
  total: 1,
  nextCursor: 'eyJpZCI6MX0',
};

const createProductBodyExample = {
  name: 'Wireless headphones',
  description: 'Bluetooth headphones with noise cancellation.',
  price: 49.99,
  stock: 15,
  categoryId: 1,
  images: [
    {
      filename: 'headphones.webp',
      mimetype: 'image/webp',
    },
  ],
};

const createReviewBodyExample = {
  rating: 5,
  comment: 'Great product.',
};

const updateProductBodyExample = {
  name: 'Wireless headphones Pro',
  description: 'Updated product description.',
  price: 59.99,
  stock: 20,
  categoryId: 1,
  popularityOverride: 500,
  popularityOverrideUntil: '2026-02-01T10:00:00.000Z',
};

const bulkUpdateProductsPriceBodyExample = {
  mode: 'percent',
  value: 10,
  scope: {
    categoryId: 1,
    productIds: [10, 11],
    minPrice: 10,
    maxPrice: 100,
    inStock: true,
    deleted: false,
  },
  dryRun: false,
  reason: 'Seasonal price update',
};

const bulkUpdateProductsPriceResponseExample = {
  message: 'Products price updated successfully.',
  updatedCount: 12,
};

const deleteProductReviewParamsExample = {
  productId: 10,
  reviewId: 1,
};

const updateProductCategoryBodyExample = {
  categoryId: 2,
};

const messageResponseExample = {
  message: 'Operation completed successfully.',
};

// Schema for catalog product listing
const getAllProductsRouterSchema = {
  operationId: 'getProducts',
  summary: 'Get products',
  description: 'Returns a paginated product list with filtering, sorting and search support.',

  querystring: {
    $ref: 'getAllProductsQuerySchema#',
    examples: [productsQueryExample],
  },

  response: {
    200: {
      description: 'Products were returned successfully.',
      $ref: 'productsListResponseSchema#',
      examples: [productsListResponseExample],
    },

    400: {
      description: 'Invalid products query parameters.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to read products.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to read products.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading products.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for single product lookup
const getProductByIdRouterSchema = {
  operationId: 'getProductById',
  summary: 'Get product by id',
  description: 'Returns product details by product id.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  response: {
    200: {
      description: 'Product was returned successfully.',
      $ref: 'productResponseSchema#',
      examples: [productResponseExample],
    },

    400: {
      description: 'Invalid product id.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to read this product.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to read this product.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product was not found.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading product.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for product reviews listing
const getProductReviewsRouterSchema = {
  operationId: 'getProductReviews',
  summary: 'Get product reviews',
  description: 'Returns a paginated list of reviews for a product.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  querystring: {
    $ref: 'getProductReviewsQuerySchema#',
    examples: [productReviewsQueryExample],
  },

  response: {
    200: {
      description: 'Product reviews were returned successfully.',
      $ref: 'reviewsResponseSchema#',
      examples: [reviewsResponseExample],
    },

    400: {
      description: 'Invalid product reviews request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to read product reviews.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to read product reviews.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product was not found.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading product reviews.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin product creation
const postProductRouterSchema = {
  operationId: 'createProduct',
  summary: 'Create product',
  description: 'Creates a new product. This operation is restricted to privileged users.',

  body: {
    $ref: 'createProductBodySchema#',
    examples: [createProductBodyExample],
  },

  response: {
    201: {
      description: 'Product was created successfully.',
      $ref: 'productResponseSchema#',
      examples: [productResponseExample],
    },

    400: {
      description: 'Invalid product creation request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to create a product.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to create products.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Product creation conflicts with existing data.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Product creation payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while creating product.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for authenticated user product review creation
const postProductReviewRouterSchema = {
  operationId: 'createProductReview',
  summary: 'Create product review',
  description: 'Creates a review for a product by the authenticated user.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  body: {
    $ref: 'createReviewBodySchema#',
    examples: [createReviewBodyExample],
  },

  response: {
    201: {
      description: 'Product review was created successfully.',
      $ref: 'reviewResponseSchema#',
      examples: [reviewExample],
    },

    400: {
      description: 'Invalid product review request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to create a product review.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only authenticated users with the USER role can create product reviews.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Review conflicts with the current product or user state.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Review payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while creating product review.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin product update
const updateProductByIdRouterSchema = {
  operationId: 'updateProductById',
  summary: 'Update product by id',
  description: 'Updates product details by product id. This operation is restricted to privileged users.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  body: {
    $ref: 'updateProductBodySchema#',
    examples: [updateProductBodyExample],
  },

  response: {
    200: {
      description: 'Product was updated successfully.',
      $ref: 'productResponseSchema#',
      examples: [
        {
          ...productResponseExample,
          name: 'Wireless headphones Pro',
          description: 'Updated product description.',
          price: 59.99,
          stock: 20,
          updatedAt: '2026-01-02T10:00:00.000Z',
        },
      ],
    },

    400: {
      description: 'Invalid product update request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update a product.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to update products.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Product update conflicts with existing data.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Product update payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating product.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin bulk product price update
const patchProductsBulkPriceRouterSchema = {
  operationId: 'bulkUpdateProductPrices',
  summary: 'Bulk update product prices',
  description: 'Updates product prices in bulk using selected filters and update mode.',

  body: {
    $ref: 'bulkUpdateProductsPriceBodySchema#',
    examples: [bulkUpdateProductsPriceBodyExample],
  },

  response: {
    200: {
      description: 'Product prices were updated successfully.',
      $ref: 'bulkUpdateProductsPriceResponseSchema#',
      examples: [bulkUpdateProductsPriceResponseExample],
    },

    400: {
      description: 'Invalid bulk price update request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update product prices.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to update product prices.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Bulk price update conflicts with product state.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Bulk price update payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating product prices.',
      $ref: 'errorResponseSchema#',
    },
    501: {
      description: 'Bulk price update mode is not implemented.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin product deletion
const deleteProductByIdRouterSchema = {
  operationId: 'deleteProductById',
  summary: 'Delete product by id',
  description: 'Deletes or soft-deletes a product by product id. This operation is restricted to privileged users.',

  params: {
    $ref: 'productIdParamSchema#',
    examples: [productIdParamsExample],
  },

  response: {
    200: {
      description: 'Product was deleted successfully.',
      $ref: 'messageResponseSchema#',
      examples: [messageResponseExample],
    },

    400: {
      description: 'Invalid product delete request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to delete a product.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to delete products.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product was not found.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting product.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for product review deletion
const deleteProductReviewRouterSchema = {
  operationId: 'deleteProductReview',
  summary: 'Delete product review',
  description: 'Deletes a product review by product id and review id.',

  params: {
    $ref: 'deleteProductReviewParamsSchema#',
    examples: [deleteProductReviewParamsExample],
  },

  response: {
    200: {
      description: 'Product review was deleted successfully.',
      $ref: 'messageResponseSchema#',
      examples: [messageResponseExample],
    },

    400: {
      description: 'Invalid product review delete request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to delete a product review.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to delete this product review.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product review was not found.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting product review.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin product category update
const patchProductCategorySchema = {
  operationId: 'updateProductCategory',
  summary: 'Update product category',
  description: 'Moves a product to another category. This operation is restricted to privileged users.',

  params: {
    $ref: 'productsUpdateCategoryParamsSchema#',
    examples: [productIdParamsExample],
  },

  body: {
    $ref: 'productsUpdateCategoryBodySchema#',
    examples: [updateProductCategoryBodyExample],
  },

  response: {
    200: {
      description: 'Product category was updated successfully.',
      $ref: 'productsUpdateCategoryResponseSchema#',
      examples: [
        {
          ...productResponseExample,
          categoryId: 2,
          updatedAt: '2026-01-02T10:00:00.000Z',
        },
      ],
    },

    400: {
      description: 'Invalid product category update request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update product category.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to update product category.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Product or category was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Product category update conflicts with current product state.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Product category update payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating product category.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group product routes under the products Swagger tag
const taggedProductSchemas = withOpenApiTag(
  {
    getAllProductsRouterSchema,
    getProductByIdRouterSchema,
    getProductReviewsRouterSchema,
    postProductRouterSchema,
    postProductReviewRouterSchema,
    updateProductByIdRouterSchema,
    patchProductsBulkPriceRouterSchema,
    deleteProductByIdRouterSchema,
    deleteProductReviewRouterSchema,
    patchProductCategorySchema,
  },
  'products',
);

// Add guest or user cookie security to catalog read routes
const productSchemasWithGuestSecurity = withOpenApiSecurityFor(
  taggedProductSchemas,
  openApiSecurity.userOrGuestCookie,
  [
    'getAllProductsRouterSchema',
    'getProductByIdRouterSchema',
    'getProductReviewsRouterSchema',
  ],
);

// Add access token security to product write and review write routes
export const productSchemas = withOpenApiSecurityFor(
  productSchemasWithGuestSecurity,
  openApiSecurity.accessTokenCookie,
  [
    'postProductRouterSchema',
    'postProductReviewRouterSchema',
    'updateProductByIdRouterSchema',
    'patchProductsBulkPriceRouterSchema',
    'deleteProductByIdRouterSchema',
    'deleteProductReviewRouterSchema',
    'patchProductCategorySchema',
  ],
);