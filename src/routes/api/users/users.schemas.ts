import type { FastifySchema } from 'fastify';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const getMeSchema = {
  response: {
    200: { $ref: 'usersUserResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const patchMeSchema = {
  body: { $ref: 'usersUpdateMeBodySchema#' },
  response: {
    200: { $ref: 'usersUpdateMeResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const getUserByIdSchema = {
  params: { $ref: 'usersGetByIdParamsSchema#' },
  response: {
    200: { $ref: 'usersGetByIdResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const deleteUserByIdSchema = {
  params: { $ref: 'usersGetByIdParamsSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const usersSchema = withOpenApiTag(
  {
    getMeSchema,
    patchMeSchema,
    getUserByIdSchema,
    deleteUserByIdSchema,
  },
  'users',
);