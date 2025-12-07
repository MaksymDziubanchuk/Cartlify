export const userIdParamSchema = {
  $id: 'userIdParamSchema',
  type: 'object',
  properties: {
    userId: { type: 'integer', minimum: 1 },
  },
  required: ['userId'],
  additionalProperties: false,
} as const;

export const productIdParamSchema = {
  $id: 'productIdParamSchema',
  type: 'object',
  properties: {
    productId: { type: 'integer', minimum: 1 },
  },
  required: ['productId'],
  additionalProperties: false,
} as const;

export const reviewIdParamSchema = {
  $id: 'reviewIdParamSchema',
  type: 'object',
  properties: {
    reviewId: { type: 'integer', minimum: 1 },
  },
  required: ['reviewId'],
  additionalProperties: false,
} as const;

export const productReviewIdsParamSchema = {
  $id: 'productReviewIdsParamSchema',
  type: 'object',
  properties: {
    productId: { type: 'integer', minimum: 1 },
    reviewId: { type: 'integer', minimum: 1 },
  },
  required: ['productId', 'reviewId'],
  additionalProperties: false,
} as const;

export const categoryIdParamSchema = {
  $id: 'categoryIdParamSchema',
  type: 'object',
  properties: {
    categoryId: { type: 'integer', minimum: 1 },
  },
  required: ['categoryId'],
  additionalProperties: false,
} as const;

export const orderIdParamSchema = {
  $id: 'orderIdParamSchema',
  type: 'object',
  properties: {
    orderId: { type: 'integer', minimum: 1 },
  },
  required: ['orderId'],
  additionalProperties: false,
} as const;

export const adminIdParamSchema = {
  $id: 'adminIdParamSchema',
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
