import type { FastifySchema } from 'fastify';

export const setRegisterSchema = {
  body: { $ref: 'authRegisterBodySchema#' },
  response: {
    201: { $ref: 'authRegisterResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    409: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const setLoginSchema = {
  body: { $ref: 'authLoginBodySchema#' },
  response: {
    200: { $ref: 'authLoginResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const setGoogleStartSchema = {
  response: {
    302: { type: 'null' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const setGoogleCallbackSchema = {
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

export const setVerifyResendSchema = {
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

export const authVerifyEmailSchema = {
  querystring: { $ref: 'authVerifyEmailQuerySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} as const;

export const setPasswordForgotSchema = {
  body: { $ref: 'authPasswordForgotBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const setPasswordResetSchema = {
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

export const setLogoutSchema = {
  response: {
    204: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const setRefreshSchema = {
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
  setRegisterSchema,
  setVerifyResendSchema,
  authVerifyEmailSchema,
  setPasswordForgotSchema,
  setPasswordResetSchema,
  setLogoutSchema,
  setRefreshSchema,
};
