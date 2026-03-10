import type { FastifySchema } from 'fastify';

const setRegisterSchema = {
  body: { $ref: 'authRegisterBodySchema#' },
  response: {
    201: { $ref: 'authRegisterResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setLoginSchema = {
  body: { $ref: 'authLoginBodySchema#' },
  response: {
    200: { $ref: 'authLoginResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setGoogleStartSchema = {
  response: {
    302: { type: 'null' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setGoogleCallbackSchema = {
  querystring: { $ref: 'authGoogleCallbackQuerySchema#' },
  response: {
    200: { $ref: 'authLoginResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setGithubStartSchema = {
  response: {
    302: { type: 'null' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setGithubCallbackSchema = {
  querystring: { $ref: 'authGithubCallbackQuerySchema#' },
  response: {
    200: { $ref: 'authLoginResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setLinkedInStartSchema: FastifySchema = {
  response: {
    302: { type: 'null' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setLinkedInCallbackSchema: FastifySchema = {
  querystring: { $ref: 'authLinkedInCallbackQuerySchema#' },
  response: {
    200: { $ref: 'authLoginResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    403: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setVerifyResendSchema = {
  body: { $ref: 'authResendVerifyBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const authVerifyEmailSchema = {
  querystring: { $ref: 'authVerifyEmailQuerySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} as const;

const setPasswordForgotSchema = {
  body: { $ref: 'authPasswordForgotBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setPasswordResetSchema = {
  querystring: { $ref: 'authPasswordResetQuerySchema#' },
  body: { $ref: 'authPasswordResetBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setLogoutSchema = {
  body: { $ref: 'authLogoutBodySchema#' },
  response: {
    204: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setRefreshSchema = {
  response: {
    200: { $ref: 'authRefreshResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const authSchema = {
  setLoginSchema,
  setGoogleStartSchema,
  setGoogleCallbackSchema,
  setGithubStartSchema,
  setGithubCallbackSchema,
  setLinkedInStartSchema,
  setLinkedInCallbackSchema,
  setRegisterSchema,
  setVerifyResendSchema,
  authVerifyEmailSchema,
  setPasswordForgotSchema,
  setPasswordResetSchema,
  setLogoutSchema,
  setRefreshSchema,
};
