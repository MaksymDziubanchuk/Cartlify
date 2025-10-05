import type { FastifySchema } from 'fastify';

export const getStatsSchema = {
  querystring: { $ref: 'adminStatsQuerySchema#' },
  response: {
    200: { $ref: 'adminStatsResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const setProductPopularitySchema = {
  params: { $ref: 'adminSetPopularityParamsSchema#' },
  body: { $ref: 'adminSetPopularityBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const getChatsSchema = {
  querystring: { $ref: 'adminChatsQuerySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const adminSchema = {
  getStatsSchema,
  setProductPopularitySchema,
  getChatsSchema,
};
