import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const setRegisterSchema = {
  summary: 'Register user',
  description: 'Creates a new user account and sets authentication cookies.',
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
  summary: 'Login user',
  description: 'Authenticates user by email and password and sets authentication cookies.',
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
  summary: 'Start Google OAuth',
  description: 'Redirects the user to the Google OAuth authorization page.',
  response: {
    302: {
      description: 'Redirect to Google OAuth authorization page',
      type: 'null',
    },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setGoogleCallbackSchema = {
  summary: 'Handle Google OAuth callback',
  description: 'Handles Google OAuth callback, creates or finds user and sets authentication cookies.',
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
  summary: 'Start GitHub OAuth',
  description: 'Redirects the user to the GitHub OAuth authorization page.',
  response: {
    302: {
      description: 'Redirect to GitHub OAuth authorization page',
      type: 'null',
    },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setGithubCallbackSchema = {
  summary: 'Handle GitHub OAuth callback',
  description: 'Handles GitHub OAuth callback, creates or finds user and sets authentication cookies.',
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

const setLinkedInStartSchema = {
  summary: 'Start LinkedIn OAuth',
  description: 'Redirects the user to the LinkedIn OAuth authorization page.',
  response: {
    302: {
      description: 'Redirect to LinkedIn OAuth authorization page',
      type: 'null',
    },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setLinkedInCallbackSchema = {
  summary: 'Handle LinkedIn OAuth callback',
  description: 'Handles LinkedIn OAuth callback, creates or finds user and sets authentication cookies.',
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
  summary: 'Resend verification email',
  description: 'Sends a new email verification message to the provided email address.',
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
  summary: 'Verify email',
  description: 'Verifies user email by verification token.',
  querystring: { $ref: 'authVerifyEmailQuerySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    429: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setPasswordForgotSchema = {
  summary: 'Request password reset',
  description: 'Creates a password reset request for the provided email address.',
  body: { $ref: 'authPasswordForgotBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    422: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setPasswordResetSchema = {
  summary: 'Reset password',
  description: 'Resets user password by password reset token.',
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
  summary: 'Logout user',
  description: 'Revokes refresh token, clears authentication cookies and logs user out.',
  security: openApiSecurity.authCookies,
  body: { $ref: 'authLogoutBodySchema#' },
  response: {
    204: { $ref: 'authLogoutResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

const setRefreshSchema = {
  summary: 'Refresh access token',
  description: 'Rotates refresh token and returns a new access token.',
  security: openApiSecurity.refreshTokenCookie,
  response: {
    200: { $ref: 'authRefreshResponseSchema#' },

    400: { $ref: 'errorResponseSchema#' },
    401: { $ref: 'errorResponseSchema#' },
    500: { $ref: 'errorResponseSchema#' },
  },
} satisfies FastifySchema;

export const authSchema = withOpenApiTag(
  {
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
  },
  'auth',
);