export const ordersGetQuerySchema = {
  $id: 'ordersGetQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    page: { type: 'number', minimum: 1 },
    limit: { type: 'number', minimum: 1 },
    status: { type: 'string', enum: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] },
    confirmed: { type: 'boolean', enum: ['true', 'false'] },
  },
} as const;

export const ordersGetByIdParamsSchema = {
  $id: 'ordersGetByIdParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: { type: 'number' },
  },
  required: ['orderId'],
} as const;

export const ordersCreateItemSchema = {
  $id: 'ordersCreateItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'number' },
    quantity: { type: 'number', minimum: 1 },
  },
  required: ['productId', 'quantity'],
} as const;

export const ordersCreateBodySchema = {
  $id: 'ordersCreateBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', minItems: 1, items: { $ref: 'ordersCreateItemSchema#' } },
    note: { type: 'string' },
    shippingAddress: { type: 'string' },
  },
  required: ['items', 'shippingAddress'],
} as const;

export const ordersOrderItemSchema = {
  $id: 'ordersOrderItemSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'number' },
    quantity: { type: 'number' },
    unitPrice: { type: 'number' },
    totalPrice: { type: 'number' },
  },
  required: ['productId', 'quantity', 'unitPrice', 'totalPrice'],
} as const;

export const ordersOrderResponseSchema = {
  $id: 'ordersOrderResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    userId: { type: 'number' },
    status: { type: 'string', enum: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] },
    items: { type: 'array', items: { $ref: 'ordersOrderItemSchema#' } },
    total: { type: 'number' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    note: { type: 'string' },
    shippingAddress: { type: 'string' },
  },
  required: [
    'id',
    'userId',
    'status',
    'items',
    'total',
    'createdAt',
    'updatedAt',
    'shippingAddress',
  ],
} as const;

export const ordersCreateResponseSchema = {
  $id: 'ordersCreateResponseSchema',
  allOf: [{ $ref: 'ordersOrderResponseSchema#' }],
} as const;

export const ordersUpdateStatusParamsSchema = {
  $id: 'ordersUpdateStatusParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: { type: 'number' },
  },
  required: ['orderId'],
} as const;

export const ordersUpdateConfirmStatusParamsSchema = {
  $id: 'ordersUpdateConfirmStatusParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: { type: 'number' },
  },
  required: ['orderId'],
} as const;

export const ordersUpdateStatusBodySchema = {
  $id: 'ordersUpdateStatusBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'] },
  },
  required: ['status'],
} as const;

export const ordersUpdateStatusResponseSchema = {
  $id: 'ordersUpdateStatusResponseSchema',
  allOf: [{ $ref: 'ordersOrderResponseSchema#' }],
} as const;

export const ordersListResponseSchema = {
  $id: 'ordersListResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'ordersOrderResponseSchema#' } },
    page: { type: 'number' },
    limit: { type: 'number' },
    total: { type: 'number' },
  },
  required: ['items'],
} as const;

export const ordersDeleteParamsSchema = {
  $id: 'ordersDeleteParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: { type: 'number', minimum: 1 },
  },
  required: ['orderId'],
} as const;

export const ordersDeleteResponseSchema = {
  $id: 'ordersDeleteResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
} as const;

export const ordersDtoSchemas = [
  ordersGetQuerySchema,
  ordersGetByIdParamsSchema,
  ordersCreateItemSchema,
  ordersCreateBodySchema,
  ordersOrderItemSchema,
  ordersOrderResponseSchema,
  ordersCreateResponseSchema,
  ordersUpdateStatusParamsSchema,
  ordersUpdateStatusBodySchema,
  ordersUpdateStatusResponseSchema,
  ordersListResponseSchema,
  ordersDeleteParamsSchema,
  ordersDeleteResponseSchema,
];
