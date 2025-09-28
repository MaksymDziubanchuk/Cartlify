const getAllProductsSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
    },
  },
};

const getProductByIdSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
    },
  },
};

const getProductReviewsSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
    },
  },
};

const postProductSchema = {
  response: {
    201: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
    },
  },
};

const postProductReviewSchema = {
  response: {
    201: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
    },
  },
};

const updateProductByIdSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
    },
  },
};

const deleteProductByIdSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
    },
  },
};

const deleteProductReviewSchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
    },
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
