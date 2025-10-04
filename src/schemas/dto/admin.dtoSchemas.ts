export const adminStatsQuerySchema = {
  $id: 'adminStatsQuery',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    range: { type: 'string', enum: ['7d', '30d'] },
  },
};

export const adminStatsUsersSchema = {
  $id: 'adminStatsUsers',
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'number' },
    new7d: { type: 'number' },
    new30d: { type: 'number' },
    verifiedRate: { type: 'number' },
  },
  required: ['total', 'new7d', 'new30d', 'verifiedRate'],
};

export const adminStatsOrdersByStatusSchema = {
  $id: 'adminStatsOrdersByStatus',
  type: 'object',
  additionalProperties: false,
  properties: {
    pending: { type: 'number' },
    paid: { type: 'number' },
    shipped: { type: 'number' },
    delivered: { type: 'number' },
    cancelled: { type: 'number' },
  },
  required: ['pending', 'paid', 'shipped', 'delivered', 'cancelled'],
};

export const adminStatsOrdersRevenueSchema = {
  $id: 'adminStatsOrdersRevenue',
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'number' },
    last7d: { type: 'number' },
    last30d: { type: 'number' },
  },
  required: ['total', 'last7d', 'last30d'],
};

export const adminStatsOrdersSchema = {
  $id: 'adminStatsOrders',
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'number' },
    byStatus: { $ref: 'adminStatsOrdersByStatus#' },
    revenue: { $ref: 'adminStatsOrdersRevenue#' },
    averageOrderValue: { type: 'number' },
  },
  required: ['total', 'byStatus', 'revenue', 'averageOrderValue'],
};

export const adminTopProductRevenueSchema = {
  $id: 'adminTopProductRevenue',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    name: { type: 'string' },
    revenue: { type: 'number' },
  },
  required: ['id', 'name', 'revenue'],
};

export const adminTopCategoryRevenueSchema = {
  $id: 'adminTopCategoryRevenue',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    name: { type: 'string' },
    revenue: { type: 'number' },
  },
  required: ['id', 'name', 'revenue'],
};

export const adminStatsProductsSchema = {
  $id: 'adminStatsProducts',
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'number' },
    topProductsByRevenue: { type: 'array', items: { $ref: 'adminTopProductRevenue#' } },
    topCategoriesByRevenue: { type: 'array', items: { $ref: 'adminTopCategoryRevenue#' } },
  },
  required: ['total', 'topProductsByRevenue', 'topCategoriesByRevenue'],
};

export const adminStatsReviewsSchema = {
  $id: 'adminStatsReviews',
  type: 'object',
  additionalProperties: false,
  properties: {
    total: { type: 'number' },
    avgRating: { type: 'number' },
    negativeCount: { type: 'number' },
  },
  required: ['total', 'avgRating', 'negativeCount'],
};

export const adminStatsResponseSchema = {
  $id: 'adminStatsResponse',
  type: 'object',
  additionalProperties: false,
  properties: {
    users: { $ref: 'adminStatsUsers#' },
    orders: { $ref: 'adminStatsOrders#' },
    products: { $ref: 'adminStatsProducts#' },
    reviews: { $ref: 'adminStatsReviews#' },
    createdAt: { type: 'string', format: 'date-time' },
  },
  required: ['users', 'orders', 'products', 'reviews', 'createdAt'],
};

export const adminSetPopularityParamsSchema = {
  $id: 'adminSetPopularityParams',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { type: 'number' },
  },
  required: ['productId'],
};

export const adminSetPopularityBodySchema = {
  $id: 'adminSetPopularityBody',
  type: 'object',
  additionalProperties: false,
  properties: {
    popularity: { type: 'number', minimum: 0 },
  },
  required: ['popularity'],
};

export const adminSetPopularityResponseSchema = {
  $id: 'adminSetPopularityResponse',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'number' },
    popularity: { type: 'number' },
  },
  required: ['id', 'popularity'],
};

export const adminChatsQuerySchema = {
  $id: 'adminChatsQuery',
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['open', 'closed'] },
    type: { type: 'string', enum: ['bot', 'admin'] },
    page: { type: 'number', minimum: 1 },
    limit: { type: 'number', minimum: 1 },
  },
};

export const adminChatItemSchema = {
  $id: 'adminChatItem',
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    userId: { type: 'number' },
    type: { type: 'string', enum: ['bot', 'admin'] },
    status: { type: 'string', enum: ['open', 'closed'] },
    lastMessageAt: { type: 'string', format: 'date-time' },
    unreadCount: { type: 'number' },
    lastMessagePreview: { type: 'string' },
  },
  required: ['id', 'userId', 'type', 'status', 'lastMessageAt'],
};

export const adminChatsResponseSchema = {
  $id: 'adminChatsResponse',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'adminChatItem#' } },
    page: { type: 'number' },
    limit: { type: 'number' },
    total: { type: 'number' },
  },
  required: ['items'],
};

export const adminDtoSchemas = [
  adminStatsQuerySchema,
  adminStatsUsersSchema,
  adminStatsOrdersByStatusSchema,
  adminStatsOrdersRevenueSchema,
  adminStatsOrdersSchema,
  adminTopProductRevenueSchema,
  adminTopCategoryRevenueSchema,
  adminStatsProductsSchema,
  adminStatsReviewsSchema,
  adminStatsResponseSchema,
  adminSetPopularityParamsSchema,
  adminSetPopularityBodySchema,
  adminSetPopularityResponseSchema,
  adminChatsQuerySchema,
  adminChatItemSchema,
  adminChatsResponseSchema,
];
