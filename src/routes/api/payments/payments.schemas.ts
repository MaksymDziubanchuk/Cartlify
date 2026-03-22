import type { FastifySchema } from 'fastify';

const postCheckoutSessionSchema = {
  body: { $ref: 'paymentsCreateCheckoutSessionBodySchema#' },
  response: {
    201: { $ref: 'paymentsCheckoutSessionResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const paymentsSchema = {
  postCheckoutSessionSchema,
};
