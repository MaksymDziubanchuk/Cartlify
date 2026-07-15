import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurityFor } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const categoryExample = {
  id: 2,
  name: 'Smartphones',
  slug: 'smartphones',
  description: 'Smartphones and mobile devices.',
  parentId: 1,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
};

const categoriesListExample = {
  items: [categoryExample],
  limit: 20,
  nextCursor: null,
};

const categoriesQueryExample = {
  limit: 20,
  search: 'phone',
  parentId: 1,
};

const createCategoryBodyExample = {
  name: 'Smartphones',
  slug: 'smartphones',
  description: 'Smartphones and mobile devices.',
  parentId: 1,
};

const updateCategoryBodyExample = {
  name: 'Mobile phones',
  slug: 'mobile-phones',
  description: 'Updated mobile phones category.',
  parentId: 1,
};

const deleteCategoryResponseExample = {
  message: 'Category deleted successfully.',
};

// Schema for category listing
const getCategoriesSchema = {
  operationId: 'getCategories',
  summary: 'Get categories',
  description: 'Returns a paginated list of product categories with optional search and parent filtering.',

  querystring: {
    $ref: 'categoriesGetQuerySchema#',
    examples: [categoriesQueryExample],
  },

  response: {
    200: {
      description: 'Categories were returned successfully.',
      $ref: 'categoriesListResponseSchema#',
      examples: [categoriesListExample],
    },

    400: {
      description: 'Invalid category query parameters.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to read categories.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to read categories.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading categories.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin category creation
const postCategorySchema = {
  operationId: 'createCategory',
  summary: 'Create category',
  description: 'Creates a new product category. This operation is restricted to privileged users.',

  body: {
    $ref: 'categoriesCreateBodySchema#',
    examples: [createCategoryBodyExample],
  },

  response: {
    201: {
      description: 'Category was created successfully.',
      $ref: 'categoriesCreateResponseSchema#',
      examples: [categoryExample],
    },

    400: {
      description: 'Invalid category creation request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to create a category.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to create categories.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Category conflicts with an existing category.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Category creation payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while creating category.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin category update
const patchCategorySchema = {
  operationId: 'updateCategory',
  summary: 'Update category',
  description: 'Updates category data by category id. This operation is restricted to privileged users.',

  params: { $ref: 'categoriesUpdateParamsSchema#' },

  body: {
    $ref: 'categoriesUpdateBodySchema#',
    examples: [updateCategoryBodyExample],
  },

  response: {
    200: {
      description: 'Category was updated successfully.',
      $ref: 'categoriesUpdateResponseSchema#',
      examples: [
        {
          ...categoryExample,
          name: 'Mobile phones',
          slug: 'mobile-phones',
          description: 'Updated mobile phones category.',
          updatedAt: '2026-01-02T10:00:00.000Z',
        },
      ],
    },

    400: {
      description: 'Invalid category update request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to update a category.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to update categories.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Category was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Category update conflicts with an existing category.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Category update payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while updating category.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin category deletion
const deleteCategorySchema = {
  operationId: 'deleteCategory',
  summary: 'Delete category',
  description: 'Deletes a category by category id. This operation is restricted to privileged users.',

  params: { $ref: 'categoriesDeleteParamsSchema#' },

  response: {
    200: {
      description: 'Category was deleted successfully.',
      $ref: 'categoriesDeleteResponseSchema#',
      examples: [deleteCategoryResponseExample],
    },

    400: {
      description: 'Invalid category delete request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to delete a category.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to delete categories.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Category was not found.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting category.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group category routes under the categories Swagger tag
const taggedCategoriesSchemas = withOpenApiTag(
  {
    getCategoriesSchema,
    postCategorySchema,
    patchCategorySchema,
    deleteCategorySchema,
  },
  'categories',
);

// Add guest or user cookie security to category read route
const categoriesSchemasWithReadSecurity = withOpenApiSecurityFor(
  taggedCategoriesSchemas,
  openApiSecurity.userOrGuestCookie,
  ['getCategoriesSchema'],
);

// Add access token security to category mutations
export const categoriesSchema = withOpenApiSecurityFor(
  categoriesSchemasWithReadSecurity,
  openApiSecurity.accessTokenCookie,
  ['postCategorySchema', 'patchCategorySchema', 'deleteCategorySchema'],
);