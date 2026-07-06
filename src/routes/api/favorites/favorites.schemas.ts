import type { FastifySchema } from 'fastify';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const getFavoritesSchema = {
  querystring: { $ref: 'favoritesGetQuerySchema#' },
  response: {
    200: { $ref: 'favoritesGetResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const postAddFavoriteSchema = {
  params: { $ref: 'favoritesAddParamsSchema#' },
  response: {
    200: { $ref: 'favoritesAddResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const deleteFavoriteSchema = {
  params: { $ref: 'favoritesDeleteParamsSchema#' },
  response: {
    200: { $ref: 'favoritesDeleteResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const favoritesSchema = withOpenApiTag(
  {
    getFavoritesSchema,
    postAddFavoriteSchema,
    deleteFavoriteSchema,
  },
  'favorites',
);