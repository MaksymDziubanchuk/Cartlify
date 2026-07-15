import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const authRegisterResponseExample = {
  id: 1,
  email: 'user@example.com',
  role: 'USER',
  isVerified: false,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  name: 'Example User',
  avatarUrls: {
    url32: 'https://example.com/avatars/user-32.webp',
    url64: 'https://example.com/avatars/user-64.webp',
    url128: 'https://example.com/avatars/user-128.webp',
    url256: 'https://example.com/avatars/user-256.webp',
  },
  locale: 'en',
};

const authLoginResponseExample = {
  id: 1,
  email: 'user@example.com',
  role: 'USER',
  isVerified: true,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  name: 'Example User',
  avatarUrls: {
    url32: 'https://example.com/avatars/user-32.webp',
    url64: 'https://example.com/avatars/user-64.webp',
    url128: 'https://example.com/avatars/user-128.webp',
    url256: 'https://example.com/avatars/user-256.webp',
  },
  locale: 'en',
  phone: '+10000000000',
};

const registerBodyExample = {
  email: 'user@example.com',
  password: 'password123',
  name: 'Example User',
};

const loginBodyExample = {
  email: 'user@example.com',
  password: 'password123',
  rememberMe: true,
};

const oauthCallbackQueryExample = {
  code: 'oauth_authorization_code',
  state: 'oauth_state_value',
};

const resendVerifyBodyExample = {
  email: 'user@example.com',
};

const verifyEmailQueryExample = {
  token: 'verification-token-example',
};

const passwordForgotBodyExample = {
  email: 'user@example.com',
};

const passwordResetQueryExample = {
  token: 'password-reset-token-example',
};

const passwordResetBodyExample = {
  newPassword: 'newPassword123',
};

const logoutBodyExample = {
  allDevices: false,
};

const messageResponseExample = {
  message: 'Operation completed successfully.',
};

const refreshResponseExample = {
  accessToken: 'jwt-access-token-example',
};

// Schema for user registration
const setRegisterSchema = {
  operationId: 'registerUser',
  summary: 'Register user',
  description: 'Creates a new user account and sets authentication cookies.',

  body: {
    $ref: 'authRegisterBodySchema#',
    examples: [registerBodyExample],
  },

  response: {
    201: {
      description: 'User was registered successfully.',
      $ref: 'authRegisterResponseSchema#',
      examples: [authRegisterResponseExample],
    },

    400: {
      description: 'Invalid registration request.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'User with this email already exists.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Registration payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while registering user.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for user login
const setLoginSchema = {
  operationId: 'loginUser',
  summary: 'Login user',
  description: 'Authenticates user by email and password and sets authentication cookies.',

  body: {
    $ref: 'authLoginBodySchema#',
    examples: [loginBodyExample],
  },

  response: {
    200: {
      description: 'User was authenticated successfully.',
      $ref: 'authLoginResponseSchema#',
      examples: [authLoginResponseExample],
    },

    400: {
      description: 'Invalid login request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Login credentials are invalid or the account cannot be authenticated.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Login payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while logging in.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for Google OAuth start
const setGoogleStartSchema = {
  operationId: 'startGoogleOAuth',
  summary: 'Start Google OAuth',
  description: 'Redirects the user to the Google OAuth authorization page.',

  response: {
    302: {
      description: 'Redirect to Google OAuth authorization page.',
      type: 'null',
    },

    400: {
      description: 'Invalid Google OAuth start request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Google OAuth start request is not authorized.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Google OAuth start request failed validation.',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description: 'Too many Google OAuth start requests.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while starting Google OAuth.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for Google OAuth callback
const setGoogleCallbackSchema = {
  operationId: 'handleGoogleOAuthCallback',
  summary: 'Handle Google OAuth callback',
  description: 'Handles Google OAuth callback, creates or finds user and sets authentication cookies.',

  querystring: {
    $ref: 'authGoogleCallbackQuerySchema#',
    examples: [oauthCallbackQueryExample],
  },

  response: {
    200: {
      description: 'Google OAuth callback was handled successfully.',
      $ref: 'authLoginResponseSchema#',
      examples: [authLoginResponseExample],
    },

    400: {
      description: 'Invalid Google OAuth callback request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Google OAuth callback could not authenticate the user.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Google OAuth account is not allowed to authenticate.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Google OAuth callback query failed validation.',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description: 'Too many Google OAuth callback requests.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while handling Google OAuth callback.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for GitHub OAuth start
const setGithubStartSchema = {
  operationId: 'startGithubOAuth',
  summary: 'Start GitHub OAuth',
  description: 'Redirects the user to the GitHub OAuth authorization page.',

  response: {
    302: {
      description: 'Redirect to GitHub OAuth authorization page.',
      type: 'null',
    },

    400: {
      description: 'Invalid GitHub OAuth start request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'GitHub OAuth start request is not authorized.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'GitHub OAuth start request failed validation.',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description: 'Too many GitHub OAuth start requests.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while starting GitHub OAuth.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for GitHub OAuth callback
const setGithubCallbackSchema = {
  operationId: 'handleGithubOAuthCallback',
  summary: 'Handle GitHub OAuth callback',
  description: 'Handles GitHub OAuth callback, creates or finds user and sets authentication cookies.',

  querystring: {
    $ref: 'authGithubCallbackQuerySchema#',
    examples: [oauthCallbackQueryExample],
  },

  response: {
    200: {
      description: 'GitHub OAuth callback was handled successfully.',
      $ref: 'authLoginResponseSchema#',
      examples: [authLoginResponseExample],
    },

    400: {
      description: 'Invalid GitHub OAuth callback request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'GitHub OAuth callback could not authenticate the user.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'GitHub OAuth account is not allowed to authenticate.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'GitHub OAuth callback query failed validation.',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description: 'Too many GitHub OAuth callback requests.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while handling GitHub OAuth callback.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for LinkedIn OAuth start
const setLinkedInStartSchema = {
  operationId: 'startLinkedInOAuth',
  summary: 'Start LinkedIn OAuth',
  description: 'Redirects the user to the LinkedIn OAuth authorization page.',

  response: {
    302: {
      description: 'Redirect to LinkedIn OAuth authorization page.',
      type: 'null',
    },

    400: {
      description: 'Invalid LinkedIn OAuth start request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'LinkedIn OAuth start request is not authorized.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'LinkedIn OAuth start request failed validation.',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description: 'Too many LinkedIn OAuth start requests.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while starting LinkedIn OAuth.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for LinkedIn OAuth callback
const setLinkedInCallbackSchema = {
  operationId: 'handleLinkedInOAuthCallback',
  summary: 'Handle LinkedIn OAuth callback',
  description: 'Handles LinkedIn OAuth callback, creates or finds user and sets authentication cookies.',

  querystring: {
    $ref: 'authLinkedInCallbackQuerySchema#',
    examples: [oauthCallbackQueryExample],
  },

  response: {
    200: {
      description: 'LinkedIn OAuth callback was handled successfully.',
      $ref: 'authLoginResponseSchema#',
      examples: [authLoginResponseExample],
    },

    400: {
      description: 'Invalid LinkedIn OAuth callback request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'LinkedIn OAuth callback could not authenticate the user.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'LinkedIn OAuth account is not allowed to authenticate.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'LinkedIn OAuth callback query failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while handling LinkedIn OAuth callback.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for resending verification email
const setVerifyResendSchema = {
  operationId: 'resendVerificationEmail',
  summary: 'Resend verification email',
  description: 'Sends a new email verification message to the provided email address.',

  body: {
    $ref: 'authResendVerifyBodySchema#',
    examples: [resendVerifyBodyExample],
  },

  response: {
    200: {
      description: 'Verification email was sent successfully.',
      $ref: 'messageResponseSchema#',
      examples: [messageResponseExample],
    },

    400: {
      description: 'Invalid resend verification request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Resend verification request is not authorized.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Email is already verified or verification cannot be resent.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Resend verification payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while resending verification email.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for email verification
const authVerifyEmailSchema = {
  operationId: 'verifyUserEmail',
  summary: 'Verify email',
  description: 'Verifies user email by verification token.',

  querystring: {
    $ref: 'authVerifyEmailQuerySchema#',
    examples: [verifyEmailQueryExample],
  },

  response: {
    200: {
      description: 'Email was verified successfully.',
      $ref: 'messageResponseSchema#',
      examples: [messageResponseExample],
    },

    400: {
      description: 'Invalid email verification token.',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description: 'Too many email verification attempts.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while verifying email.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for password reset request
const setPasswordForgotSchema = {
  operationId: 'requestPasswordReset',
  summary: 'Request password reset',
  description: 'Creates a password reset request for the provided email address.',

  body: {
    $ref: 'authPasswordForgotBodySchema#',
    examples: [passwordForgotBodyExample],
  },

  response: {
    200: {
      description: 'Password reset request was accepted.',
      $ref: 'messageResponseSchema#',
      examples: [messageResponseExample],
    },

    400: {
      description: 'Invalid password reset request.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Password reset request payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while requesting password reset.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for password reset completion
const setPasswordResetSchema = {
  operationId: 'resetPassword',
  summary: 'Reset password',
  description: 'Resets user password by password reset token.',

  querystring: {
    $ref: 'authPasswordResetQuerySchema#',
    examples: [passwordResetQueryExample],
  },

  body: {
    $ref: 'authPasswordResetBodySchema#',
    examples: [passwordResetBodyExample],
  },

  response: {
    200: {
      description: 'Password was reset successfully.',
      $ref: 'messageResponseSchema#',
      examples: [messageResponseExample],
    },

    400: {
      description: 'Invalid password reset request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Password reset token is invalid or expired.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Password reset payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while resetting password.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for user logout
const setLogoutSchema = {
  operationId: 'logoutUser',
  summary: 'Logout user',
  description: 'Revokes refresh token, clears authentication cookies and logs user out.',
  security: openApiSecurity.authCookies,

  body: {
    $ref: 'authLogoutBodySchema#',
    examples: [logoutBodyExample],
  },

  response: {
    204: {
      description: 'User was logged out successfully.',
      $ref: 'authLogoutResponseSchema#',
    },

    400: {
      description: 'Invalid logout request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to log out.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while logging out.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for access token refresh
const setRefreshSchema = {
  operationId: 'refreshAuthTokens',
  summary: 'Refresh access token',
  description: 'Rotates refresh token and returns a new access token.',
  security: openApiSecurity.refreshTokenCookie,

  response: {
    200: {
      description: 'Authentication tokens were refreshed successfully.',
      $ref: 'authRefreshResponseSchema#',
      examples: [refreshResponseExample],
    },

    400: {
      description: 'Invalid refresh token request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Refresh token is missing, invalid or expired.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while refreshing authentication tokens.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group auth routes under the auth Swagger tag
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