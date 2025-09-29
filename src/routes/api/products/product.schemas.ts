const getAllProductsSchema = {
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const getProductByIdSchema = {
  params: { $ref: 'productIdParamSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const getProductReviewsSchema = {
  params: { $ref: 'productIdParamSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const postProductSchema = {
  body: { $ref: 'createProductSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const postProductReviewSchema = {
  params: { $ref: 'productIdParamSchema#' },
  body: { $ref: 'createProductSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const updateProductByIdSchema = {
  params: { $ref: 'productIdParamSchema#' },
  body: { $ref: 'updateProductSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const deleteProductByIdSchema = {
  params: { $ref: 'productIdParamSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

const deleteProductReviewSchema = {
  params: { $ref: 'productReviewIdsParamSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const productSchemas = {
  getAllProductsSchema,
  getProductByIdSchema,
  getProductReviewsSchema,
  postProductSchema,
  postProductReviewSchema,
  updateProductByIdSchema,
  deleteProductByIdSchema,
  deleteProductReviewSchema,
};
