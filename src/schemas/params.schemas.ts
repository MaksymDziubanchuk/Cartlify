export const userIdParamSchema = {
  $id: 'userIdParamSchema',
  type: 'object',
  properties: {
    userId: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
  required: ['userId'],
  additionalProperties: false,
} as const;

export const productIdParamSchema = {
  $id: 'productIdParamSchema',
  type: 'object',
  properties: {
    productId: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
  required: ['productId'],
  additionalProperties: false,
} as const;

export const reviewIdParamSchema = {
  $id: 'reviewIdParamSchema',
  type: 'object',
  properties: {
    reviewId: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
  required: ['reviewId'],
  additionalProperties: false,
} as const;

export const productReviewIdsParamSchema = {
  $id: 'productReviewIdsParamSchema',
  type: 'object',
  properties: {
    productId: { type: 'string', pattern: '^[1-9][0-9]*$' },
    reviewId: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
  required: ['productId', 'reviewId'],
  additionalProperties: false,
} as const;

export const categoryIdParamSchema = {
  $id: 'categoryIdParamSchema',
  type: 'object',
  properties: {
    categoryId: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
  required: ['categoryId'],
  additionalProperties: false,
} as const;

export const orderIdParamSchema = {
  $id: 'orderIdParamSchema',
  type: 'object',
  properties: {
    orderId: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
  required: ['orderId'],
  additionalProperties: false,
} as const;

export const adminIdParamSchema = {
  $id: 'adminIdParamSchema',
  type: 'object',
  properties: {
    adminId: { type: 'string', pattern: '^[1-9][0-9]*$' },
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
