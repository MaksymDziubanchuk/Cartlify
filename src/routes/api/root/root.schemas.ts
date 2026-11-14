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
  canManageNewsletters: false,
  canManageMoney: false,
  locale: 'en',
  phone: '+10000000000',
};

const rootAdminsGetQueryExample = {
  limit: 20,
  search: 'admin@example.com',
};

const rootAdminsGetResponseExample = {
  items: [{ ...rootAdminExample, deletedAt: null }],
  limit: 20,
  nextCursor: null,
  total: 1,
};

const rootAdminsAddBodyExample = {
  userId: 2,
};

const rootAdminsUpdateParamsExample = {
  adminId: '2',
};

const rootAdminsUpdateBodyExample = {
  canManageNewsletters: true,
  canManageMoney: true,
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

// Schema for giving an admin the right to run the newsletters or taking it away
const patchRootAdminSchema = {
  operationId: 'updateRootAdmin',
  summary: 'Give or take the rights of an admin: the newsletters, the money',
  description:
    'Gives an admin the right to run the newsletters (subscribers, the list of blocked ' +
    'addresses, newsletters) with `canManageNewsletters: true`, or takes it away with `false`. ' +
    'Root always has the right; a user cannot have it. The change works at once, also in a ' +
    'session that is open: the server reads the right from the database at every request, and ' +
    'the admin sees it as `canManageNewsletters` in GET /api/users/me. The right goes away when ' +
    'the person stops being an admin and does not come back when root makes them an admin again. ' +
    'The right to handle the money the way root does (money sent outside the app, rows of a ' +
    'statement closed without money, the decisions on refunds made by hand and on the money of a ' +
    'bank, the holds root lets go) is given and taken the same way with `canManageMoney`, and ' +
    'the admin sees it as `canManageMoney`; the body names one right or both. ' +
    'The same value again changes nothing and writes no line to the admin log; a real change ' +
    'writes one for each right (`newsletter.manager_granted` or `newsletter.manager_revoked`, ' +
    '`payment.manager_granted` or `payment.manager_revoked`). Answers with ' +
    'the admin as the list of admins shows one. This operation is restricted to root users.',

  params: {
    $ref: 'rootAdminsUpdateParamsSchema#',
    examples: [rootAdminsUpdateParamsExample],
  },

  body: {
    $ref: 'rootAdminsUpdateBodySchema#',
    examples: [rootAdminsUpdateBodyExample],
  },

  response: {
    200: {
      description:
        'The right is as asked (it changed, or it was so already); the admin is returned.',
      $ref: 'rootAdminsItemSchema#',
      examples: [
        { ...rootAdminExample, canManageNewsletters: true, canManageMoney: true, deletedAt: null },
      ],
    },

    400: {
      description:
        'Invalid request: the body names neither `canManageNewsletters` nor `canManageMoney`, or one of them is not a boolean.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to change the right of an admin.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only root users can change the right of an admin.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`USER_NOT_FOUND`: there is no account with this id, or the admin was deleted and cannot be given the right (taking it away from a deleted admin works).',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description:
        '`USER_NOT_ADMIN`: the account is not an admin (a user, or root, who needs no right).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while changing the right of an admin.',
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
    patchRootAdminSchema,
    deleteRootAdminSchema,
  },
  'root',
);

// Add access token security to all root routes
export const rootAdminsSchemas = withOpenApiSecurity(
  taggedRootAdminsSchema,
  openApiSecurity.accessTokenCookie,
);
