import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const voteReviewParamsExample = {
  reviewId: 1,
};

const voteReviewBodyExample = {
  action: 'up',
};

const voteReviewResponseExample = {
  id: 1,
  productId: 10,
  upVotes: 12,
  downVotes: 2,
  userVote: 'up',
  updatedAt: '2026-01-01T10:00:00.000Z',
};

// Schema for authenticated user review voting
const postVoteReviewSchema = {
  operationId: 'voteReview',
  summary: 'Vote review',
  description: 'Adds, changes or removes the authenticated user vote for a product review.',

  params: {
    $ref: 'reviewsVoteParamsSchema#',
    examples: [voteReviewParamsExample],
  },

  body: {
    $ref: 'reviewsVoteBodySchema#',
    examples: [voteReviewBodyExample],
  },

  response: {
    200: {
      description: 'Review vote was applied successfully.',
      $ref: 'reviewsVoteResponseSchema#',
      examples: [voteReviewResponseExample],
    },

    400: {
      description: 'Invalid review vote request.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to vote for a review.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'Only authenticated users with the USER role can vote for reviews.',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'Review was not found.',
      $ref: 'errorResponseSchema#',
    },
    409: {
      description: 'Review vote conflicts with the current review state.',
      $ref: 'errorResponseSchema#',
    },
    422: {
      description: 'Review vote payload failed validation.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while voting for review.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group review routes under the reviews Swagger tag
const taggedReviewsSchema = withOpenApiTag(
  {
    postVoteReviewSchema,
  },
  'reviews',
);

// Add access token security to all review routes
export const reviewsSchemas = withOpenApiSecurity(
  taggedReviewsSchema,
  openApiSecurity.accessTokenCookie,
);
