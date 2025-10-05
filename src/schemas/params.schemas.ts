export const userIdParamSchema = {
  $id: 'userIdParam',
  type: 'object',
  properties: {
    userId: { type: 'integer', minimum: 1 },
  },
  required: ['userId'],
  additionalProperties: false,
} as const;

export const productIdParamSchema = {
  $id: 'productIdParam',
  type: 'object',
  properties: {
    productId: { type: 'integer', minimum: 1 },
  },
  required: ['productId'],
  additionalProperties: false,
} as const;

export const reviewIdParamSchema = {
  $id: 'reviewIdParam',
  type: 'object',
  properties: {
    reviewId: { type: 'integer', minimum: 1 },
  },
  required: ['reviewId'],
  additionalProperties: false,
} as const;

export const productReviewIdsParamSchema = {
  $id: 'productReviewIdsParam',
  type: 'object',
  properties: {
    productId: { type: 'integer', minimum: 1 },
    reviewId: { type: 'integer', minimum: 1 },
  },
  required: ['productId', 'reviewId'],
  additionalProperties: false,
} as const;

export const categoryIdParamSchema = {
  $id: 'categoryIdParam',
  type: 'object',
  properties: {
    categoryId: { type: 'integer', minimum: 1 },
  },
  required: ['categoryId'],
  additionalProperties: false,
} as const;

export const orderIdParamSchema = {
  $id: 'orderIdParam',
  type: 'object',
  properties: {
    orderId: { type: 'integer', minimum: 1 },
  },
  required: ['orderId'],
  additionalProperties: false,
} as const;

export const adminIdParamSchema = {
  $id: 'adminIdParam',
  type: 'object',
  properties: {
    adminId: { type: 'integer', minimum: 1 },
  },
  required: ['adminId'],
  additionalProperties: false,
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
