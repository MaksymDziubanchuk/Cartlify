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
  imageUrls: null,
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

const categoryParamsExample = {
  categoryId: '2',
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
  description:
    'Returns a paginated list of product categories with optional search and parent filtering.',

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
      description:
        'Invalid category query parameters: a cursor this route did not give (CURSOR_INVALID).',
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

// Schema for the whole tree of the categories
const getCategoryTreeSchema = {
  operationId: 'getCategoryTree',
  summary: 'Get the category tree',
  description:
    'The whole tree of the categories for the menu of the catalog: each category with the ones ' +
    'right below it, by name, and the products of the catalog of its whole branch ' +
    '(`productCount`, the products taken out of the catalog are not counted). ' +
    '`GET /api/products?categoryIds=<id>` lists the products of a branch.',

  response: {
    200: {
      description: 'The tree was returned, the categories at the top in items.',
      $ref: 'categoryTreeResponseSchema#',
      examples: [
        {
          items: [
            {
              id: 1,
              name: 'Phones',
              slug: 'phones',
              productCount: 12,
              children: [
                { id: 2, name: 'Smartphones', slug: 'smartphones', productCount: 12, children: [] },
              ],
            },
          ],
        },
      ],
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
      description: 'Unexpected server error while loading the tree.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for admin category creation
const postCategorySchema = {
  operationId: 'createCategory',
  summary: 'Create category',
  description:
    'Creates a new product category. This operation is restricted to privileged users. ' +
    'The name and the slug are required; the category takes no children, they come to it one ' +
    'PATCH each.',

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
      description:
        'Invalid category creation request: no name or slug (VALIDATION_ERROR), an empty name ' +
        '(CATEGORY_NAME_INVALID), a slug of no latin letter or digit (CATEGORY_SLUG_INVALID), a ' +
        'parentId that is not a whole number from 1 to 2147483647 (VALIDATION_ERROR).',
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
      description:
        'Category conflicts with an existing category: its slug is taken (CATEGORY_SLUG_TAKEN), or the ' +
        'parent named is the new category itself (CATEGORY_PARENT_CYCLE).',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: '`CATEGORY_PARENT_NOT_FOUND`: there is no category with this `parentId`.',
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
  description:
    'Updates category data by category id. This operation is restricted to privileged users. ' +
    'A new parentId moves the category with its whole branch, null moves it to the top; the tree ' +
    'goes from the top down, so a category never goes inside its own branch (409 ' +
    'CATEGORY_PARENT_CYCLE), and the children of a new parent category come to it one PATCH each.',

  params: {
    $ref: 'categoriesUpdateParamsSchema#',
    examples: [categoryParamsExample],
  },

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
      description:
        'Invalid category update request: the category made a parent of itself (CATEGORY_PARENT_ID_INVALID).',
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
      description:
        'The slug is taken (CATEGORY_SLUG_TAKEN), or the new parent is inside the branch of the ' +
        'category, under one of its subcategories (CATEGORY_PARENT_CYCLE).',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: '`CATEGORY_PARENT_NOT_FOUND`: there is no category with this `parentId`.',
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
  description:
    'Deletes a category by category id. This operation is restricted to privileged users. ' +
    'Its direct children go to its parent, or to the top for a top category, with their ' +
    'branches; each move goes to the journal of the admins. A category with products stays.',

  params: {
    $ref: 'categoriesDeleteParamsSchema#',
    examples: [categoryParamsExample],
  },

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
    409: {
      description: 'The category has products (CATEGORY_HAS_PRODUCTS), it stays.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting category.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the picture of a category
const putCategoryImageSchema = {
  operationId: 'setCategoryImage',
  summary: 'Set the picture of a category',
  description:
    'Puts a picture on a category, or replaces the one it has (the old file is deleted). The picture ' +
    'is optional: a category has none until it gets one. The body is a form with one file, `image`, ' +
    'a jpeg, png or webp file by its content. Admin and root only; the change goes to the journal of ' +
    'the admins.',

  params: {
    $ref: 'categoriesUpdateParamsSchema#',
    examples: [categoryParamsExample],
  },

  response: {
    200: {
      description: 'The category with its picture.',
      $ref: 'categoriesUpdateResponseSchema#',
    },
    400: {
      description:
        '`MULTIPART_REQUIRED`: the body is not a form. `CATEGORY_IMAGE_REQUIRED`: the form has no ' +
        '`image` file. `CATEGORY_IMAGE_MULTIPLE`: the form has more than one. `CATEGORY_IMAGE_EMPTY`, ' +
        '`CATEGORY_IMAGE_STREAM_ERROR`: an empty file. `IMAGE_TYPE_NOT_ALLOWED`: not a jpeg, png or ' +
        'webp file. `IMAGE_INVALID`: Cloudinary cannot read the file.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to set the picture of a category.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to change categories.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`CATEGORY_NOT_FOUND`: there is no such category.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while setting the picture.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for taking the picture off a category
const deleteCategoryImageSchema = {
  operationId: 'deleteCategoryImage',
  summary: 'Take the picture off a category',
  description:
    'Takes the picture off a category and deletes its file. Admin and root only; the change goes ' +
    'to the journal of the admins.',

  params: {
    $ref: 'categoriesUpdateParamsSchema#',
    examples: [categoryParamsExample],
  },

  response: {
    200: {
      description: 'The category without its picture.',
      $ref: 'categoriesUpdateResponseSchema#',
    },
    401: {
      description: 'Authentication is required to take the picture off a category.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to change categories.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: '`CATEGORY_NOT_FOUND`: there is no such category.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: '`CATEGORY_IMAGE_NOT_SET`: the category has no picture.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while taking the picture off.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group category routes under the categories Swagger tag
const taggedCategoriesSchemas = withOpenApiTag(
  {
    getCategoriesSchema,
    getCategoryTreeSchema,
    postCategorySchema,
    patchCategorySchema,
    deleteCategorySchema,
    putCategoryImageSchema,
    deleteCategoryImageSchema,
  },
  'categories',
);

// Add guest or user cookie security to category read route
const categoriesSchemasWithReadSecurity = withOpenApiSecurityFor(
  taggedCategoriesSchemas,
  openApiSecurity.userOrGuestCookie,
  ['getCategoriesSchema', 'getCategoryTreeSchema'],
);

// Add access token security to category mutations
export const categoriesSchema = withOpenApiSecurityFor(
  categoriesSchemasWithReadSecurity,
  openApiSecurity.accessTokenCookie,
  [
    'postCategorySchema',
    'patchCategorySchema',
    'deleteCategorySchema',
    'putCategoryImageSchema',
    'deleteCategoryImageSchema',
  ],
);
