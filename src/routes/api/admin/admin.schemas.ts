import type { FastifySchema } from 'fastify';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const getStatsSchema = {
  querystring: { $ref: 'adminStatsQuerySchema#' },
  response: {
    200: { $ref: 'adminStatsResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const adminSchema = withOpenApiTag(
  {
    getStatsSchema,
  },
  'admin',
);