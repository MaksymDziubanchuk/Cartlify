import type { FastifySchema } from 'fastify';

const getRootAdminsSchema = {
  querystring: { $ref: 'rootAdminsGetQuerySchema#' },
  response: {
    200: { $ref: 'rootAdminsGetResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const postRootAdminSchema = {
  body: { $ref: 'rootAdminsAddBodySchema#' },
  response: {
    201: { $ref: 'rootAdminsAddResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const deleteRootAdminSchema = {
  params: { $ref: 'rootAdminsDeleteParamsSchema#' },
  response: {
    200: { $ref: 'rootAdminsDeleteResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const rootAdminsSchemas = {
  getRootAdminsSchema,
  postRootAdminSchema,
  deleteRootAdminSchema,
};
