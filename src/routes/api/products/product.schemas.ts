import type { FastifySchema } from 'fastify';

const getAllProductsRouterSchema = {
  querystring: { $ref: 'getAllProductsQuerySchema#' },
  response: {
    200: { $ref: 'productsListResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const getProductByIdRouterSchema = {
  params: { $ref: 'productIdParamSchema#' },
  response: {
    200: { $ref: 'productResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const getProductReviewsRouterSchema = {
  params: { $ref: 'productIdParamSchema#' },
  querystring: { $ref: 'getProductReviewsQuerySchema#' },
  response: {
    200: { $ref: 'reviewsResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const postProductRouterSchema = {
  body: { $ref: 'createProductBodySchema#' },
  response: {
    201: { $ref: 'productResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const postProductReviewRouterSchema = {
  params: { $ref: 'productIdParamSchema#' },
  body: { $ref: 'createReviewBodySchema#' },
  response: {
    201: { $ref: 'reviewResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const updateProductByIdRouterSchema = {
  params: { $ref: 'productIdParamSchema#' },
  body: { $ref: 'updateProductBodySchema#' },
  response: {
    200: { $ref: 'productResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const patchProductsBulkPriceRouterSchema = {
  body: { $ref: 'bulkUpdateProductsPriceBodySchema#' },
  response: {
    200: { $ref: 'bulkUpdateProductsPriceResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
    501: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const deleteProductByIdRouterSchema = {
  params: { $ref: 'productIdParamSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const deleteProductReviewRouterSchema = {
  params: { $ref: 'deleteProductReviewParamsSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const patchProductCategorySchema = {
  params: { $ref: 'productsUpdateCategoryParamsSchema#' },
  body: { $ref: 'productsUpdateCategoryBodySchema#' },
  response: {
    200: { $ref: 'productResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const productSchemas = {
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
};
