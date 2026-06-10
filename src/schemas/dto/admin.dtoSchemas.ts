const adminOrderStatusValues = [
  'pending',
  'unconfirmed',
  'waiting',
  'paid',
  'shipped',
  'delivered',
  'cancelled',
] as const;

const dateTimeSchema = {
  type: 'string',
  format: 'date-time',
} as const;

const nonNegativeIntegerSchema = {
  type: 'integer',
  minimum: 0,
} as const;

const positiveIntegerSchema = {
  type: 'integer',
  minimum: 1,
} as const;

const nonNegativeNumberSchema = {
  type: 'number',
  minimum: 0,
} as const;

const percentSchema = {
  type: 'number',
  minimum: 0,
  maximum: 100,
} as const;

const ratingAverageSchema = {
  type: 'number',
  minimum: 0,
  maximum: 5,
} as const;

const adminStatsQuerySchema = {
  $id: 'adminStatsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateTimeSchema,
    to: dateTimeSchema,
  },
} as const;

const adminStatsPeriodSchema = {
  $id: 'adminStatsPeriodSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: dateTimeSchema,
    to: dateTimeSchema,
  },
  required: ['from', 'to'],
} as const;

const adminStatsUsersSchema = {
  $id: 'adminStatsUsersSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    total: nonNegativeIntegerSchema,
    newInPeriod: nonNegativeIntegerSchema,
    new7d: nonNegativeIntegerSchema,
    new30d: nonNegativeIntegerSchema,
    verifiedTotal: nonNegativeIntegerSchema,
    verifiedRate: percentSchema,
  },
  required: ['total', 'newInPeriod', 'new7d', 'new30d', 'verifiedTotal', 'verifiedRate'],
} as const;

const adminStatsOrdersByStatusSchema = {
  $id: 'adminStatsOrdersByStatusSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    pending: nonNegativeIntegerSchema,
    unconfirmed: nonNegativeIntegerSchema,
    waiting: nonNegativeIntegerSchema,
    paid: nonNegativeIntegerSchema,
    shipped: nonNegativeIntegerSchema,
    delivered: nonNegativeIntegerSchema,
    cancelled: nonNegativeIntegerSchema,
  },
  required: adminOrderStatusValues,
} as const;

const adminStatsOrdersRevenueSchema = {
  $id: 'adminStatsOrdersRevenueSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    total: nonNegativeNumberSchema,
    inPeriod: nonNegativeNumberSchema,
    last7d: nonNegativeNumberSchema,
    last30d: nonNegativeNumberSchema,
  },
  required: ['total', 'inPeriod', 'last7d', 'last30d'],
} as const;

const adminStatsOrdersSchema = {
  $id: 'adminStatsOrdersSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    total: nonNegativeIntegerSchema,

    // confirmed orders are real orders, pending carts are not revenue
    confirmedTotal: nonNegativeIntegerSchema,
    pendingCartsTotal: nonNegativeIntegerSchema,

    byStatus: { $ref: 'adminStatsOrdersByStatusSchema#' },
    revenue: { $ref: 'adminStatsOrdersRevenueSchema#' },

    averageOrderValue: nonNegativeNumberSchema,
    itemsSold: nonNegativeIntegerSchema,
  },
  required: [
    'total',
    'confirmedTotal',
    'pendingCartsTotal',
    'byStatus',
    'revenue',
    'averageOrderValue',
    'itemsSold',
  ],
} as const;

const adminTopProductRevenueSchema = {
  $id: 'adminTopProductRevenueSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: positiveIntegerSchema,
    name: { type: 'string', minLength: 1 },
    revenue: nonNegativeNumberSchema,
    quantitySold: nonNegativeIntegerSchema,
  },
  required: ['id', 'name', 'revenue', 'quantitySold'],
} as const;

const adminTopCategoryRevenueSchema = {
  $id: 'adminTopCategoryRevenueSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: positiveIntegerSchema,
    name: { type: 'string', minLength: 1 },
    revenue: nonNegativeNumberSchema,
    quantitySold: nonNegativeIntegerSchema,
  },
  required: ['id', 'name', 'revenue', 'quantitySold'],
} as const;

const adminStatsProductsSchema = {
  $id: 'adminStatsProductsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    total: nonNegativeIntegerSchema,
    activeTotal: nonNegativeIntegerSchema,
    deletedTotal: nonNegativeIntegerSchema,
    outOfStockTotal: nonNegativeIntegerSchema,

    topProductsByRevenue: {
      type: 'array',
      items: { $ref: 'adminTopProductRevenueSchema#' },
    },

    topCategoriesByRevenue: {
      type: 'array',
      items: { $ref: 'adminTopCategoryRevenueSchema#' },
    },
  },
  required: [
    'total',
    'activeTotal',
    'deletedTotal',
    'outOfStockTotal',
    'topProductsByRevenue',
    'topCategoriesByRevenue',
  ],
} as const;

const adminStatsReviewsSchema = {
  $id: 'adminStatsReviewsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    total: nonNegativeIntegerSchema,
    ratedTotal: nonNegativeIntegerSchema,
    newInPeriod: nonNegativeIntegerSchema,
    avgRating: ratingAverageSchema,

    // negative review means rating <= 2
    negativeCount: nonNegativeIntegerSchema,
  },
  required: ['total', 'ratedTotal', 'newInPeriod', 'avgRating', 'negativeCount'],
} as const;

const adminStatsResponseSchema = {
  $id: 'adminStatsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    period: { $ref: 'adminStatsPeriodSchema#' },
    users: { $ref: 'adminStatsUsersSchema#' },
    orders: { $ref: 'adminStatsOrdersSchema#' },
    products: { $ref: 'adminStatsProductsSchema#' },
    reviews: { $ref: 'adminStatsReviewsSchema#' },
    createdAt: dateTimeSchema,
  },
  required: ['period', 'users', 'orders', 'products', 'reviews', 'createdAt'],
} as const;

export const adminDtoSchemas = [
  adminStatsQuerySchema,
  adminStatsPeriodSchema,
  adminStatsUsersSchema,
  adminStatsOrdersByStatusSchema,
  adminStatsOrdersRevenueSchema,
  adminStatsOrdersSchema,
  adminTopProductRevenueSchema,
  adminTopCategoryRevenueSchema,
  adminStatsProductsSchema,
  adminStatsReviewsSchema,
  adminStatsResponseSchema,
];