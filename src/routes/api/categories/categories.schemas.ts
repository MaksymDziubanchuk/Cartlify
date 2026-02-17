import type { FastifySchema } from 'fastify';

export const getCategoriesSchema = {
  querystring: { $ref: 'categoriesGetQuerySchema#' },
  response: {
    200: { $ref: 'categoriesListResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const postCategorySchema = {
  body: { $ref: 'categoriesCreateBodySchema#' },
  response: {
    201: { $ref: 'categoriesCreateResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const patchCategorySchema = {
  params: { $ref: 'categoriesUpdateParamsSchema#' },
  body: { $ref: 'categoriesUpdateBodySchema#' },
  response: {
    200: { $ref: 'categoriesUpdateResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const deleteCategorySchema = {
  params: { $ref: 'categoriesDeleteParamsSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const categoriesSchema = {
  getCategoriesSchema,
  postCategorySchema,
  patchCategorySchema,
  deleteCategorySchema,
};
