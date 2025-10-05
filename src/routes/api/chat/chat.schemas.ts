import type { FastifySchema } from 'fastify';

export const getChatsSchema = {
  querystring: { $ref: 'chatsGetQuerySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const chatsSchemas = {
  getChatsSchema,
};
