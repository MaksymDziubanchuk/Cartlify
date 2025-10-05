export const reviewsVoteParamsSchema = {
  $id: 'reviewsVoteParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    reviewId: { type: 'number' },
  },
  required: ['reviewId'],
} as const;

export const reviewsVoteBodySchema = {
  $id: 'reviewsVoteBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['up', 'down', 'remove'] },
  },
  required: ['action'],
} as const;

export const reviewsVoteResponseSchema = {
  $id: 'reviewsVoteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    productId: { type: 'number' },
    upVotes: { type: 'number' },
    downVotes: { type: 'number' },
    userVote: {
      anyOf: [{ type: 'string', enum: ['up', 'down'] }, { type: 'null' }],
    },
    updatedAt: { type: 'string', format: 'date-time' },
  },
  required: ['id', 'productId', 'upVotes', 'downVotes', 'userVote', 'updatedAt'],
} as const;

export const reviewsDtoSchemas = [
  reviewsVoteParamsSchema,
  reviewsVoteBodySchema,
  reviewsVoteResponseSchema,
];
