import { MAX_ID } from '@schemas/idPathParam.js';

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
  description:
    'The accounts of buyers, the deleted ones too; the accounts of admins and root are not counted.',
  properties: {
    total: nonNegativeIntegerSchema,
    newInPeriod: { ...nonNegativeIntegerSchema, description: 'Signed up in the period.' },
    new7d: { ...nonNegativeIntegerSchema, description: 'Signed up in the last 7 days.' },
    new30d: { ...nonNegativeIntegerSchema, description: 'Signed up in the last 30 days.' },
    verifiedTotal: nonNegativeIntegerSchema,
    verifiedRate: { ...percentSchema, description: 'The verified part of total, in percent.' },
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
  description:
    'The totals of the orders paid and not cancelled (paid, shipped, delivered), by the time of ' +
    'the payment.',
  properties: {
    total: { ...nonNegativeNumberSchema, description: 'Of all time.' },
    inPeriod: { ...nonNegativeNumberSchema, description: 'Paid in the period.' },
    last7d: { ...nonNegativeNumberSchema, description: 'Paid in the last 7 days.' },
    last30d: { ...nonNegativeNumberSchema, description: 'Paid in the last 30 days.' },
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

    averageOrderValue: {
      ...nonNegativeNumberSchema,
      description: 'The average total of the orders paid in the period and not cancelled.',
    },
    itemsSold: {
      ...nonNegativeIntegerSchema,
      description: 'The units of the orders paid in the period and not cancelled.',
    },
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
      description: 'The 5 products of the most money paid in the period.',
      items: { $ref: 'adminTopProductRevenueSchema#' },
    },

    topCategoriesByRevenue: {
      type: 'array',
      description: 'The 5 categories (their own products) of the most money paid in the period.',
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
    newInPeriod: { ...nonNegativeIntegerSchema, description: 'Written in the period.' },
    avgRating: {
      ...ratingAverageSchema,
      description: 'The average rating of the reviews written in the period, 0 without one.',
    },

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

// GET /api/admin/reports/accounting
const adminAccountingQuerySchema = {
  $id: 'adminAccountingQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: {
      ...dateTimeSchema,
      description: 'The start of the period, taken in; the start of all time without it.',
    },
    to: { ...dateTimeSchema, description: 'The end of the period, left out; now without it.' },
    productIds: {
      type: 'string',
      pattern: '^[1-9][0-9]*(,[1-9][0-9]*)*$',
      description:
        'Only these products, ids through commas, up to 100 (PRODUCT_IDS_INVALID); every ' +
        'product without it.',
    },
    categoryId: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_ID,
      description: 'Only the products of this category (CATEGORY_NOT_FOUND when there is none).',
    },
    branch: {
      type: 'boolean',
      description:
        'With categoryId: true (the default) takes the whole branch of the category, false its ' +
        'own products only.',
    },
  },
} as const;

const adminUnitsValueSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    units: nonNegativeIntegerSchema,
    value: { type: 'number', description: 'At the cost of the batches, to the cent.' },
  },
  required: ['units', 'value'],
} as const;

const adminAccountingSalesSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    orders: nonNegativeIntegerSchema,
    units: nonNegativeIntegerSchema,
    revenue: { type: 'number', description: 'What the items were paid at.' },
    cost: { type: 'number', description: 'What the batches they took cost.' },
    margin: { type: 'number' },
  },
  required: ['orders', 'units', 'revenue', 'cost', 'margin'],
} as const;

const adminAccountingResponseSchema = {
  $id: 'adminAccountingResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    period: { $ref: 'adminStatsPeriodSchema#' },
    currency: { type: 'string', description: 'The money of the shop: prices and costs.' },
    sales: {
      ...adminAccountingSalesSchema,
      description:
        'The orders paid in the period (by paidAt), the ones cancelled later among them.',
    },
    cancellations: {
      type: 'object',
      additionalProperties: false,
      description:
        'The paid orders cancelled in the period (by cancelledAt): their money went back.',
      properties: {
        orders: nonNegativeIntegerSchema,
        units: nonNegativeIntegerSchema,
        revenue: { type: 'number' },
        cost: { type: 'number' },
      },
      required: ['orders', 'units', 'revenue', 'cost'],
    },
    net: {
      type: 'object',
      additionalProperties: false,
      description: 'The sales less the cancellations.',
      properties: {
        revenue: { type: 'number' },
        cost: { type: 'number' },
        margin: { type: 'number' },
      },
      required: ['revenue', 'cost', 'margin'],
    },
    purchases: {
      type: 'object',
      additionalProperties: false,
      description: 'The batches taken in during the period, by where they came from.',
      properties: {
        units: nonNegativeIntegerSchema,
        value: { type: 'number' },
        bySource: {
          type: 'object',
          additionalProperties: false,
          properties: {
            supplier: adminUnitsValueSchema,
            surplus: adminUnitsValueSchema,
            customer_return: adminUnitsValueSchema,
          },
          required: ['supplier', 'surplus', 'customer_return'],
        },
      },
      required: ['units', 'value', 'bySource'],
    },
    writeOffs: {
      type: 'object',
      additionalProperties: false,
      description: 'The units written off in the period, by reason.',
      properties: {
        units: nonNegativeIntegerSchema,
        value: { type: 'number' },
        byReason: {
          type: 'object',
          additionalProperties: false,
          properties: {
            damaged: adminUnitsValueSchema,
            defective: adminUnitsValueSchema,
            expired: adminUnitsValueSchema,
            shortage: adminUnitsValueSchema,
            returned_to_supplier: adminUnitsValueSchema,
            other: adminUnitsValueSchema,
          },
          required: [
            'damaged',
            'defective',
            'expired',
            'shortage',
            'returned_to_supplier',
            'other',
          ],
        },
      },
      required: ['units', 'value', 'byReason'],
    },
    stock: {
      ...adminUnitsValueSchema,
      description: 'What the batches have left now, whatever the period.',
    },
  },
  required: [
    'period',
    'currency',
    'sales',
    'cancellations',
    'net',
    'purchases',
    'writeOffs',
    'stock',
  ],
} as const;

const reportScopeQueryFields = {
  categoryId: {
    type: 'integer',
    minimum: 1,
    maximum: MAX_ID,
    description: 'Only the products of this category (CATEGORY_NOT_FOUND when there is none).',
  },
  branch: {
    type: 'boolean',
    description:
      'With categoryId, or for each category: true (the default) takes the whole branch of the ' +
      'category, false its own products only.',
  },
  format: {
    type: 'string',
    enum: ['json', 'csv'],
    description: 'csv gives a file for the accountant, every row and no pages.',
  },
} as const;

const reportSortOrderField = { type: 'string', enum: ['asc', 'desc'] } as const;

const reportSortByField = {
  type: 'string',
  enum: [
    'revenue',
    'margin',
    'marginPercent',
    'units',
    'writeOffs',
    'purchases',
    'stockValue',
    'stockUnits',
    'name',
  ],
  description:
    'revenue (the default), margin, marginPercent and units are of the sales less the cancels; ' +
    'writeOffs and purchases are their value; rows without a margin percent come last.',
} as const;

const adminReportProductsQuerySchema = {
  $id: 'adminReportProductsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: adminAccountingQuerySchema.properties.from,
    to: adminAccountingQuerySchema.properties.to,
    ...reportScopeQueryFields,
    sortBy: reportSortByField,
    sortOrder: { ...reportSortOrderField, description: 'desc by default.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: '20 by default.' },
    cursor: {
      type: 'string',
      minLength: 1,
      pattern: '^[A-Za-z0-9_-]+$',
      description: 'nextCursor of the page before, with the same sort (CURSOR_INVALID).',
    },
  },
} as const;

const adminReportCategoriesQuerySchema = {
  $id: 'adminReportCategoriesQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: adminAccountingQuerySchema.properties.from,
    to: adminAccountingQuerySchema.properties.to,
    ...reportScopeQueryFields,
    sortBy: reportSortByField,
    sortOrder: { ...reportSortOrderField, description: 'desc by default.' },
  },
} as const;

const adminReportTimelineQuerySchema = {
  $id: 'adminReportTimelineQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: {
      ...dateTimeSchema,
      description:
        'The start of the period, taken in; without it the step of the end and the eleven ' +
        'before it.',
    },
    to: adminAccountingQuerySchema.properties.to,
    productIds: adminAccountingQuerySchema.properties.productIds,
    ...reportScopeQueryFields,
    step: {
      type: 'string',
      enum: ['day', 'week', 'month'],
      description:
        'month by default; days, weeks from monday and months of the calendar of the shop ' +
        '(its time zone), up to 400 steps (REPORT_PERIOD_TOO_LONG).',
    },
    sortBy: {
      type: 'string',
      enum: ['period', 'revenue', 'margin', 'units', 'writeOffs', 'purchases'],
      description: 'period by default, the order of time.',
    },
    sortOrder: { ...reportSortOrderField, description: 'asc by default.' },
  },
} as const;

const moneyNumber = { type: 'number' } as const;

const reportSalesSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'The items of the orders paid in the period, at their prices and their costs.',
  properties: {
    units: { type: 'integer' },
    revenue: moneyNumber,
    cost: moneyNumber,
    margin: moneyNumber,
  },
  required: ['units', 'revenue', 'cost', 'margin'],
} as const;

const reportCancellationsSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'The items of the paid orders cancelled in the period.',
  properties: { units: { type: 'integer' }, revenue: moneyNumber, cost: moneyNumber },
  required: ['units', 'revenue', 'cost'],
} as const;

const reportNetSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'The sales less the cancellations; the percent of the margin is of the revenue.',
  properties: {
    units: { type: 'integer' },
    revenue: moneyNumber,
    cost: moneyNumber,
    margin: moneyNumber,
    marginPercent: { type: ['number', 'null'], description: 'None without a revenue.' },
  },
  required: ['units', 'revenue', 'cost', 'margin', 'marginPercent'],
} as const;

const reportMoneyProperties = {
  sales: reportSalesSchema,
  cancellations: reportCancellationsSchema,
  net: reportNetSchema,
  writeOffs: { ...adminUnitsValueSchema, description: 'Written off in the period, at cost.' },
  purchases: { ...adminUnitsValueSchema, description: 'Taken in during the period, at cost.' },
} as const;

const reportMoneyRequired = ['sales', 'cancellations', 'net', 'writeOffs', 'purchases'] as const;

const reportStockField = {
  ...adminUnitsValueSchema,
  description: 'What the batches have left now, at their costs, whatever the period.',
} as const;

const adminReportProductsResponseSchema = {
  $id: 'adminReportProductsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    period: { $ref: 'adminStatsPeriodSchema#' },
    currency: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          deleted: { type: 'boolean', description: 'Removed from the catalog.' },
          category: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'integer' }, name: { type: 'string' } },
            required: ['id', 'name'],
          },
          ...reportMoneyProperties,
          stock: reportStockField,
        },
        required: ['id', 'name', 'deleted', 'category', ...reportMoneyRequired, 'stock'],
      },
    },
    totals: {
      type: 'object',
      additionalProperties: false,
      description: 'Of every product of the filter, not only of the page.',
      properties: { ...reportMoneyProperties, stock: reportStockField },
      required: [...reportMoneyRequired, 'stock'],
    },
    limit: { type: 'integer' },
    nextCursor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
  required: ['period', 'currency', 'items', 'totals', 'limit', 'nextCursor'],
} as const;

const adminReportCategoriesResponseSchema = {
  $id: 'adminReportCategoriesResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    period: { $ref: 'adminStatsPeriodSchema#' },
    currency: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          parentId: { type: ['integer', 'null'] },
          ...reportMoneyProperties,
          stock: reportStockField,
        },
        required: ['id', 'name', 'parentId', ...reportMoneyRequired, 'stock'],
      },
    },
  },
  required: ['period', 'currency', 'items'],
} as const;

const adminReportTimelineResponseSchema = {
  $id: 'adminReportTimelineResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    period: { $ref: 'adminStatsPeriodSchema#' },
    currency: { type: 'string' },
    step: { type: 'string', enum: ['day', 'week', 'month'] },
    timeZone: { type: 'string', description: 'The time zone of the calendar of the shop.' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: {
            type: 'string',
            description: 'The day or the monday of the week (yyyy-mm-dd), or the month (yyyy-mm).',
          },
          period: { $ref: 'adminStatsPeriodSchema#' },
          ...reportMoneyProperties,
        },
        required: ['label', 'period', ...reportMoneyRequired],
      },
    },
  },
  required: ['period', 'currency', 'step', 'timeZone', 'items'],
} as const;

// GET /api/admin/stock/batches and /movements: the batches of the stock and its journal
const stockSourceValues = ['supplier', 'surplus', 'customer_return'] as const;
const writeOffReasonValues = [
  'damaged',
  'defective',
  'expired',
  'shortage',
  'returned_to_supplier',
  'other',
] as const;
export const STOCK_MOVEMENT_KINDS = ['delivery', 'writeOff', 'sale', 'cancel'] as const;
export const STOCK_LIST_DEFAULT_LIMIT = 20;

const stockIdQueryField = (what: string) =>
  ({
    type: 'integer',
    minimum: 1,
    maximum: MAX_ID,
    description: `Only the ${what}.`,
  }) as const;

const stockPageQueryFields = {
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 100,
    description: `Rows on a page, ${STOCK_LIST_DEFAULT_LIMIT} unless given.`,
  },
  cursor: {
    type: 'string',
    minLength: 1,
    pattern: '^[A-Za-z0-9_-]+$',
    description:
      'nextCursor of the page before. It holds the order it was given for: with another order ' +
      'it is CURSOR_INVALID.',
  },
} as const;

const stockProductSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: positiveIntegerSchema,
    name: { type: 'string' },
    deleted: { type: 'boolean', description: 'The product is removed from the catalog.' },
  },
  required: ['id', 'name', 'deleted'],
} as const;

const stockActorSchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    id: positiveIntegerSchema,
    role: { type: 'string', enum: ['ADMIN', 'ROOT'] },
  },
  required: ['id', 'role'],
} as const;

const nullableText = { type: ['string', 'null'] } as const;

const adminStockBatchesQuerySchema = {
  $id: 'adminStockBatchesQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: stockIdQueryField('batches of this product'),
    deliveryId: {
      type: 'string',
      format: 'uuid',
      description: 'Only the batches of this delivery.',
    },
    source: {
      type: 'string',
      enum: stockSourceValues,
      description: 'Only the batches of this source.',
    },
    inStock: {
      type: 'boolean',
      description: 'true: only the batches with units left, false: only the empty ones.',
    },
    expired: {
      type: 'boolean',
      description:
        'true: only the batches whose last good day is behind the day of the shop ' +
        '(SHOP_TIME_ZONE), their units are not sold; false: only the others, the batches ' +
        'without an end too.',
    },
    expiresBy: {
      type: 'string',
      format: 'date',
      description: 'Only the batches whose last good day is on this day (yyyy-mm-dd) or before.',
    },
    sortBy: {
      type: 'string',
      enum: ['createdAt', 'expiresAt', 'remaining', 'unitCost', 'value'],
      description:
        'createdAt (the default): when the batch came in; expiresAt: its last good day, the ' +
        'batches without one last in either order; value: what is left at its cost. Equal ' +
        'values go by id in the same direction.',
    },
    sortOrder: { ...reportSortOrderField, description: 'desc unless given.' },
    ...stockPageQueryFields,
  },
} as const;

const adminStockBatchesResponseSchema = {
  $id: 'adminStockBatchesResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    currency: { type: 'string', description: 'The money of the shop: the costs.' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: positiveIntegerSchema,
          deliveryId: { type: 'string', format: 'uuid' },
          source: { type: 'string', enum: stockSourceValues },
          supplierBatchNumber: nullableText,
          product: stockProductSchema,
          unitCost: nonNegativeNumberSchema,
          quantity: positiveIntegerSchema,
          remaining: nonNegativeIntegerSchema,
          sold: {
            ...nonNegativeIntegerSchema,
            description: 'The units of the paid orders; a cancel puts its units back.',
          },
          writtenOff: nonNegativeIntegerSchema,
          value: { ...nonNegativeNumberSchema, description: 'What is left at its cost.' },
          expiresAt: { type: ['string', 'null'], format: 'date' },
          expired: {
            type: 'boolean',
            description:
              'The last good day is behind the day of the shop: the units are not sold, they ' +
              'wait for a write-off.',
          },
          supplier: nullableText,
          document: nullableText,
          note: nullableText,
          receivedBy: { ...stockActorSchema, description: 'The admin who took the batch in.' },
          createdAt: dateTimeSchema,
        },
        required: [
          'id',
          'deliveryId',
          'source',
          'supplierBatchNumber',
          'product',
          'unitCost',
          'quantity',
          'remaining',
          'sold',
          'writtenOff',
          'value',
          'expiresAt',
          'expired',
          'supplier',
          'document',
          'note',
          'receivedBy',
          'createdAt',
        ],
      },
    },
    limit: positiveIntegerSchema,
    nextCursor: { type: ['string', 'null'] },
    total: { ...nonNegativeIntegerSchema, description: 'The batches of the filters.' },
  },
  required: ['currency', 'items', 'limit', 'nextCursor', 'total'],
} as const;

const stockMovementKindPattern = `(${STOCK_MOVEMENT_KINDS.join('|')})`;

const adminStockMovementsQuerySchema = {
  $id: 'adminStockMovementsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: stockIdQueryField('steps of this product'),
    batchId: stockIdQueryField('steps that took units in or out of this batch'),
    orderId: stockIdQueryField('sale and the cancel of this order'),
    deliveryId: {
      type: 'string',
      format: 'uuid',
      description: 'Only the lines of this delivery.',
    },
    writeOffId: {
      type: 'string',
      format: 'uuid',
      description: 'Only the lines of this write-off.',
    },
    kind: {
      type: 'string',
      pattern: `^${stockMovementKindPattern}(,${stockMovementKindPattern})*$`,
      description:
        'Kinds, one or several through commas: delivery, writeOff, sale (the units a paid ' +
        'order took), cancel (the units the cancel of a paid order put back). All unless given.',
    },
    from: { ...dateTimeSchema, description: 'The start of the period, taken in.' },
    to: { ...dateTimeSchema, description: 'The end of the period, left out.' },
    sortOrder: {
      ...reportSortOrderField,
      description: 'By the time of the step, desc (the newest first) unless given.',
    },
    ...stockPageQueryFields,
  },
} as const;

const adminStockMovementsResponseSchema = {
  $id: 'adminStockMovementsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    currency: { type: 'string', description: 'The money of the shop: the costs.' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: STOCK_MOVEMENT_KINDS },
          at: {
            ...dateTimeSchema,
            description: 'A sale is at the payment, a cancel at the cancel.',
          },
          product: stockProductSchema,
          quantity: {
            type: 'integer',
            description: 'The change of the stock: units in above 0, units out below.',
          },
          value: { type: 'number', description: 'The same at the cost of the batches.' },
          batches: {
            type: 'array',
            description: 'The batches, in the order the units were taken.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                batchId: positiveIntegerSchema,
                quantity: positiveIntegerSchema,
                unitCost: nonNegativeNumberSchema,
              },
              required: ['batchId', 'quantity', 'unitCost'],
            },
          },
          orderId: { type: ['integer', 'null'], description: 'Of a sale and a cancel.' },
          deliveryId: { type: ['string', 'null'], format: 'uuid' },
          writeOffId: { type: ['string', 'null'], format: 'uuid' },
          source: { type: ['string', 'null'], enum: [...stockSourceValues, null] },
          reason: { type: ['string', 'null'], enum: [...writeOffReasonValues, null] },
          supplier: nullableText,
          document: nullableText,
          note: nullableText,
          actor: {
            ...stockActorSchema,
            description: 'The admin of a delivery or a write-off.',
          },
        },
        required: [
          'kind',
          'at',
          'product',
          'quantity',
          'value',
          'batches',
          'orderId',
          'deliveryId',
          'writeOffId',
          'source',
          'reason',
          'supplier',
          'document',
          'note',
          'actor',
        ],
      },
    },
    limit: positiveIntegerSchema,
    nextCursor: { type: ['string', 'null'] },
    total: { ...nonNegativeIntegerSchema, description: 'The steps of the filters.' },
  },
  required: ['currency', 'items', 'limit', 'nextCursor', 'total'],
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
  adminAccountingQuerySchema,
  adminAccountingResponseSchema,
  adminReportProductsQuerySchema,
  adminReportCategoriesQuerySchema,
  adminReportTimelineQuerySchema,
  adminReportProductsResponseSchema,
  adminReportCategoriesResponseSchema,
  adminReportTimelineResponseSchema,
  adminStockBatchesQuerySchema,
  adminStockBatchesResponseSchema,
  adminStockMovementsQuerySchema,
  adminStockMovementsResponseSchema,
];
