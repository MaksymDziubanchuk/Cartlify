export const userIdParamSchema = {
  $id: 'userIdParam',
  type: 'object',
  properties: {
    userId: { type: 'integer', minimum: 1 },
  },
  required: ['userId'],
} as const;

export const productIdParamSchema = {
  $id: 'productIdParam',
  type: 'object',
  properties: {
    productId: { type: 'integer', minimum: 1 },
  },
  required: ['productId'],
} as const;

export const reviewIdParamSchema = {
  $id: 'reviewIdParam',
  type: 'object',
  properties: {
    reviewId: { type: 'integer', minimum: 1 },
  },
  required: ['reviewId'],
} as const;

export const productReviewIdsParamSchema = {
  $id: 'productReviewIdsParam',
  type: 'object',
  properties: {
    productId: { type: 'integer', minimum: 1 },
    reviewId: { type: 'integer', minimum: 1 },
  },
  required: ['productId', 'reviewId'],
} as const;

export const categoryIdParamSchema = {
  $id: 'categoryIdParam',
  type: 'object',
  properties: {
    categoryId: { type: 'integer', minimum: 1 },
  },
  required: ['categoryId'],
} as const;

export const orderIdParamSchema = {
  $id: 'orderIdParam',
  type: 'object',
  properties: {
    orderId: { type: 'integer', minimum: 1 },
  },
  required: ['orderId'],
} as const;

export const adminIdParamSchema = {
  $id: 'adminIdParam',
  type: 'object',
  properties: {
    adminId: { type: 'integer', minimum: 1 },
  },
  required: ['adminId'],
} as const;

export const paramsSchemas = [
  userIdParamSchema,
  productIdParamSchema,
  reviewIdParamSchema,
  productReviewIdsParamSchema,
  categoryIdParamSchema,
  orderIdParamSchema,
  adminIdParamSchema,
];
