import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const rootAdminExample = {
  id: 2,
  email: 'admin@example.com',
  role: 'ADMIN',
  isVerified: true,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  name: 'Admin User',
  avatarUrls: {
    url32: 'https://example.com/avatars/admin-32.webp',
    url64: 'https://example.com/avatars/admin-64.webp',
    url128: 'https://example.com/avatars/admin-128.webp',
    url256: 'https://example.com/avatars/admin-256.webp',
  },
  avatarIsDefault: false,
  locale: 'en',
  phone: '+10000000000',
};

const rootAdminsGetQueryExample = {
  limit: 20,
  search: 'admin@example.com',
};

const rootAdminsGetResponseExample = {
  items: [rootAdminExample],
  limit: 20,
  nextCursor: null,
  total: 1,
};

const rootAdminsAddBodyExample = {
  userId: 2,
};

const rootAdminsDeleteParamsExample = {
  adminId: '2',
};

const rootAdminsDeleteResponseExample = {
  message: 'admin removed',
};

// Schema for root admin list lookup
const getRootAdminsSchema = {
  operationId: 'getRootAdmins',
  summary: 'Get root admins',
  description:
    'Returns a paginated list of users with the ADMIN role. This operation is restricted to root users.',

  querystring: {
    $ref: 'rootAdminsGetQuerySchema#',
    examples: [rootAdminsGetQueryExample],
  },

  response: {
    200: {
      description: 'Admin users were returned successfully.',
      $ref: 'rootAdminsGetResponseSchema#',
      examples: [rootAdminsGetResponseExample],
    },

    400: {
      description: 'Invalid root admins query parameters.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read admin users.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only root users can read admin users.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading admin users.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for promoting user to admin
const postRootAdminSchema = {
  operationId: 'createRootAdmin',
  summary: 'Create root admin',
  description:
    'Promotes an existing user to ADMIN role. This operation is restricted to root users.',

  body: {
    $ref: 'rootAdminsAddBodySchema#',
    examples: [rootAdminsAddBodyExample],
  },

  response: {
    201: {
      description: 'User was promoted to admin successfully.',
      $ref: 'rootAdminsAddResponseSchema#',
      examples: [rootAdminExample],
    },

    400: {
      description: 'Invalid admin promotion request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to promote an admin.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only root users can promote admins.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`USER_NOT_FOUND`: there is no user with this id.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The user is an admin already (USER_ALREADY_ADMIN) or is root (USER_IS_ROOT).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while promoting admin.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for demoting admin to user
const deleteRootAdminSchema = {
  operationId: 'deleteRootAdmin',
  summary: 'Delete root admin',
  description:
    'Demotes an ADMIN user back to USER role. This operation is restricted to root users.',

  params: {
    $ref: 'rootAdminsDeleteParamsSchema#',
    examples: [rootAdminsDeleteParamsExample],
  },

  response: {
    200: {
      description: 'Admin user was demoted successfully.',
      $ref: 'rootAdminsDeleteResponseSchema#',
      examples: [rootAdminsDeleteResponseExample],
    },

    400: {
      description: 'Invalid admin deletion request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to demote an admin.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only root users can demote admins.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`USER_NOT_FOUND`: there is no user with this id.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        'The user is not an admin (USER_NOT_ADMIN), or is root, who cannot be demoted (ROOT_CANNOT_BE_DEMOTED).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while demoting admin.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group root routes under the root Swagger tag
const taggedRootAdminsSchema = withOpenApiTag(
  {
    getRootAdminsSchema,
    postRootAdminSchema,
    deleteRootAdminSchema,
  },
  'root',
);

// Add access token security to all root routes
export const rootAdminsSchemas = withOpenApiSecurity(
  taggedRootAdminsSchema,
  openApiSecurity.accessTokenCookie,
);
