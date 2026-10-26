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
  avatarIsDefault: false,
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
  avatarIsDefault: false,
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
// the mails of a reset and of a verification share their limits (src/plugins/requestLimits.ts)
const MAIL_LIMIT_TEXT =
  '`RATE_LIMITED` with `details.limit: mail`: one mail to an address in 3 minutes (a reset and a verification count together), ' +
  'or more than 10 from one address in 15 minutes; the same answer for an address with an account or without one. ' +
  '`retry-after` and `details.retryAfterSeconds` tell the wait.';

const setRegisterSchema = {
  operationId: 'registerUser',
  summary: 'Register user',
  description:
    'Creates a new user account and sets authentication cookies. ' +
    'The password is 6 to 64 characters: Latin letters, digits, spaces and ASCII symbols. ' +
    'The name is optional, up to 100 characters. While a version of the terms or of the ' +
    'contract is in force (GET /api/legal/documents/current), the person accepts every one of ' +
    'them with the registration: `acceptedDocumentIds` names them.',

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
        'PASSWORD_TOO_SHORT when fewer than 6 characters are left after dropping the edge spaces; ' +
        'LEGAL_ACCEPTANCE_REQUIRED when a version in force is not named (`details.kinds` the ' +
        'kinds missing, `details.current` the versions in force `{ id, kind, version, title }`).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`LEGAL_DOCUMENT_NOT_FOUND`: a version named is not there (`details.documentIds`).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`EMAIL_ALREADY_IN_USE`: an account with this email exists. `LEGAL_VERSION_OUTDATED`: a ' +
        'version named is no longer in force (`details.current` the versions in force ' +
        '`{ id, kind, version, title }`).',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description:
        '`RATE_LIMITED` with `details.limit: register`: more than 10 registrations from one address in an hour; `retry-after` and `details.retryAfterSeconds` tell the wait.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while registering user.',
      $ref: 'errorResponseSchema#',
    },
    502: {
      description:
        '`VERIFY_EMAIL_SEND_FAILED`: the account is created, but the mail with the link did not go; ' +
        'POST /api/auth/verify/resend sends a new one.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for user login
const setLoginSchema = {
  operationId: 'loginUser',
  summary: 'Login user',
  description:
    'Authenticates user by email and password and sets authentication cookies. A customer who ' +
    'did not accept a version of the terms or of the contract in force (one root published ' +
    'since the last consent) is not let in: the answer names the versions, the page shows a ' +
    'checkbox for each and logs in again with their ids in acceptedDocumentIds. An admin or root ' +
    'is asked nothing. The confirmation of an order checks the same for a session that stays open.',

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
      description: '`INVALID_CREDENTIALS`: the email or the password is wrong.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`LEGAL_DOCUMENT_NOT_FOUND`: a version in acceptedDocumentIds is not there (`details.documentIds`).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`LEGAL_ACCEPTANCE_REQUIRED`: the customer did not accept a version in force; ' +
        '`details.kinds` the kinds missing, `details.current` the versions in force ' +
        '`{ id, kind, version, title }` (the text of each: GET /api/legal/documents/:documentId); ' +
        'log in again with them in acceptedDocumentIds. `LEGAL_VERSION_OUTDATED`: a version sent ' +
        'is no longer in force (`details.current`). Asked only after the password is right.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        '`EMAIL_NOT_VERIFIED`: the email is not verified yet, POST /api/auth/verify/resend sends the link again. ' +
        '`AUTH_PROVIDER_MISMATCH`: the account signs in through its OAuth provider, not with a password.',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description:
        '`LOGIN_PAUSED`: 5 wrong passwords paused the login of the account, the right password too: for a minute, doubling with each next wrong password up to 15 minutes. ' +
        '`RATE_LIMITED` with `details.limit: login`: more than 30 logins from one address or 10 of one email in 10 minutes. ' +
        'Both give the wait in `retry-after` and `details.retryAfterSeconds`.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while logging in.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// the query of the start of a login by a provider: the versions of the terms and of the contract
// the person accepted on the page of the shop, which an account the login makes takes
const oauthStartQuerystring = {
  type: 'object',
  properties: {
    acceptedDocumentIds: {
      type: 'string',
      pattern: '^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,9}$',
      description:
        'Ids of the versions of the terms and of the contract in force the person accepted ' +
        '(GET /api/legal/documents/current), through commas, at most 10.',
      examples: ['17,12'],
    },
  },
} as const;

const oauthStartConsent =
  ' A login that makes a new account needs the consent to every version of the terms and of the ' +
  'contract in force, as a registration does: the page sends their ids in acceptedDocumentIds, ' +
  'and the callback makes no account without them. A login to an account of a customer needs ' +
  'the versions that came in force since its last consent, as a login with a password does; ' +
  'an admin or root is asked nothing.';

// Schema for Google OAuth start
const setGoogleStartSchema = {
  operationId: 'startGoogleOAuth',
  summary: 'Start Google OAuth',
  description: 'Redirects the user to the Google OAuth authorization page.' + oauthStartConsent,

  querystring: oauthStartQuerystring,

  response: {
    302: {
      description: 'Redirect to Google OAuth authorization page.',
      type: 'null',
    },

    401: {
      description: 'Google OAuth start request is not authorized.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: '`ALREADY_AUTHENTICATED`: the browser is signed in already; log out first.',
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
    'LEGAL_ACCEPTANCE_REQUIRED, LEGAL_VERSION_OUTDATED, LEGAL_DOCUMENT_NOT_FOUND (the start did not ' +
    'name the versions of the terms and of the contract in force the account has to accept, all of ' +
    'them for a new account: nobody is logged in and no account is made, the page shows the ' +
    'versions in force and starts the login again with them), ' +
    'GOOGLE_EMAIL_NOT_VERIFIED, GOOGLE_OAUTH_STATE_GUEST_MISMATCH (the login was started in another browser: ' +
    'the callback has to reach the browser whose guestId cookie is in the state), other GOOGLE_OAUTH_* codes ' +
    'for a broken or expired state or a failed token exchange, OAUTH_PROVIDER_UNAVAILABLE when the provider ' +
    'is out of reach or gives no answer in 5 seconds (try again), OAUTH_LOGIN_FAILED for a server failure.',

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
  description: 'Redirects the user to the GitHub OAuth authorization page.' + oauthStartConsent,

  querystring: oauthStartQuerystring,

  response: {
    302: {
      description: 'Redirect to GitHub OAuth authorization page.',
      type: 'null',
    },

    401: {
      description: 'GitHub OAuth start request is not authorized.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: '`ALREADY_AUTHENTICATED`: the browser is signed in already; log out first.',
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
    'LEGAL_ACCEPTANCE_REQUIRED, LEGAL_VERSION_OUTDATED, LEGAL_DOCUMENT_NOT_FOUND (the start did not ' +
    'name the versions of the terms and of the contract in force the account has to accept, all of ' +
    'them for a new account: nobody is logged in and no account is made, the page shows the ' +
    'versions in force and starts the login again with them), ' +
    'GITHUB_EMAIL_NOT_VERIFIED, GITHUB_OAUTH_STATE_GUEST_MISMATCH (the login was started in another browser: ' +
    'the callback has to reach the browser whose guestId cookie is in the state), other GITHUB_OAUTH_* codes ' +
    'for a broken or expired state or a failed token exchange, OAUTH_PROVIDER_UNAVAILABLE when the provider ' +
    'is out of reach or gives no answer in 5 seconds (try again), OAUTH_LOGIN_FAILED for a server failure.',

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
  description: 'Redirects the user to the LinkedIn OAuth authorization page.' + oauthStartConsent,

  querystring: oauthStartQuerystring,

  response: {
    302: {
      description: 'Redirect to LinkedIn OAuth authorization page.',
      type: 'null',
    },

    401: {
      description: 'LinkedIn OAuth start request is not authorized.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: '`ALREADY_AUTHENTICATED`: the browser is signed in already; log out first.',
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
    'LEGAL_ACCEPTANCE_REQUIRED, LEGAL_VERSION_OUTDATED, LEGAL_DOCUMENT_NOT_FOUND (the start did not ' +
    'name the versions of the terms and of the contract in force the account has to accept, all of ' +
    'them for a new account: nobody is logged in and no account is made, the page shows the ' +
    'versions in force and starts the login again with them), ' +
    'LINKEDIN_EMAIL_NOT_VERIFIED, LINKEDIN_OAUTH_STATE_GUEST_MISMATCH (the login was started in another browser: ' +
    'the callback has to reach the browser whose guestId cookie is in the state), other LINKEDIN_OAUTH_* codes ' +
    'for a broken or expired state or a failed token exchange, OAUTH_PROVIDER_UNAVAILABLE when the provider ' +
    'is out of reach or gives no answer in 5 seconds (try again), OAUTH_LOGIN_FAILED for a server failure.',

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
    429: {
      description: MAIL_LIMIT_TEXT,
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Resend verification request is not authorized.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while resending verification email.',
      $ref: 'errorResponseSchema#',
    },
    502: {
      description: '`VERIFY_EMAIL_SEND_FAILED`: the mail with the new link did not go, try again.',
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
      description:
        '`VERIFY_TOKEN_INVALID_OR_EXPIRED`: the link is wrong, used, expired or not the newest one. ' +
        '`TOKEN_REQUIRED`: the link has no token.',
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
    429: {
      description: MAIL_LIMIT_TEXT,
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while requesting password reset.',
      $ref: 'errorResponseSchema#',
    },
    502: {
      description:
        '`PASSWORD_FORGOT_EMAIL_SEND_FAILED`: the mail with the link did not go, try again.',
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
        'PASSWORD_TOO_SHORT when fewer than 6 characters are left after dropping the edge spaces; ' +
        '`RESET_TOKEN_INVALID_OR_EXPIRED`: the link is wrong, used or expired; ' +
        '`TOKEN_REQUIRED`, `NEW_PASSWORD_REQUIRED`: the token or the password is missing.',
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
      description:
        'The refresh cookie opens no session; both auth cookies are cleared, the page logs in again. ' +
        '`REFRESH_TOKEN_INVALID`: not a refresh token of this server, or its time is over. ' +
        '`REFRESH_TOKEN_EXPIRED`: the session reached its deadline. ' +
        '`REFRESH_TOKEN_REVOKED`: the session was ended on purpose (a logout, a reset or a change of the password, ' +
        'a role change, a closed session); the other sessions go on. ' +
        '`REFRESH_TOKEN_ROW_NOT_FOUND`, `REFRESH_USER_NOT_FOUND`: the session or the account is gone. ' +
        '`REFRESH_TOKEN_USER_MISMATCH`, `REFRESH_TOKEN_WRONG_TYPE`, `REFRESH_PAYLOAD_USER_ID_INVALID`, ' +
        '`REFRESH_PAYLOAD_JWT_ID_INVALID`, `REFRESH_GUEST_TOKEN_FORBIDDEN`, `REFRESH_GUEST_USER_FORBIDDEN`: ' +
        'the token does not belong to a session of an account.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        'Refresh token was already used by a renewal (REFRESH_TOKEN_REUSE_DETECTED: it was copied, every ' +
        'session of the account ends) or does not match the stored one (REFRESH_TOKEN_HASH_MISMATCH); ' +
        'both auth cookies are cleared.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while refreshing authentication tokens.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const sessionsResponseExample = {
  items: [
    {
      id: '33333333-3333-4333-8333-333333333333',
      device: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      lastUsedAt: '2026-10-23T09:00:00.000Z',
      expiresAt: '2026-11-22T09:00:00.000Z',
      current: true,
    },
  ],
};

// Schema for the sessions of the signed-in user
const getSessionsSchema = {
  operationId: 'getSessions',
  summary: 'List sessions',
  description:
    'The open sessions of the signed-in user, the newest renewal first: the browser that opened each, ' +
    'when it was renewed last, its deadline, and which one is this browser. A session keeps its id ' +
    'across its renewals.',
  security: openApiSecurity.authCookies,

  response: {
    200: {
      description: 'The open sessions.',
      $ref: 'authSessionsResponseSchema#',
      examples: [sessionsResponseExample],
    },
  },
} satisfies FastifySchema;

// Schema for ending one session
const deleteSessionSchema = {
  operationId: 'closeSession',
  summary: 'End a session',
  description:
    'Ends one session of the signed-in user: its refresh cookie gives 401 REFRESH_TOKEN_REVOKED, the other ' +
    'sessions go on. Ending the session of this browser clears its cookies, like a logout.',
  security: openApiSecurity.authCookies,

  params: { $ref: 'authSessionIdParamsSchema#' },

  response: {
    204: {
      description: 'The session ended.',
      $ref: 'authLogoutResponseSchema#',
    },
    404: {
      description: 'No open session of this user has the id (SESSION_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for changing the password
const setPasswordChangeSchema = {
  operationId: 'changePassword',
  summary: 'Change password',
  description:
    'Changes the password of a local account, the current one given. The other sessions end ' +
    '(REFRESH_TOKEN_REVOKED), the session of this browser goes on, open reset links close, and the owner ' +
    'gets a mail about the change. At most 10 requests a user in 15 minutes.',
  security: openApiSecurity.authCookies,

  body: { $ref: 'authPasswordChangeBodySchema#' },

  response: {
    204: {
      description: 'The password changed.',
      $ref: 'authLogoutResponseSchema#',
    },
    400: {
      description:
        'The new password is shorter than 6 signs without its edge spaces (PASSWORD_TOO_SHORT), or empty ' +
        '(NEW_PASSWORD_REQUIRED).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current password is wrong (PASSWORD_INVALID); nothing changes.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'The account was deleted (USER_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The account signs in through Google, GitHub or LinkedIn and has no password here (PASSWORD_NOT_SET).',
      $ref: 'errorResponseSchema#',
    },
    429: {
      description:
        'Too many changes of the password in 15 minutes (RATE_LIMITED, `details.limit` passwordChange).',
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
    getSessionsSchema,
    deleteSessionSchema,
    setPasswordChangeSchema,
    setCsrfTokenSchema,
  },
  'auth',
);
