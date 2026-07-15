import type { FastifySchema } from 'fastify';

import { openApiSecurity } from '@config/openapi.js';
import { withOpenApiSecurity } from '@helpers/withOpenApiSecurity.js';
import { withOpenApiTag } from '@helpers/withOpenApiTag.js';

const adminStatsQueryExample = {
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-31T23:59:59.999Z',
};

const adminStatsResponseExample = {
  period: {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-31T23:59:59.999Z',
  },
  users: {
    total: 120,
    newInPeriod: 18,
    new7d: 5,
    new30d: 18,
    verifiedTotal: 96,
    verifiedRate: 80,
  },
  orders: {
    total: 75,
    confirmedTotal: 52,
    pendingCartsTotal: 23,
    byStatus: {
      pending: 12,
      unconfirmed: 11,
      waiting: 5,
      paid: 14,
      shipped: 9,
      delivered: 24,
      cancelled: 0,
    },
    revenue: {
      total: 12450.75,
      inPeriod: 3200.5,
      last7d: 820.25,
      last30d: 3200.5,
    },
    averageOrderValue: 239.44,
    itemsSold: 148,
  },
  products: {
    total: 260,
    activeTotal: 238,
    deletedTotal: 22,
    outOfStockTotal: 14,
    topProductsByRevenue: [
      {
        id: 10,
        name: 'Wireless headphones',
        revenue: 1499.7,
        quantitySold: 30,
      },
    ],
    topCategoriesByRevenue: [
      {
        id: 1,
        name: 'Electronics',
        revenue: 4200.5,
        quantitySold: 84,
      },
    ],
  },
  reviews: {
    total: 90,
    ratedTotal: 82,
    newInPeriod: 16,
    avgRating: 4.4,
    negativeCount: 3,
  },
  createdAt: '2026-01-31T23:59:59.999Z',
};

// Schema for admin dashboard statistics
const getStatsSchema = {
  operationId: 'getAdminStats',
  summary: 'Get admin stats',
  description: 'Returns aggregated dashboard statistics for users, orders, products and reviews.',

  querystring: {
    $ref: 'adminStatsQuerySchema#',
    examples: [adminStatsQueryExample],
  },

  response: {
    200: {
      description: 'Admin statistics were returned successfully.',
      $ref: 'adminStatsResponseSchema#',
      examples: [adminStatsResponseExample],
    },

    400: {
      description: 'Invalid admin stats query parameters.',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read admin statistics.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The authenticated user is not allowed to read admin statistics.',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while loading admin statistics.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Group admin routes under the admin Swagger tag
const taggedAdminSchema = withOpenApiTag(
  {
    getStatsSchema,
  },
  'admin',
);

// Add access token security to all admin routes
export const adminSchema = withOpenApiSecurity(
  taggedAdminSchema,
  openApiSecurity.accessTokenCookie,
);
