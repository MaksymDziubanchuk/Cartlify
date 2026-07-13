import type { FastifySchema } from 'fastify';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';
import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';

const getCurrentChatSchema = {
  response: {
    200: { $ref: 'currentChatResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const getAdminChatThreadsSchema = {
  querystring: { $ref: 'adminChatThreadsQuerySchema#' },
  response: {
    200: { $ref: 'adminChatThreadsResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const getAdminChatThreadSchema = {
  params: { $ref: 'chatThreadIdParamsSchema#' },
  response: {
    200: { $ref: 'adminChatThreadResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const closeAdminChatThreadSchema = {
  params: { $ref: 'chatThreadIdParamsSchema#' },
  response: {
    200: { $ref: 'closeChatThreadResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    404: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const chatsSchemas = withOpenApiSecurityFor(
  withOpenApiTag(
    {
      getCurrentChatSchema,
      getAdminChatThreadsSchema,
      getAdminChatThreadSchema,
      closeAdminChatThreadSchema,
    },
    'chat',
  ),
  openApiSecurity.accessTokenCookie,
  ['getAdminChatThreadsSchema', 'getAdminChatThreadSchema', 'closeAdminChatThreadSchema'],
);