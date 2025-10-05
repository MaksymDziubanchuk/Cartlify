export const getFavoritesSchema = {
  querystring: { $ref: 'favoritesGetQuerySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const postToggleFavoriteSchema = {
  params: { $ref: 'favoritesToggleParamsSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const deleteFavoriteSchema = {
  params: { $ref: 'favoritesDeleteParamsSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const favoritesSchema = {
  getFavoritesSchema,
  postToggleFavoriteSchema,
  deleteFavoriteSchema,
};
