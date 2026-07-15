import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const favoriteProductExample = {
  id: 10,
  name: 'Wireless headphones',
  description: 'Bluetooth headphones with noise cancellation.',
  price: 49.99,
  stock: 15,
  categoryId: 1,
  images: {
    url200: 'https://example.com/products/headphones-200.webp',
    url400: 'https://example.com/products/headphones-400.webp',
    url800: 'https://example.com/products/headphones-800.webp',
  },
  popularity: 120,
  views: 350,
  avgRating: 4.7,
  reviewsCount: 18,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  deletedAt: null,
};

const favoritesQueryExample = {
  limit: 20,
};

const favoritesGetResponseExample = {
  items: [
    {
      product: favoriteProductExample,
      addedAt: '2026-01-02T10:00:00.000Z',
    },
  ],
  nextCursor: null,
};

const favoriteProductParamsExample = {
  productId: 10,
};

const addFavoriteResponseExample = {
  productId: 10,
  isFavorite: true,
};

const deleteFavoriteResponseExample = {
  productId: 10,
  isFavorite: false,
};

// Schema for guest or user favorites list
const getFavoritesSchema = {
  operationId: 'getFavorites',
  summary: 'Get favorites',
  description: 'Returns the current guest or authenticated user favorite products.',

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
      description: 'Invalid favorites query parameters.',
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
  description: 'Adds a product to the current guest or authenticated user favorites.',

  params: {
    $ref: 'favoritesAddParamsSchema#',
    examples: [favoriteProductParamsExample],
  },

  response: {
    200: {
      description: 'Product was added to favorites successfully.',
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
      description: 'Product was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Product is already in favorites or cannot be added.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Add favorite request failed validation.',
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
  description: 'Removes a product from the current guest or authenticated user favorites.',

  params: {
    $ref: 'favoritesDeleteParamsSchema#',
    examples: [favoriteProductParamsExample],
  },

  response: {
    200: {
      description: 'Product was removed from favorites successfully.',
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