const getAllProductsRouterSchema = {
  querystring: { $ref: 'getAllProductsSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const getProductByIdRouterSchema = {
  params: { $ref: 'productIdParamSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const getProductReviewsRouterSchema = {
  params: { $ref: 'productIdParamSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const postProductRouterSchema = {
  body: { $ref: 'createProductSchema#' },
  response: {
    201: { $ref: 'messageResponseSchema#' },
  },
};

const postProductReviewRouterSchema = {
  params: { $ref: 'productIdParamSchema#' },
  body: { $ref: 'createReviewSchema#' },
  response: {
    201: { $ref: 'messageResponseSchema#' },
  },
};

const updateProductByIdRouterSchema = {
  params: { $ref: 'productIdParamSchema#' },
  body: { $ref: 'updateProductSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const deleteProductByIdRouterSchema = {
  params: { $ref: 'productIdParamSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const deleteProductReviewRouterSchema = {
  params: { $ref: 'productReviewIdsParamSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const patchProductCategorySchema = {
  params: { $ref: 'productsUpdateCategoryParamsSchema#' },
  body: { $ref: 'productsUpdateCategoryBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const deleteProductCategorySchema = {
  params: { $ref: 'productsRemoveCategoryParamsSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const productSchemas = {
  getAllProductsRouterSchema,
  getProductByIdRouterSchema,
  getProductReviewsRouterSchema,
  postProductRouterSchema,
  postProductReviewRouterSchema,
  updateProductByIdRouterSchema,
  deleteProductByIdRouterSchema,
  deleteProductReviewRouterSchema,
  patchProductCategorySchema,
  deleteProductCategorySchema,
};
