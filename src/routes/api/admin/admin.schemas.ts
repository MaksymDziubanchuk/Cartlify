export const getStatsSchema = {
  querystring: { $ref: 'adminStatsQuerySchema#' },
  response: {
    200: { $ref: 'adminStatsResponseSchema#' },
  },
};

export const setProductPopularitySchema = {
  params: { $ref: 'adminSetPopularityParamsSchema#' },
  body: { $ref: 'adminSetPopularityBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const getChatsSchema = {
  querystring: { $ref: 'adminChatsQuerySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const adminSchema = {
  getStatsSchema,
  setProductPopularitySchema,
  getChatsSchema,
};
