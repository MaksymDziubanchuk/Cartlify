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
  userVote: 'up',
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

const userIdParamsExample = {
  userId: '1',
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
    `or the phone. An avatar file is up to ${MAX_AVATAR_MB} MB.`,

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
        'Invalid current user update request: nothing to change, a name or locale over 100 ' +
        'characters, a wrong phone or a wrong avatar file.',
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
    'Returns the public profile of any user by id: name, avatar and dates. ' +
    'It has no email, role, phone or reviews; a user reads those for themselves in GET /api/users/me.',

  params: {
    $ref: 'usersGetByIdParamsSchema#',
    examples: [userIdParamsExample],
  },

  response: {
    200: {
      description: 'Public user profile was returned successfully.',
      $ref: 'usersGetByIdResponseSchema#',
      examples: [publicUserResponseExample],
    },

    400: {
      description: 'Invalid user id: a whole number from 1 to 2147483647 is expected.',
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
      description: 'User was not found.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading user profile.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for privileged user deletion
const deleteUserByIdSchema = {
  operationId: 'deleteUserById',
  summary: 'Delete user by id',
  description:
    'Deletes a user account by id. Restricted to root. The row stays, emptied: the email is replaced ' +
    'by a deleted one, the password, provider link, name, avatar, locale and phone are removed, and ' +
    'the refresh tokens of the user are removed. Orders, reviews and logs keep pointing at the account. ' +
    'An access token cannot be taken back: the user keeps access until their current access token ' +
    'expires, and the session cannot be renewed after that.',

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
      description: 'A root cannot delete their own account (ROOT_CANNOT_DELETE_SELF).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting user.',
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
  },
  'users',
);

// Add access token security to all user routes
export const usersSchema = withOpenApiSecurity(
  taggedUsersSchema,
  openApiSecurity.accessTokenCookie,
);
