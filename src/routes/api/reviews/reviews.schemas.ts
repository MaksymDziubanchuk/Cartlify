export const postVoteReviewSchema = {
  params: { $ref: 'reviewsVoteParamsSchema#' },
  body: { $ref: 'reviewsVoteBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const reviewsSchemas = {
  postVoteReviewSchema,
};
