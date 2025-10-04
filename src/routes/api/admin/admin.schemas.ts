export const getStatsSchema = {
  querystring: { $ref: 'adminStatsQuery#' },
  response: {
    200: { $ref: 'adminStatsResponse#' },
  },
};

export const setProductPopularity = {
  params: { $ref: 'adminSetPopularityParams#' },
  body: { $ref: 'adminSetPopularityBody#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const getChatsSchema = {
  querystring: { $ref: 'adminChatsQuery#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const adminSchema = {
  getStatsSchema,
  setProductPopularity,
  getChatsSchema,
};
