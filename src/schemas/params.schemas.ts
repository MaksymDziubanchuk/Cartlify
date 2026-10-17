import { idPathParam } from '@schemas/idPathParam.js';

export const userIdParamSchema = {
  $id: 'userIdParamSchema',
  type: 'object',
  properties: {
    userId: idPathParam('the user'),
  },
  required: ['userId'],
  additionalProperties: false,
} as const;

export const productIdParamSchema = {
  $id: 'productIdParamSchema',
  type: 'object',
  properties: {
    productId: idPathParam('the product'),
  },
  required: ['productId'],
  additionalProperties: false,
} as const;

export const reviewIdParamSchema = {
  $id: 'reviewIdParamSchema',
  type: 'object',
  properties: {
    reviewId: idPathParam('the review'),
  },
  required: ['reviewId'],
  additionalProperties: false,
} as const;

export const productReviewIdsParamSchema = {
  $id: 'productReviewIdsParamSchema',
  type: 'object',
  properties: {
    productId: idPathParam('the product'),
    reviewId: idPathParam('the review'),
  },
  required: ['productId', 'reviewId'],
  additionalProperties: false,
} as const;

export const categoryIdParamSchema = {
  $id: 'categoryIdParamSchema',
  type: 'object',
  properties: {
    categoryId: idPathParam('the category'),
  },
  required: ['categoryId'],
  additionalProperties: false,
} as const;

export const orderIdParamSchema = {
  $id: 'orderIdParamSchema',
  type: 'object',
  properties: {
    orderId: idPathParam('the order'),
  },
  required: ['orderId'],
  additionalProperties: false,
} as const;

export const adminIdParamSchema = {
  $id: 'adminIdParamSchema',
  type: 'object',
  properties: {
    adminId: idPathParam('the admin'),
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
