import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

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
  email: 'user@example.com',
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

const updateMeBodyExample = {
  name: 'Updated User',
  locale: 'en',
  phone: '+10000000000',
};

const userIdParamsExample = {
  userId: '1',
};

const deleteUserResponseExample = {
  message: 'User deleted successfully.',
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

    400: {
      description: 'Invalid current user request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read the current user profile.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to read this profile.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Current user was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Current user state conflicts with this request.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Current user request failed validation.',
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
  description: 'Updates the currently authenticated user profile.',

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
      description: 'Invalid current user update request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update the current user profile.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to update this profile.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Current user update conflicts with existing data.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Current user update payload failed validation.',
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
  description: 'Returns a public user profile by user id.',

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
      description: 'Invalid user id.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read this user profile.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to read this user profile.',
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
  description: 'Deletes a user account by id. This operation is restricted to root users.',

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
      description: 'Invalid user deletion request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to delete a user.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only root users can delete users.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'User was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'User cannot be deleted because of the current account state.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'User deletion request failed validation.',
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
export const usersSchema = withOpenApiSecurity(taggedUsersSchema, openApiSecurity.accessTokenCookie);