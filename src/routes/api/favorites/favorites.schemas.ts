import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

import { EXAMPLE_VARIANT_NAME, EXAMPLE_VARIANT_VALUES } from '../products/variantValues.docs.js';

const favoriteProductExample = {
  id: 10,
  name: 'Wireless headphones',
  description: 'Bluetooth headphones with noise cancellation.',
  category: { id: 1, name: 'Headphones', slug: 'headphones' },
  popularity: 120,
  avgRating: 4.7,
  reviewsCount: 18,
  createdAt: '2026-01-01T10:00:00.000Z',
};

const favoriteVariantExample = {
  id: 31,
  position: 2,
  name: EXAMPLE_VARIANT_NAME,
  values: EXAMPLE_VARIANT_VALUES,
  price: 49.99,
  stock: 15,
  image: {
    url200: 'https://example.com/products/headphones-200.webp',
    url400: 'https://example.com/products/headphones-400.webp',
    url800: 'https://example.com/products/headphones-800.webp',
  },
};

const favoritesQueryExample = {
  limit: 20,
};

const favoritesGetResponseExample = {
  items: [
    {
      product: favoriteProductExample,
      variant: favoriteVariantExample,
      addedAt: '2026-01-02T10:00:00.000Z',
    },
  ],
  nextCursor: null,
};

const favoriteVariantParamsExample = {
  variantId: '31',
};

const addFavoriteResponseExample = {
  variantId: 31,
  isFavorite: true,
};

const deleteFavoriteResponseExample = {
  variantId: 31,
  isFavorite: false,
};

// Schema for guest or user favorites list
const getFavoritesSchema = {
  operationId: 'getFavorites',
  summary: 'Get favorites',
  description:
    'Returns the favorites of the current guest or authenticated user, newest first. A favorite is a ' +
    'variant of a product, so each row is { product, variant, addedAt }: the product as a list of a ' +
    'buyer shows it (with its popularity, without the fields of an admin) and the short variant ' +
    '(its name, price, the sale while it lasts, the free units, the main picture). A person who ' +
    'likes two variants of one product has two rows. A variant a buyer does not see (taken out of ' +
    'sale, without a picture, or of a product taken out of the catalog) stays a favorite but is not ' +
    'in the list; it comes back with the variant.',

  querystring: {
    $ref: 'favoritesGetQuerySchema#',
    examples: [favoritesQueryExample],
  },

  response: {
    200: {
      description: 'Favorites were returned successfully.',
      $ref: 'favoritesGetResponseSchema#',
      examples: [favoritesGetResponseExample],
    },

    400: {
      description:
        'Invalid favorites query parameters. `CURSOR_INVALID`: the cursor is not one the list gave.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to read favorites.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to read favorites.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading favorites.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for adding product to favorites
const postAddFavoriteSchema = {
  operationId: 'addFavorite',
  summary: 'Add favorite',
  description:
    'Adds a variant of a product to the favorites of the current guest or authenticated user. The ' +
    'same variant again answers 200 as the first time and is kept once.',

  params: {
    $ref: 'favoritesAddParamsSchema#',
    examples: [favoriteVariantParamsExample],
  },

  response: {
    200: {
      description: 'The variant was added to the favorites successfully.',
      $ref: 'favoritesAddResponseSchema#',
      examples: [addFavoriteResponseExample],
    },

    400: {
      description: 'Invalid add favorite request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to add favorites.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to add favorites.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description:
        '`VARIANT_NOT_FOUND`: there is no such variant, or a buyer does not see it: it was taken ' +
        'out of sale, it shows no picture, or its product was taken out of the catalog.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while adding favorite.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for removing product from favorites
const deleteFavoriteSchema = {
  operationId: 'deleteFavorite',
  summary: 'Delete favorite',
  description:
    'Removes a variant from the favorites of the current guest or authenticated user. A variant ' +
    'that is not among them answers 200 as well.',

  params: {
    $ref: 'favoritesDeleteParamsSchema#',
    examples: [favoriteVariantParamsExample],
  },

  response: {
    200: {
      description: 'The variant was removed from the favorites successfully.',
      $ref: 'favoritesDeleteResponseSchema#',
      examples: [deleteFavoriteResponseExample],
    },

    400: {
      description: 'Invalid delete favorite request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication or guest session is required to delete favorites.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not allowed to delete favorites.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while deleting favorite.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group favorite routes under the favorites Swagger tag
const taggedFavoritesSchema = withOpenApiTag(
  {
    getFavoritesSchema,
    postAddFavoriteSchema,
    deleteFavoriteSchema,
  },
  'favorites',
);

// Add guest or user cookie security to all favorite routes
export const favoritesSchema = withOpenApiSecurity(
  taggedFavoritesSchema,
  openApiSecurity.userOrGuestCookie,
);
