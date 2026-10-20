import { idPathParam } from '@schemas/idPathParam.js';

const reviewsVoteParamsSchema = {
  $id: 'reviewsVoteParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    reviewId: idPathParam('the review'),
  },
  required: ['reviewId'],
} as const;

const reviewsVoteBodySchema = {
  $id: 'reviewsVoteBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['up', 'down', 'remove'] },
  },
  required: ['action'],
} as const;

const reviewsVoteResponseSchema = {
  $id: 'reviewsVoteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    productId: { type: 'number' },
    upVotes: { type: 'number' },
    downVotes: { type: 'number' },
    // null in the enum too: swagger shows the field as nullable, and openapi 3.0 lets null
    // through a nullable enum only when the enum names it
    userVote: { type: 'string', enum: ['up', 'down', null], nullable: true },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'productId', 'upVotes', 'downVotes', 'userVote', 'updatedAt'],
} as const;

export const reviewsDtoSchemas = [
  reviewsVoteParamsSchema,
  reviewsVoteBodySchema,
  reviewsVoteResponseSchema,
];
