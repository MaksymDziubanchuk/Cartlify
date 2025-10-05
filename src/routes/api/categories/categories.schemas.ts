export const getCategoriesSchema = {
  querystring: { $ref: 'categoriesGetQuerySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const postCategorySchema = {
  body: { $ref: 'categoriesCreateBodySchema#' },
  response: {
    201: { $ref: 'messageResponseSchema#' },
  },
};

export const patchCategorySchema = {
  params: { $ref: 'categoriesUpdateParamsSchema#' },
  body: { $ref: 'categoriesUpdateBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const deleteCategorySchema = {
  params: { $ref: 'categoriesDeleteParamsSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const categoriesSchema = {
  getCategoriesSchema,
  postCategorySchema,
  patchCategorySchema,
  deleteCategorySchema,
};
