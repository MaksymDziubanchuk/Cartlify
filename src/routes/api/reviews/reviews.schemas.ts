import type { FastifySchema } from 'fastify';

export const postVoteReviewSchema = {
  params: { $ref: 'reviewsVoteParamsSchema#' },
  body: { $ref: 'reviewsVoteBodySchema#' },
  response: {
    200: { $ref: 'reviewsVoteResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const reviewsSchemas = {
  postVoteReviewSchema,
};
