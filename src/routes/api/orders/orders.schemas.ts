export const getOrdersSchema = {
  querystring: { $ref: 'ordersGetQuerySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const getOrderByIdSchema = {
  params: { $ref: 'ordersGetByIdParamsSchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const postOrderSchema = {
  body: { $ref: 'ordersCreateBodySchema#' },
  response: {
    201: { $ref: 'messageResponseSchema#' },
  },
};

export const putOrderStatusSchema = {
  params: { $ref: 'ordersUpdateStatusParamsSchema#' },
  body: { $ref: 'ordersUpdateStatusBodySchema#' },
  response: {
    200: { $ref: 'messageResponseSchema#' },
  },
};

export const ordersSchema = {
  getOrdersSchema,
  getOrderByIdSchema,
  postOrderSchema,
  putOrderStatusSchema,
};
