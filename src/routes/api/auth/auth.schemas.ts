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

// Schema for user registration
const setRegisterSchema = {
  operationId: 'registerUser',
  summary: 'Register user',
  description:
    'Creates a new user account and sets authentication cookies. ' +
    'The password is 6 to 64 characters: Latin letters, digits, spaces and ASCII symbols. ' +
    'The name is optional, up to 100 characters.',

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
      description:
        'Invalid registration request. VALIDATION_ERROR with field password ' +
        'when the password is shorter than 6 or longer than 64 characters or has non-ASCII characters; ' +
        'PASSWORD_TOO_SHORT when fewer than 6 characters are left after dropping the edge spaces.',
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
  description:
    'Handles the Google OAuth callback and sends the browser back to the frontend page ' +
    'WEB_ORIGIN/auth/callback. On success it creates or finds the user and sets the authentication cookies. ' +
    'On failure the redirect carries ?error=<errorCode>: OAUTH_ACCESS_DENIED (the user declined), ' +
    'OAUTH_CALLBACK_ERROR (Google reported another error), ALREADY_AUTHENTICATED, ' +
    'GOOGLE_EMAIL_NOT_VERIFIED, GOOGLE_OAUTH_STATE_GUEST_MISMATCH (the login was started in another browser: ' +
    'the callback has to reach the browser whose guestId cookie is in the state), other GOOGLE_OAUTH_* codes ' +
    'for a broken or expired state or a failed token exchange, OAUTH_LOGIN_FAILED for a server failure.',

  querystring: {
    $ref: 'authGoogleCallbackQuerySchema#',
    examples: [oauthCallbackQueryExample],
  },

  response: {
    302: {
      description:
        'Redirect to the frontend page WEB_ORIGIN/auth/callback, with ?error=<errorCode> on failure.',
      type: 'null',
    },

    400: {
      description:
        'The callback query is neither a code with a state nor a provider error (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description: 'Too many Google OAuth callback requests.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description:
        'The server has no frontend address to send the browser to (WEB_ORIGIN is not set).',
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
  description:
    'Handles the GitHub OAuth callback and sends the browser back to the frontend page ' +
    'WEB_ORIGIN/auth/callback. On success it creates or finds the user and sets the authentication cookies. ' +
    'On failure the redirect carries ?error=<errorCode>: OAUTH_ACCESS_DENIED (the user declined), ' +
    'OAUTH_CALLBACK_ERROR (GitHub reported another error), ALREADY_AUTHENTICATED, ' +
    'GITHUB_EMAIL_NOT_VERIFIED, GITHUB_OAUTH_STATE_GUEST_MISMATCH (the login was started in another browser: ' +
    'the callback has to reach the browser whose guestId cookie is in the state), other GITHUB_OAUTH_* codes ' +
    'for a broken or expired state or a failed token exchange, OAUTH_LOGIN_FAILED for a server failure.',

  querystring: {
    $ref: 'authGithubCallbackQuerySchema#',
    examples: [oauthCallbackQueryExample],
  },

  response: {
    302: {
      description:
        'Redirect to the frontend page WEB_ORIGIN/auth/callback, with ?error=<errorCode> on failure.',
      type: 'null',
    },

    400: {
      description:
        'The callback query is neither a code with a state nor a provider error (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description: 'Too many GitHub OAuth callback requests.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description:
        'The server has no frontend address to send the browser to (WEB_ORIGIN is not set).',
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
  description:
    'Handles the LinkedIn OAuth callback and sends the browser back to the frontend page ' +
    'WEB_ORIGIN/auth/callback. On success it creates or finds the user and sets the authentication cookies. ' +
    'On failure the redirect carries ?error=<errorCode>: OAUTH_ACCESS_DENIED (the user declined), ' +
    'OAUTH_CALLBACK_ERROR (LinkedIn reported another error), ALREADY_AUTHENTICATED, ' +
    'LINKEDIN_EMAIL_NOT_VERIFIED, LINKEDIN_OAUTH_STATE_GUEST_MISMATCH (the login was started in another browser: ' +
    'the callback has to reach the browser whose guestId cookie is in the state), other LINKEDIN_OAUTH_* codes ' +
    'for a broken or expired state or a failed token exchange, OAUTH_LOGIN_FAILED for a server failure.',

  querystring: {
    $ref: 'authLinkedInCallbackQuerySchema#',
    examples: [oauthCallbackQueryExample],
  },

  response: {
    302: {
      description:
        'Redirect to the frontend page WEB_ORIGIN/auth/callback, with ?error=<errorCode> on failure.',
      type: 'null',
    },

    400: {
      description:
        'The callback query is neither a code with a state nor a provider error (VALIDATION_ERROR).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description:
        'The server has no frontend address to send the browser to (WEB_ORIGIN is not set).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for resending verification email
const setVerifyResendSchema = {
  operationId: 'resendVerificationEmail',
  summary: 'Resend verification email',
  description:
    'Sends a new email verification link to the provided email address; earlier links stop working. ' +
    'The answer is the same for an unknown or already verified email, so it does not tell which emails have accounts.',

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
  description:
    'Verifies user email by the token of the link from the mail. A link works once and only the newest one does.',

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
  description:
    'Creates a password reset request for the provided email address and mails the link. ' +
    'The sessions of the account stay: they end only when the password is actually reset.',

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
  description:
    'Resets user password by password reset token and ends every session of the account. ' +
    'The new password is 6 to 64 characters: Latin letters, digits, spaces and ASCII symbols.',

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
      description:
        'Invalid password reset request. VALIDATION_ERROR with field newPassword ' +
        'when the password is shorter than 6 or longer than 64 characters or has non-ASCII characters; ' +
        'PASSWORD_TOO_SHORT when fewer than 6 characters are left after dropping the edge spaces.',
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
  description:
    'Ends the session of this browser and clears the authentication cookies. ' +
    'With allDevices every session of the signed-in user ends. ' +
    'Works with an expired access cookie too: the refresh cookie identifies the session.',
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
  description:
    'Rotates the refresh token and sets new accessToken and refreshToken cookies. ' +
    'Both tokens travel in httpOnly cookies only, the response has no body. ' +
    'Works with an expired access cookie: the refresh cookie alone is the credential.',
  security: openApiSecurity.refreshTokenCookie,

  response: {
    204: {
      description: 'Tokens were rotated, new accessToken and refreshToken cookies are set.',
      $ref: 'authRefreshResponseSchema#',
    },

    400: {
      description: 'There is no refresh token cookie (REFRESH_TOKEN_REQUIRED).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Refresh token is invalid or expired; both auth cookies are cleared.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        'Refresh token was already used (REFRESH_TOKEN_REUSE_DETECTED) or does not match ' +
        'the stored one (REFRESH_TOKEN_HASH_MISMATCH); both auth cookies are cleared.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while refreshing authentication tokens.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const csrfTokenResponseExample = {
  csrfToken: 'csrf-token-example',
};

// Schema for the csrf token
const setCsrfTokenSchema = {
  operationId: 'getCsrfToken',
  summary: 'Get CSRF token',
  description:
    'Gives the page a CSRF token and keeps its secret in an httpOnly cookie (csrf, __Host-csrf in production). ' +
    'Every POST, PUT, PATCH and DELETE has to send the token in the x-csrf-token header, ' +
    'otherwise it is refused with 403 CSRF_TOKEN_INVALID. The token stays valid as long as the cookie: ' +
    'take it once when the page loads and again after a CSRF_TOKEN_INVALID answer. ' +
    'Swagger UI takes it by itself before such a request.',

  response: {
    200: {
      description: 'CSRF token for the x-csrf-token header; the secret cookie is set when missing.',
      $ref: 'authCsrfTokenResponseSchema#',
      examples: [csrfTokenResponseExample],
    },

    429: {
      description: 'Too many requests.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while issuing the CSRF token.',
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
    setCsrfTokenSchema,
  },
  'auth',
);
