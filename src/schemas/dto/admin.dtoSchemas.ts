import {
  AUDIT_EVENTS,
  CONSENT_EVENTS,
  LOGIN_EVENTS,
  PRICE_LOG_EVENTS,
} from '@config/journalEvents.js';
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
    'the payment. In orders.revenue the delivery is part of the totals, orders.deliveryRevenue ' +
    'is the delivery alone.',
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
    deliveryRevenue: { $ref: 'adminStatsOrdersRevenueSchema#' },

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
    'deliveryRevenue',
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

// the money of a period in three parts, the same in the statistics and in the reports of the
// accounting; the delivery and the sends belong to no product, a report of some products or of a
// category has none of them and its totals are of the items
const nullableMoney = { type: ['number', 'null'] } as const;

const moneySummarySchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'The money of the period: what came in, what went out, what each income left. The orders ' +
    'are the ones paid in the period and not cancelled; a cancel later takes the order out of ' +
    'the period it was paid in.',
  properties: {
    income: {
      type: 'object',
      additionalProperties: false,
      description: 'The items of the orders, their delivery, together.',
      properties: { items: { type: 'number' }, delivery: nullableMoney, total: { type: 'number' } },
      required: ['items', 'delivery', 'total'],
    },
    expenses: {
      type: 'object',
      additionalProperties: false,
      description:
        'What the items sold cost (the batches they took), the units written off in the period, ' +
        'the sends the shop owes the carriers for (by the time they were sent), together.',
      properties: {
        costOfGoods: { type: 'number' },
        writeOffs: { type: 'number' },
        shipping: nullableMoney,
        total: { type: 'number' },
      },
      required: ['costOfGoods', 'writeOffs', 'shipping', 'total'],
    },
    margin: {
      type: 'object',
      additionalProperties: false,
      description:
        'The items less their cost, the delivery less the sends, all the income less all the ' +
        'expenses (the write-offs too).',
      properties: { items: { type: 'number' }, delivery: nullableMoney, total: { type: 'number' } },
      required: ['items', 'delivery', 'total'],
    },
  },
  required: ['income', 'expenses', 'margin'],
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
    money: {
      ...moneySummarySchema,
      description:
        'The money of the whole shop in the period, the same as summary of GET ' +
        '/api/admin/reports/accounting for it.',
    },
    createdAt: dateTimeSchema,
  },
  required: ['period', 'users', 'orders', 'products', 'reviews', 'money', 'createdAt'],
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

// the delivery of the orders of a period, of no product: only a report of the whole shop has it
const adminDeliveryMoneySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  description:
    'The delivery of all orders in the period, apart from the products. Null when the report ' +
    'is of some products or of a category: the delivery belongs to no product.',
  properties: {
    income: {
      type: 'object',
      additionalProperties: false,
      description:
        'What the orders paid in the period (by paidAt) and not cancelled paid for the delivery; ' +
        'orders counts the ones that paid for it (a delivery that cost nothing is none).',
      properties: { orders: nonNegativeIntegerSchema, revenue: { type: 'number' } },
      required: ['orders', 'revenue'],
    },
    refunded: {
      type: 'object',
      additionalProperties: false,
      description:
        'Told apart: the delivery of the paid orders cancelled in the period (by cancelledAt). ' +
        'It went back with the payment, and the income of the period they were paid in has it ' +
        'no more.',
      properties: { orders: nonNegativeIntegerSchema, revenue: { type: 'number' } },
      required: ['orders', 'revenue'],
    },
    shipping: {
      type: 'object',
      additionalProperties: false,
      description:
        'The sends the shop owes the carriers for, by the time they were sent (shippedAt): a ' +
        'send taken back with its cost kept counts, one the carrier was not paid for does not. ' +
        'withoutCost counts the sends of them whose cost is not written yet.',
      properties: {
        sends: nonNegativeIntegerSchema,
        cost: { type: 'number', description: 'The costs written, to the cent.' },
        withoutCost: nonNegativeIntegerSchema,
      },
      required: ['sends', 'cost', 'withoutCost'],
    },
    result: {
      type: 'number',
      description: 'The income less what the carriers cost: what the delivery earned.',
    },
  },
  required: ['income', 'refunded', 'shipping', 'result'],
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
        'The orders paid in the period (by paidAt) and not cancelled: an order cancelled later is ' +
        'taken out of the period it was paid in.',
    },
    cancellations: {
      type: 'object',
      additionalProperties: false,
      description:
        'Told apart and in no margin: the paid orders cancelled in the period (by cancelledAt), ' +
        'their money went back.',
      properties: {
        orders: nonNegativeIntegerSchema,
        units: nonNegativeIntegerSchema,
        revenue: { type: 'number' },
        cost: { type: 'number' },
      },
      required: ['orders', 'units', 'revenue', 'cost'],
    },
    summary: moneySummarySchema,
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
    delivery: adminDeliveryMoneySchema,
  },
  required: [
    'period',
    'currency',
    'sales',
    'cancellations',
    'summary',
    'purchases',
    'writeOffs',
    'stock',
    'delivery',
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
    'marginAfterWriteOffs',
    'writeOffs',
    'purchases',
    'stockValue',
    'stockUnits',
    'name',
  ],
  description:
    'revenue (the default), margin, marginPercent and units are of the sales (paid and not ' +
    'cancelled); marginAfterWriteOffs is the margin less the write-offs; writeOffs and ' +
    'purchases are their value; rows without a margin percent come last.',
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
      enum: [
        'period',
        'revenue',
        'margin',
        'units',
        'marginAfterWriteOffs',
        'marginTotal',
        'writeOffs',
        'purchases',
      ],
      description:
        'period by default, the order of time; marginTotal is the total margin of the step ' +
        '(summary.margin.total).',
    },
    sortOrder: { ...reportSortOrderField, description: 'asc by default.' },
  },
} as const;

const moneyNumber = { type: 'number' } as const;

const reportSalesSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'The items of the orders paid in the period and not cancelled, at their prices and their ' +
    'costs; the percent of the margin is of the revenue.',
  properties: {
    units: { type: 'integer' },
    revenue: moneyNumber,
    cost: moneyNumber,
    margin: moneyNumber,
    marginPercent: { type: ['number', 'null'], description: 'None without a revenue.' },
  },
  required: ['units', 'revenue', 'cost', 'margin', 'marginPercent'],
} as const;

const reportCancellationsSchema = {
  type: 'object',
  additionalProperties: false,
  description: 'Told apart and in no margin: the items of the paid orders cancelled in the period.',
  properties: { units: { type: 'integer' }, revenue: moneyNumber, cost: moneyNumber },
  required: ['units', 'revenue', 'cost'],
} as const;

const reportAfterWriteOffsSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'The margin of the sales less the write-offs of the period; the percent is of the revenue ' +
    'of the sales.',
  properties: {
    margin: moneyNumber,
    marginPercent: { type: ['number', 'null'], description: 'None without a revenue.' },
  },
  required: ['margin', 'marginPercent'],
} as const;

const reportMoneyProperties = {
  sales: reportSalesSchema,
  cancellations: reportCancellationsSchema,
  writeOffs: { ...adminUnitsValueSchema, description: 'Written off in the period, at cost.' },
  afterWriteOffs: reportAfterWriteOffsSchema,
  purchases: { ...adminUnitsValueSchema, description: 'Taken in during the period, at cost.' },
} as const;

const reportMoneyRequired = [
  'sales',
  'cancellations',
  'writeOffs',
  'afterWriteOffs',
  'purchases',
] as const;

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
          delivery: adminDeliveryMoneySchema,
          summary: moneySummarySchema,
        },
        required: ['label', 'period', ...reportMoneyRequired, 'delivery', 'summary'],
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

// the query every journal takes: a sort by one of its simple columns, a period, some events, some
// columns, and the page; the filters of a journal come on top
const journalQueryFields = (
  sorts: readonly string[],
  columns: readonly string[],
  events: readonly string[],
) =>
  ({
    sortBy: {
      type: 'string',
      enum: [...sorts],
      description:
        'The column the lines are sorted by, createdAt unless given. Lines without a value in ' +
        'the column come last whichever way it goes, the id breaks ties.',
    },
    sortOrder: {
      type: 'string',
      enum: ['asc', 'desc'],
      description: 'desc (the newest or the largest first) unless given.',
    },
    from: { ...dateTimeSchema, description: 'The start of the period, taken in.' },
    to: { ...dateTimeSchema, description: 'The end of the period, left out.' },
    events: {
      type: 'string',
      pattern: '^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*(,[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*)*$',
      description:
        'Only the lines of these events, one or several through commas (LOG_EVENTS_INVALID for ' +
        `one the journal has not): ${events.join(', ')}. The whole journal unless given.`,
    },
    columns: {
      type: 'string',
      pattern: '^[A-Za-z]+(,[A-Za-z]+)*$',
      description:
        'The columns of the answer and of the csv, one or several through commas ' +
        `(LOG_COLUMNS_INVALID for one the journal has not): ${columns.join(', ')}. All unless given.`,
    },
    format: {
      type: 'string',
      enum: ['json', 'csv'],
      description: 'csv gives every line of the filters as a file, without pages.',
    },
    ...stockPageQueryFields,
  }) as const;

// the account of a line; for an admin the data of root are hidden, the role stays
const logAccountProperties = {
  id: { type: ['integer', 'null'] },
  name: { type: ['string', 'null'] },
  email: { type: ['string', 'null'] },
  role: { type: 'string', enum: ['USER', 'ADMIN', 'ROOT'] },
} as const;

const logAccountSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'The account; a deleted one keeps its lines, not its email. For an admin the account of root ' +
    'has the id 0, its name and email are the word hidden; its role is there.',
  properties: logAccountProperties,
  required: ['id', 'name', 'email', 'role'],
} as const;

const logUserSchema = {
  ...logAccountSchema,
  properties: { ...logAccountProperties, deleted: { type: 'boolean' } },
  required: ['id', 'name', 'email', 'role', 'deleted'],
} as const;

const logIpSchema = {
  type: ['string', 'null'],
  description:
    'The address of the request, none for the work of the server alone; the word hidden for an ' +
    'admin where it is root.',
} as const;

const logUserAgentSchema = {
  type: ['string', 'null'],
  description: 'The browser of the request; the word hidden for an admin where it is root.',
} as const;

const logEventSchema = (events: readonly string[], what: string) =>
  ({ type: 'string', enum: [...events], description: what }) as const;

// a page of a journal; the lines have the columns asked for
const journalPageSchema = (id: string, properties: Record<string, unknown>, what: string) =>
  ({
    $id: id,
    type: 'object',
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          description: `${what} The columns asked for, all of them unless given (columns).`,
          properties,
        },
      },
      limit: { type: 'integer' },
      total: { type: 'integer', description: 'The lines of the filters.' },
      nextCursor: { type: ['string', 'null'] },
    },
    required: ['items', 'limit', 'total', 'nextCursor'],
  }) as const;

// the admin log: its filters and its lines
const AUDIT_ACTIONS = [
  'USER_ROLE_CHANGE',
  'PRODUCT_CREATE',
  'PRODUCT_UPDATE',
  'PRODUCT_DELETE',
  'PRODUCT_PRICE_BULK_UPDATE',
  'PRODUCT_SALE',
  'STOCK_DELIVERY',
  'STOCK_WRITE_OFF',
  'ORDER_STATUS_CHANGE',
  'ORDER_SHIPMENT_CHANGE',
  'ORDER_DELIVERY_CHANGE',
  'CATEGORY_UPDATE',
  'REVIEW_DELETE',
  'OTHER',
] as const;
const AUDIT_ENTITY_TYPES = ['product', 'user', 'category', 'order', 'review', 'other'] as const;
const auditActionPattern = `(${AUDIT_ACTIONS.join('|')})`;

const AUDIT_COLUMNS = [
  'id',
  'createdAt',
  'actorId',
  'actor',
  'actorRole',
  'action',
  'event',
  'entityType',
  'entityId',
  'ip',
  'userAgent',
  'changes',
] as const;
const AUDIT_SORTS = [
  'id',
  'createdAt',
  'actorId',
  'actorRole',
  'action',
  'event',
  'entityType',
  'entityId',
  'ip',
  'userAgent',
] as const;

const adminAuditLogQuerySchema = {
  $id: 'adminAuditLogQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    actorId: {
      ...positiveIntegerSchema,
      description: 'Only the lines of this account.',
    },
    actorRole: {
      type: 'string',
      enum: ['USER', 'ADMIN', 'ROOT'],
      description:
        'Only the lines written with this role: root reads what the admins did with ADMIN; the ' +
        'system writes a refund of a late payment in the name of the buyer (USER).',
    },
    entityType: { type: 'string', enum: AUDIT_ENTITY_TYPES },
    entityId: { ...positiveIntegerSchema, description: 'Only the lines of this thing.' },
    actions: {
      type: 'string',
      pattern: `^${auditActionPattern}(,${auditActionPattern})*$`,
      description: 'Actions, one or several through commas. All unless given.',
    },
    field: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z]+$',
      description:
        'Only the lines with a change of this field: refund names the refunds of late ' +
        'payments, price the changes of a price.',
    },
    ...journalQueryFields(AUDIT_SORTS, AUDIT_COLUMNS, AUDIT_EVENTS),
  },
} as const;

const adminAuditLogResponseSchema = journalPageSchema(
  'adminAuditLogResponseSchema',
  {
    id: { type: 'integer' },
    createdAt: dateTimeSchema,
    actorId: {
      type: ['integer', 'null'],
      description: 'The id of the account that did it; 0 for an admin where it is root.',
    },
    actor: logAccountSchema,
    actorRole: {
      type: 'string',
      enum: ['USER', 'ADMIN', 'ROOT'],
      description: 'The role it had when it did it.',
    },
    action: { type: 'string', enum: AUDIT_ACTIONS },
    event: logEventSchema(
      AUDIT_EVENTS,
      'What made the line, finer than the action: the route, or the condition it was written under.',
    ),
    entityType: { type: 'string', enum: AUDIT_ENTITY_TYPES },
    entityId: {
      type: ['integer', 'null'],
      description: 'The thing; 0 for an admin where it is the account of root.',
    },
    ip: logIpSchema,
    userAgent: logUserAgentSchema,
    changes: {
      type: 'array',
      description:
        'What changed: each field with its value before and after. For an admin, where the line ' +
        'is about the account of root, the fields are named and their values hidden (a text is ' +
        'the word hidden, a number 0).',
      items: {
        type: 'object',
        properties: { field: { type: 'string' }, old: {}, new: {} },
        required: ['field'],
      },
    },
  },
  'A line of the admin log.',
);

// the log of prices
const PRICE_LOG_COLUMNS = [
  'id',
  'createdAt',
  'productId',
  'product',
  'actorId',
  'actor',
  'event',
  'oldPrice',
  'newPrice',
  'mode',
  'value',
  'endsAt',
] as const;
const PRICE_LOG_SORTS = [
  'id',
  'createdAt',
  'productId',
  'actorId',
  'event',
  'oldPrice',
  'newPrice',
  'mode',
  'value',
  'endsAt',
] as const;

const adminPriceLogQuerySchema = {
  $id: 'adminPriceLogQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: { ...positiveIntegerSchema, description: 'Only the changes of this product.' },
    actorId: {
      ...positiveIntegerSchema,
      description: 'Only the changes of this account.',
    },
    mode: {
      type: 'string',
      enum: ['fixed', 'percent'],
      description: 'Only the changes given this way: by an amount of money or by a percent.',
    },
    ...journalQueryFields(PRICE_LOG_SORTS, PRICE_LOG_COLUMNS, PRICE_LOG_EVENTS),
  },
} as const;

const adminPriceLogResponseSchema = journalPageSchema(
  'adminPriceLogResponseSchema',
  {
    id: { type: 'integer' },
    createdAt: dateTimeSchema,
    productId: { type: 'integer' },
    product: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
      required: ['id', 'name'],
    },
    actorId: { type: ['integer', 'null'] },
    actor: logAccountSchema,
    event: logEventSchema(
      PRICE_LOG_EVENTS,
      'What made the line: a price of one product, of many, of a selection, the start of a sale, its end.',
    ),
    oldPrice: { type: 'number' },
    newPrice: { type: 'number' },
    mode: { type: 'string', enum: ['fixed', 'percent'], description: 'How the change was given.' },
    value: {
      type: 'number',
      description: 'The size of the change in that mode, negative for a price that goes down.',
    },
    endsAt: {
      anyOf: [dateTimeSchema, { type: 'null' }],
      description: 'The end of the sale a line starts; a line with an end is the start of a sale.',
    },
  },
  'A line of the log of prices.',
);

// the log of logins
const LOGIN_LOG_COLUMNS = [
  'id',
  'createdAt',
  'userId',
  'user',
  'email',
  'role',
  'ipAddress',
  'userAgent',
  'event',
] as const;
const LOGIN_LOG_SORTS = [
  'id',
  'createdAt',
  'userId',
  'email',
  'role',
  'ipAddress',
  'userAgent',
  'event',
] as const;

const adminLoginLogQuerySchema = {
  $id: 'adminLoginLogQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: {
      ...positiveIntegerSchema,
      description: 'Only the logins of this account.',
    },
    roles: {
      type: 'string',
      pattern: '^(USER|ADMIN|ROOT)(,(USER|ADMIN|ROOT))*$',
      description: 'Only the logins of accounts with these roles, through commas.',
    },
    email: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'A part of the email of the login, whatever the case.',
    },
    ...journalQueryFields(LOGIN_LOG_SORTS, LOGIN_LOG_COLUMNS, LOGIN_EVENTS),
  },
} as const;

const adminLoginLogResponseSchema = journalPageSchema(
  'adminLoginLogResponseSchema',
  {
    id: { type: 'integer' },
    createdAt: dateTimeSchema,
    userId: { type: ['integer', 'null'] },
    user: logUserSchema,
    email: {
      type: ['string', 'null'],
      description:
        'The email the person came in with; the word hidden for an admin where it is root.',
    },
    role: { type: 'string', enum: ['USER', 'ADMIN', 'ROOT'], description: 'The role it had then.' },
    ipAddress: logIpSchema,
    userAgent: logUserAgentSchema,
    event: logEventSchema(LOGIN_EVENTS, 'How the person came in: a password or a provider.'),
  },
  'A login.',
);

// the log of consents
const CONSENT_LOG_COLUMNS = [
  'id',
  'createdAt',
  'userId',
  'user',
  'documentId',
  'document',
  'orderId',
  'ip',
  'userAgent',
  'event',
] as const;
const CONSENT_LOG_SORTS = [
  'id',
  'createdAt',
  'userId',
  'documentId',
  'orderId',
  'ip',
  'userAgent',
  'event',
] as const;

const adminConsentLogQuerySchema = {
  $id: 'adminConsentLogQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: { ...positiveIntegerSchema, description: 'Only the consents of this account.' },
    documentId: { ...positiveIntegerSchema, description: 'Only the consents to this version.' },
    orderId: { ...positiveIntegerSchema, description: 'Only the consents of this order.' },
    kind: {
      type: 'string',
      enum: ['terms', 'contract'],
      description: 'Only the consents to the versions of the terms or of the contract.',
    },
    ...journalQueryFields(CONSENT_LOG_SORTS, CONSENT_LOG_COLUMNS, CONSENT_EVENTS),
  },
} as const;

const adminConsentLogResponseSchema = journalPageSchema(
  'adminConsentLogResponseSchema',
  {
    id: { type: 'integer' },
    createdAt: dateTimeSchema,
    userId: { type: ['integer', 'null'] },
    user: logUserSchema,
    documentId: { type: 'integer' },
    document: {
      type: 'object',
      additionalProperties: false,
      description: 'The version the person agreed to.',
      properties: {
        kind: { type: 'string', enum: ['terms', 'contract'] },
        version: { type: 'integer' },
        title: { type: 'string' },
      },
      required: ['kind', 'version', 'title'],
    },
    orderId: {
      type: ['integer', 'null'],
      description:
        'The order the versions were confirmed with; none for the agreement of a person.',
    },
    ip: logIpSchema,
    userAgent: logUserAgentSchema,
    event: logEventSchema(CONSENT_EVENTS, 'Where the person agreed.'),
  },
  'A consent.',
);

// the events every journal writes, for the checkboxes of a page
const adminLogEventsResponseSchema = {
  $id: 'adminLogEventsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    auditLog: { type: 'array', items: { type: 'string', enum: [...AUDIT_EVENTS] } },
    priceLog: { type: 'array', items: { type: 'string', enum: [...PRICE_LOG_EVENTS] } },
    loginLog: { type: 'array', items: { type: 'string', enum: [...LOGIN_EVENTS] } },
    consentLog: { type: 'array', items: { type: 'string', enum: [...CONSENT_EVENTS] } },
  },
  required: ['auditLog', 'priceLog', 'loginLog', 'consentLog'],
} as const;

// the alerts of an admin
const ALERT_KINDS = [
  'paid_orders_waiting',
  'shipped_orders_waiting',
  'pickup_not_collected',
  'shipped_without_cost',
  'out_of_stock',
  'low_stock',
  'products_without_shipping_data',
  'expiring_batches',
  'expired_batches',
  'chats_waiting',
  'refunded_payments',
  'worker_stalled',
  'admin_actions',
] as const;

const ALERT_THRESHOLD_UNITS = ['days', 'units', 'seconds', 'hours'] as const;

const adminAlertsQuerySchema = {
  $id: 'adminAlertsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    subscribed: {
      type: 'boolean',
      description:
        'true: only the kinds the actor follows, for the notifications; every kind of the zone ' +
        'of the actor unless given.',
    },
  },
} as const;

const adminAlertsResponseSchema = {
  $id: 'adminAlertsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    alerts: {
      type: 'array',
      description: 'Each kind, in a fixed order, with zero too.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ALERT_KINDS },
          subscribed: { type: 'boolean', description: 'Whether the actor follows the kind.' },
          count: {
            type: 'integer',
            minimum: 0,
            description: 'The cases that wait, without the ones the actor put aside.',
          },
          dismissed: {
            type: 'integer',
            minimum: 0,
            description: 'The cases that wait the actor put aside.',
          },
          threshold: {
            type: ['integer', 'null'],
            description:
              'The threshold the kind is counted with, in its unit (GET ' +
              '/api/admin/alerts/subscriptions); null for a kind without one.',
          },
          list: {
            anyOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: { type: 'string' },
                  query: { type: 'object', additionalProperties: { type: 'string' } },
                },
                required: ['path', 'query'],
              },
              { type: 'null' },
            ],
            description:
              'The request to the list of the app with the cases of the kind, the most urgent ' +
              'first: the path and its query; the frontend adds a limit, a sort of that list or ' +
              'a filter. Its rows are the cases the kind counts, the ones put aside too. null ' +
              'for the worker.',
          },
        },
        required: ['kind', 'subscribed', 'count', 'dismissed', 'threshold', 'list'],
      },
    },
    total: { type: 'integer', minimum: 0, description: 'The counts of every alert together.' },
    dismissalsAvailable: {
      type: 'boolean',
      description:
        'false while Redis is down: the cases put aside are counted with the rest, dismissed ' +
        'is 0.',
    },
    generatedAt: dateTimeSchema,
  },
  required: ['alerts', 'total', 'dismissalsAvailable', 'generatedAt'],
} as const;

const adminAlertSubscriptionSchema = {
  $id: 'adminAlertSubscriptionSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ALERT_KINDS },
    subscribed: { type: 'boolean' },
    threshold: {
      anyOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'integer', description: 'The threshold the kind is counted with.' },
            default: { type: 'integer', description: 'The one the server gives.' },
            min: { type: 'integer' },
            max: { type: 'integer' },
            unit: { type: 'string', enum: ALERT_THRESHOLD_UNITS },
            custom: { type: 'boolean', description: 'Whether the actor set it.' },
          },
          required: ['value', 'default', 'min', 'max', 'unit', 'custom'],
        },
        { type: 'null' },
      ],
      description: 'null for a kind without a threshold.',
    },
  },
  required: ['kind', 'subscribed', 'threshold'],
} as const;

const adminAlertSubscriptionsResponseSchema = {
  $id: 'adminAlertSubscriptionsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: { $ref: 'adminAlertSubscriptionSchema#' } },
  },
  required: ['items'],
} as const;

const adminAlertKindParamsSchema = {
  $id: 'adminAlertKindParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z_]+$' },
  },
  required: ['kind'],
} as const;

const adminAlertThresholdBodySchema = {
  $id: 'adminAlertThresholdBodySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    value: {
      type: 'integer',
      minimum: 1,
      maximum: 100_000,
      description: 'The threshold, within the bounds of its kind.',
    },
  },
  required: ['value'],
} as const;

const adminAlertDismissalParamsSchema = {
  $id: 'adminAlertDismissalParamsSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z_]+$' },
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z0-9-]+$',
      description:
        'The id of the case in the list of its kind: an order, a product, a batch, a chat or a ' +
        'line of the admin log.',
    },
  },
  required: ['kind', 'id'],
} as const;

const adminAlertDismissalSchema = {
  $id: 'adminAlertDismissalSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ALERT_KINDS },
    id: { type: 'string' },
    dismissed: { type: 'boolean', description: 'Whether the case is aside now.' },
  },
  required: ['kind', 'id', 'dismissed'],
} as const;

const adminAlertDismissalsResponseSchema = {
  $id: 'adminAlertDismissalsResponseSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    items: {
      type: 'array',
      description: 'The cases the actor put aside that still wait, the latest first.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ALERT_KINDS },
          id: { type: 'string' },
          dismissedAt: dateTimeSchema,
        },
        required: ['kind', 'id', 'dismissedAt'],
      },
    },
  },
  required: ['items'],
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
  adminAuditLogQuerySchema,
  adminAuditLogResponseSchema,
  adminPriceLogQuerySchema,
  adminPriceLogResponseSchema,
  adminLoginLogQuerySchema,
  adminLoginLogResponseSchema,
  adminConsentLogQuerySchema,
  adminConsentLogResponseSchema,
  adminLogEventsResponseSchema,
  adminAlertsQuerySchema,
  adminAlertsResponseSchema,
  adminAlertSubscriptionSchema,
  adminAlertSubscriptionsResponseSchema,
  adminAlertKindParamsSchema,
  adminAlertThresholdBodySchema,
  adminAlertDismissalParamsSchema,
  adminAlertDismissalSchema,
  adminAlertDismissalsResponseSchema,
];
