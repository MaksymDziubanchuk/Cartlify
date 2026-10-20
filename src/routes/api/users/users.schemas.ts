import type { FastifySchema } from 'fastify';

import { MAX_UPLOAD_SIZE_BYTES } from '@config/limits.js';
import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

// the biggest avatar file in megabytes, for the texts of the docs
const MAX_AVATAR_MB = MAX_UPLOAD_SIZE_BYTES / 1_000_000;

const userReviewExample = {
  id: 1,
  productId: 10,
  rating: 5,
  userId: 1,
  createdAt: '2026-01-01T10:00:00.000Z',
  comment: 'Great product.',
  upVotes: 3,
  downVotes: 0,
  // the author does not vote for an own review
  userVote: null,
  updatedAt: '2026-01-01T10:00:00.000Z',
};

const userResponseExample = {
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
  reviews: [userReviewExample],
};

const publicUserResponseExample = {
  id: 1,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  name: 'Example User',
  avatarUrls: {
    url32: 'https://example.com/avatars/user-32.webp',
    url64: 'https://example.com/avatars/user-64.webp',
    url128: 'https://example.com/avatars/user-128.webp',
    url256: 'https://example.com/avatars/user-256.webp',
  },
};

const updateMeBodyExample = {
  name: 'Updated User',
  locale: 'en',
  phone: '+10000000000',
};

// what an admin or root reads: the whole profile, the open chat with an admin, the checked lists
const adminUserResponseExample = {
  ...publicUserResponseExample,
  email: 'user@example.com',
  role: 'USER',
  authProvider: 'LOCAL',
  isVerified: true,
  locale: 'en',
  phone: '+10000000000',
  openChatThreadId: '6f1c2a3e-8a0b-4c5d-9e7f-1a2b3c4d5e6f',
  period: { from: '2025-12-02T10:00:00.000Z', to: '2026-01-01T10:00:00.000Z' },
  orders: [
    {
      id: 12,
      status: 'paid',
      total: 25.5,
      createdAt: '2025-12-20T10:00:00.000Z',
      updatedAt: '2025-12-20T10:05:00.000Z',
    },
  ],
  loginLogs: [
    {
      id: 40,
      createdAt: '2025-12-31T09:00:00.000Z',
      ipAddress: '192.0.2.10',
      userAgent: 'Mozilla/5.0',
    },
  ],
};

const userIdParamsExample = {
  userId: '1',
};

const adminUserQueryExample = {
  include: 'orders,loginLogs',
  from: '2025-12-02T10:00:00.000Z',
  to: '2026-01-01T10:00:00.000Z',
};

const deleteUserResponseExample = {
  message: 'user deleted',
};

// Schema for current authenticated user lookup
const getMeSchema = {
  operationId: 'getCurrentUser',
  summary: 'Get current user',
  description: 'Returns the currently authenticated user profile.',

  response: {
    200: {
      description: 'Current user profile was returned successfully.',
      $ref: 'usersUserResponseSchema#',
      examples: [userResponseExample],
    },

    401: {
      description:
        'The access cookie is invalid or expired and cannot be renewed (LOGIN_REQUIRED).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'A guest has no profile: only a signed-in user reads it (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading current user.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for current authenticated user update
const patchMeSchema = {
  operationId: 'updateCurrentUser',
  summary: 'Update current user',
  description:
    'Updates the currently authenticated user profile. Takes a JSON body, or a multipart form ' +
    'when the request carries an avatar file. The name and the locale are up to 100 characters; ' +
    'the phone is an international number such as +380501234567, with no spaces, brackets or ' +
    'dashes, in a JSON body and in a form alike; an empty value removes the name, the locale ' +
    `or the phone. An avatar file is up to ${MAX_AVATAR_MB} MB, a jpeg, png or webp image by ` +
    'its content; it replaces the avatar only when the profile is written, a refused request ' +
    'changes nothing, the avatar included.',

  body: {
    $ref: 'usersUpdateMeBodySchema#',
    examples: [updateMeBodyExample],
  },

  response: {
    200: {
      description: 'Current user profile was updated successfully.',
      $ref: 'usersUpdateMeResponseSchema#',
      examples: [
        {
          ...userResponseExample,
          name: 'Updated User',
          updatedAt: '2026-01-02T10:00:00.000Z',
        },
      ],
    },

    400: {
      description:
        'Invalid current user update request: nothing to change (NO_FIELDS_TO_UPDATE), a name or ' +
        'locale over 100 characters (VALIDATION_ERROR, NAME_TOO_LONG, LOCALE_TOO_LONG), a wrong ' +
        'phone (PHONE_INVALID), two avatar files (AVATAR_MULTIPLE), an empty avatar ' +
        '(AVATAR_STREAM_ERROR), a file that is not a jpeg, png or webp image by its content, ' +
        'whatever type the form names (IMAGE_TYPE_NOT_ALLOWED), or an image Cloudinary cannot ' +
        'read (IMAGE_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description:
        'The access cookie is invalid or expired and cannot be renewed (LOGIN_REQUIRED).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'A guest has no profile to update (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'The account is deleted (USER_NOT_FOUND): its access token works for a few minutes after the deletion, the profile can no longer change.',
      $ref: 'errorResponseSchema#',
    },
    413: {
      description:
        `The avatar file is over ${MAX_AVATAR_MB} MB (PAYLOAD_TOO_LARGE). Nothing was changed: ` +
        'the page tells the user to pick a smaller image and sends the form again.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating current user.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for public user lookup by id
const getUserByIdSchema = {
  operationId: 'getUserById',
  summary: 'Get user by id',
  description:
    'Returns the profile of any user by id. A user gets the public profile: name, avatar and dates, ' +
    'no email, role, phone or reviews (a user reads those for themselves in GET /api/users/me); ' +
    '`include`, `from` and `to` are ignored for a user. ' +
    'An admin or root gets the whole profile but the password, the provider id and the id of the ' +
    'avatar file, the open chat of the user with an admin (`openChatThreadId`), the period of the ' +
    'lists and the lists `include` names, of that period, newest first. ' +
    'The period is the last 30 days unless `from` or `to` comes, and at most 60 days long. ' +
    'A deleted account is USER_NOT_FOUND for a user; an admin or root reads it with `deletedAt`.',

  params: {
    $ref: 'usersGetByIdParamsSchema#',
    examples: [userIdParamsExample],
  },

  querystring: {
    $ref: 'usersGetByIdQuerySchema#',
    examples: [adminUserQueryExample],
  },

  response: {
    200: {
      description:
        'The profile was returned: the public one for a user, the whole one for an admin.',
      $ref: 'usersGetByIdResponseSchema#',
      examples: [publicUserResponseExample, adminUserResponseExample],
    },

    400: {
      description:
        'Invalid request: the user id is not a whole number from 1 to 2147483647, `include` names ' +
        'an unknown list or a date is not a date (VALIDATION_ERROR); for an admin or root the ' +
        'period ends before it starts (PROFILE_PERIOD_INVALID) or is longer than 60 days ' +
        '(PROFILE_PERIOD_TOO_LONG, `details.maxDays`).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description:
        'The access cookie is invalid or expired and cannot be renewed (LOGIN_REQUIRED).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        'A guest cannot read profiles: only a signed-in user, admin or root can (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        'User was not found (USER_NOT_FOUND), also a deleted account when the reader is not an admin or root.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading user profile.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// what a deletion does, the same for a root and for the user
const ACCOUNT_DELETION =
  'The row stays, emptied and marked with `deletedAt`: the email becomes ' +
  'deleted+<id>+...@<domain of the site>, the name becomes Guest, the password, provider link, ' +
  'avatar (also the file), locale and phone are removed, the role stays. The account can no ' +
  'longer change its own row, and other users get USER_NOT_FOUND for its profile. ' +
  'An order waiting for payment is cancelled, its stock goes back and its payment page is closed; ' +
  'a payment that still comes for it is refunded in full. The cart goes. Paid and shipped orders, ' +
  'favorites, reviews, login logs and chat messages stay; open chats are closed. Every refresh ' +
  'token is removed: an access token cannot be taken back, it works until it expires and the ' +
  'session cannot be renewed after that. The person gets a mail at the old address with the ' +
  'orders still on their way and what happened to the cancelled ones; a mail that fails is only ' +
  'logged. ACCOUNT_ORDERS_CHANGED (409): a payment or the end of a reservation changed a waiting ' +
  'order at that moment, nothing was changed, repeat the request.';

// Schema for privileged user deletion
const deleteUserByIdSchema = {
  operationId: 'deleteUserById',
  summary: 'Delete user by id',
  description: `Deletes a user account by id. Restricted to root, no confirmation asked. ${ACCOUNT_DELETION}`,

  params: {
    $ref: 'usersGetByIdParamsSchema#',
    examples: [userIdParamsExample],
  },

  response: {
    200: {
      description: 'User was deleted successfully.',
      $ref: 'messageResponseSchema#',
      examples: [deleteUserResponseExample],
    },

    400: {
      description:
        'Invalid user deletion request: the id must be a whole number from 1 to 2147483647.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description:
        'The access cookie is invalid or expired and cannot be renewed (LOGIN_REQUIRED).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only root can delete users (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'User was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'A root cannot delete their own account (ROOT_CANNOT_DELETE_SELF), or a waiting order ' +
        'changed at that moment (ACCOUNT_ORDERS_CHANGED, repeat the request).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description:
        'INTERNAL_ERROR: an unexpected server error while deleting user, for example a server ' +
        'without SITE_DOMAIN to build the new address on (the reason is in the server log only).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for a user deleting their own account
const deleteMeSchema = {
  operationId: 'deleteCurrentUser',
  summary: 'Delete current user',
  description:
    'Deletes the account of the signed-in user, only a user (an admin is demoted by root first). ' +
    'A local account sends its password. An account of Google, GitHub or LinkedIn has none: ' +
    'its last login must be at most 10 minutes old, otherwise RECENT_LOGIN_REQUIRED (403) asks ' +
    'the page to log out, send the person through the provider again and repeat the request. ' +
    'With an order waiting for payment, paid or shipped the first request answers ' +
    'ACCOUNT_HAS_OPEN_ORDERS (409) with details.orders [{ orderId, status, total }] and changes ' +
    'nothing; the page shows them and repeats with confirmOpenOrders: true. Send the body {} or ' +
    'no body at all without a Content-Type header: a Content-Type: application/json with an empty ' +
    'body is refused with 400 BAD_REQUEST before the route runs. On success the ' +
    `answer clears the auth cookies of this browser. ${ACCOUNT_DELETION}`,

  body: {
    $ref: 'usersDeleteMeBodySchema#',
    examples: [{ password: 'secret123', confirmOpenOrders: true }],
  },

  response: {
    204: {
      description: 'The account is deleted, the auth cookies are cleared.',
      $ref: 'usersDeleteMeResponseSchema#',
    },

    400: {
      description:
        'The body does not match the schema (VALIDATION_ERROR), a local account sent no ' +
        'password (PASSWORD_REQUIRED), or a Content-Type: application/json came with an empty ' +
        'body (BAD_REQUEST).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description:
        'The access cookie is invalid or expired and cannot be renewed (LOGIN_REQUIRED).',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description:
        'Only a user deletes their own account (INSUFFICIENT_ROLE), the password is wrong ' +
        '(PASSWORD_INVALID), or the last login of an oauth account is older than 10 minutes ' +
        '(RECENT_LOGIN_REQUIRED).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The account has orders waiting for payment, paid or shipped (ACCOUNT_HAS_OPEN_ORDERS, ' +
        'details.orders lists them; repeat with confirmOpenOrders: true), or a waiting order ' +
        'changed at that moment (ACCOUNT_ORDERS_CHANGED, repeat the request).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description:
        'INTERNAL_ERROR: an unexpected server error while deleting the account, for example a ' +
        'server without SITE_DOMAIN to build the new address on (the reason is in the server log only).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group user routes under the users Swagger tag
const taggedUsersSchema = withOpenApiTag(
  {
    getMeSchema,
    patchMeSchema,
    getUserByIdSchema,
    deleteUserByIdSchema,
    deleteMeSchema,
  },
  'users',
);

// Add access token security to all user routes
export const usersSchema = withOpenApiSecurity(
  taggedUsersSchema,
  openApiSecurity.accessTokenCookie,
);
