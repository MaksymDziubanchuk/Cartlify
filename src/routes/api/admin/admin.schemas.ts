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
    deliveryRevenue: {
      total: 410,
      inPeriod: 105,
      last7d: 25,
      last30d: 105,
    },
    returned: {
      total: 320.5,
      inPeriod: 80,
      last7d: 0,
      last30d: 80,
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
    topVariantsByRevenue: [
      {
        product: { id: 10, name: 'Wireless headphones', deleted: false },
        variant: {
          id: 31,
          position: 2,
          name: 'Wireless headphones \u2014 black',
          sku: 'WH-BLK',
          deleted: false,
        },
        revenue: 899.82,
        quantitySold: 18,
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
  money: {
    income: { items: 3095.5, delivery: 105, total: 3200.5 },
    expenses: { costOfGoods: 1650.25, writeOffs: 42.5, shipping: 60, total: 1752.75 },
    margin: { items: 1445.25, delivery: 45, total: 1447.75 },
  },
  createdAt: '2026-01-31T23:59:59.999Z',
};

// Schema for admin dashboard statistics
const getStatsSchema = {
  operationId: 'getAdminStats',
  summary: 'Get admin stats',
  description:
    'Returns aggregated dashboard statistics for users, orders, products and reviews. The period ' +
    'is [from, to), all time until now unless given: the money, the units sold and the average ' +
    'order count the orders paid in it (paidAt), cancelled later or not, `orders.returned` what ' +
    'went back with the returns in it (by the time the money went back), the tops the net (the ' +
    'sales less the returns), the reviews and the users the ones made in it. The users are the ' +
    'accounts of buyers, admins and root are left out. `money` is the income, the expenses and ' +
    'the margins of the period, counted the way `summary` of GET /api/admin/reports/accounting ' +
    'counts them, in the same snapshot as the rest. ' +
    'The top of products (`topProductsByRevenue`) counts a product as the sum of all its ' +
    'variants; the top of variants (`topVariantsByRevenue`) lists the variants of the most money, ' +
    'each as `{ product, variant, revenue, quantitySold }`, so a product sold in two variants is ' +
    'one line of the first top and two lines of the second.',

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
      description:
        'Invalid admin stats query parameters: a period that ends before it starts (INVALID_STATS_PERIOD).',
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

const nothing = { units: 0, value: 0 };
const nothingReturned = { units: 0, revenue: 0, cost: 0 };

// the delivery of all orders in a period, as the report of the whole shop gives it
const deliveryExample = {
  income: { orders: 9, revenue: 45 },
  refunded: { orders: 1, revenue: 5 },
  shipping: { sends: 10, cost: 36.5, withoutCost: 2 },
  returnShipping: { sends: 1, cost: 4.5, withoutCost: 0, deducted: 0, reimbursed: 0 },
  result: 3.5,
};

// Schema for the accounting report
const getAccountingReportSchema = {
  operationId: 'getAccountingReport',
  summary: 'Get the accounting report',
  description:
    'The money of a period, from `from` (taken in) to `to` (left out), in the money of the ' +
    'shop: the sales of the orders paid in it (cancelled later or not), at the prices they were ' +
    'paid with, their cost at the costs of the batches they took and the margin; the returns, ' +
    'the rows of the statements whose money went back in it (by the time it went back), their ' +
    'money and the cost of the units that came back, by the kind of the statement (`byKind`: ' +
    'the right of withdrawal, or the reason an admin gave); the net, the sales less the ' +
    'returns; `summary`, the income (the net items, the delivery less what went back, ' +
    'together), the expenses (what the net items cost, the write-offs, the sends, together) and ' +
    'the margins (the items, the delivery, all of it); the batches taken in during it by ' +
    'source; the units written off in it by reason, at the costs of their batches (also the ' +
    'goods that came back and went out at once, as `customer_return`); and the stock, read from ' +
    'the stock log: at the start of the period, what came in, what went out, at the end, and ' +
    'apart the units on their way back. Every event is in the period it happened in: a return ' +
    'never changes the period its order was paid in. `productIds` keeps only the variants of ' +
    'these products, `variantIds` only these variants, `categoryId` the products of a category, ' +
    'with its whole branch unless `branch=false`. All of it comes from one snapshot. ' +
    'The `delivery` is of all orders and of no product, so it is none (null) in a report of some ' +
    'products, variants or of a category: what the orders paid in the period paid for it (by ' +
    'the time of the payment), what went back with the returns (by the time the money went ' +
    'back), what the sends ' +
    'cost the shop (by the time they were sent; the ones whose cost is not written are counted ' +
    'apart in `withoutCost`), and the result. ' +
    'This operation is restricted to privileged users.',

  querystring: {
    $ref: 'adminAccountingQuerySchema#',
    examples: [{ from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' }],
  },

  response: {
    200: {
      description: 'The report of the period.',
      $ref: 'adminAccountingResponseSchema#',
      examples: [
        {
          period: { from: '2026-10-01T00:00:00.000Z', to: '2026-11-01T00:00:00.000Z' },
          currency: 'eur',
          sales: { orders: 12, units: 30, revenue: 1500, cost: 900, margin: 600 },
          returns: {
            orders: 1,
            units: 2,
            revenue: 100,
            cost: 60,
            byKind: {
              withdrawal: { units: 2, revenue: 100, cost: 60 },
              refused: nothingReturned,
              defect: nothingReturned,
              wrong_item: nothingReturned,
              damaged: nothingReturned,
              goodwill: nothingReturned,
              shop_cancel: nothingReturned,
              other: nothingReturned,
            },
          },
          net: { units: 28, revenue: 1400, cost: 840, margin: 560, marginPercent: 40 },
          summary: {
            income: { items: 1500, delivery: 45, total: 1545 },
            expenses: { costOfGoods: 900, writeOffs: 90, shipping: 36.5, total: 1026.5 },
            margin: { items: 600, delivery: 8.5, total: 518.5 },
          },
          purchases: {
            units: 50,
            value: 1500,
            bySource: {
              supplier: { units: 48, value: 1450 },
              surplus: { units: 1, value: 30 },
              customer_return: { units: 1, value: 20 },
            },
          },
          writeOffs: {
            units: 3,
            value: 90,
            byReason: {
              damaged: { units: 2, value: 60 },
              defective: nothing,
              expired: nothing,
              shortage: { units: 1, value: 30 },
              returned_to_supplier: nothing,
              other: nothing,
              customer_return: nothing,
            },
          },
          stock: {
            opening: { units: 100, value: 3000 },
            received: { units: 50, value: 1500 },
            left: { units: 30, value: 900 },
            closing: { units: 120, value: 3600 },
            onTheWayBack: { units: 1, value: 30 },
          },
          delivery: deliveryExample,
        },
      ],
    },
    400: {
      description:
        'Invalid query: a date that is not a date or product or variant ids that are not ids ' +
        '(VALIDATION_ERROR), a period that ends before it starts (INVALID_STATS_PERIOD), an id ' +
        'past the largest or more than 100 ids (PRODUCT_IDS_INVALID, VARIANT_IDS_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read the report.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    404: {
      description: 'The category of `categoryId` does not exist (CATEGORY_NOT_FOUND).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while counting the report.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// ids: the report takes productIds and variantIds; cursor: it is paged (a report of every row has none)
const reportErrors = (what: string, { ids = false, cursor = true } = {}) => ({
  400: {
    description:
      'Invalid query: a wrong field (VALIDATION_ERROR), a period that ends before it starts ' +
      '(INVALID_STATS_PERIOD)' +
      (cursor ? ', a cursor of another sort (CURSOR_INVALID)' : '') +
      (ids
        ? ', ids that are too many or too large (PRODUCT_IDS_INVALID, VARIANT_IDS_INVALID).'
        : '.'),
    $ref: 'errorResponseSchema#',
  },
  401: {
    description: `Authentication is required to read ${what}.`,
    $ref: 'errorResponseSchema#',
  },
  403: {
    description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
    $ref: 'errorResponseSchema#',
  },
  404: {
    description: 'The category asked for does not exist (CATEGORY_NOT_FOUND).',
    $ref: 'errorResponseSchema#',
  },
  500: {
    description: `Unexpected server error while counting ${what}.`,
    $ref: 'errorResponseSchema#',
  },
});

const MONEY_TEXT =
  'For each row: the sales of the orders paid in the period (cancelled later or not), at their ' +
  'prices and the costs of the batches they took, with the margin and its percent of the ' +
  'revenue (none without a revenue); the returns, the rows whose money went back in it (by ' +
  'the time it went back), and the net, the sales less the returns; the units written off, and ' +
  'the margin of the net after them (`afterWriteOffs`); the units taken in, at their costs; and ' +
  'the stock (`stock`: opening, received, left, closing, from the stock log, and the units on ' +
  'their way back). Every event is in the period it happened in. ';

const CSV_TEXT =
  '`format=csv` gives the same as a csv file for the accountant (utf-8 with a byte order ' +
  'mark, commas, money to the cent with a point, a text that looks like a formula kept as ' +
  'text), every row and no pages.';

// the answer of format=csv: the file itself, sent as it is (content-disposition names it)
const CSV_FILE_SCHEMA = { type: 'string', description: 'The rows of the report as a csv file.' };

// Schema for the money of each product
const getAccountingProductsSchema = {
  operationId: 'getAccountingProducts',
  summary: 'Get the accounting by product',
  description:
    'The money of each product of a period, from `from` (taken in, all time without it) to ' +
    '`to` (left out, now without it): every product of the filter that sold, was cancelled, ' +
    'written off or taken in during it, or has stock left. A row is a PRODUCT (`{ product, ' +
    'category, ... }`): the money of all its variants of the filter added up, so a product ' +
    'with three variants is one row. GET /api/admin/reports/accounting/variants has a row for ' +
    'each variant, and its rows add up to these. ' +
    MONEY_TEXT +
    'And what the batches of the product have left now. A product removed from the catalog ' +
    'stays with its history (`product.deleted`). `productIds` keeps the variants of those ' +
    'products, `variantIds` only those variants (the product is the sum of the variants asked ' +
    'for; both: the variants of those products among them), `categoryId` a category, with its ' +
    'whole branch unless `branch=false`. Sorted by `sortBy` (revenue by default; `name` is the ' +
    'name of the product) and `sortOrder`, a page at a time with `nextCursor`; `totals` are of ' +
    'every product of the filter. ' +
    CSV_TEXT +
    ' The totals are its last line. This operation is restricted to privileged users.',

  querystring: {
    $ref: 'adminReportProductsQuerySchema#',
    examples: [{ from: '2026-10-01T00:00:00.000Z', sortBy: 'margin', sortOrder: 'desc' }],
  },

  response: {
    200: {
      description: 'The products of the page and the totals; a csv file with format=csv.',
      content: {
        'application/json': { schema: { $ref: 'adminReportProductsResponseSchema#' } },
        'text/csv': { schema: CSV_FILE_SCHEMA },
      },
    },
    ...reportErrors('the report by product', { ids: true }),
  },
} satisfies FastifySchema;

// Schema for the money of each variant, with its product
const getAccountingVariantsSchema = {
  operationId: 'getAccountingVariants',
  summary: 'Get the accounting by variant',
  description:
    'The money of each VARIANT of a period, the breakdown of GET ' +
    '/api/admin/reports/accounting/products: the same columns, filters (`productIds`, ' +
    '`variantIds`, `categoryId`, `branch`), period, sorts, pages and csv file, with the variant ' +
    'in every row (`{ product, variant, category, ... }`: the id, the place, the name and the ' +
    'article number of the variant, whether it is taken out of sale). Every variant of the ' +
    'filter that sold, was cancelled, written off or taken in during the period, or has stock ' +
    'left, is a row; the money of a whole product is the sum of its rows, and `totals` are those ' +
    'of the report by product. ' +
    MONEY_TEXT +
    'And what the batches of the variant have left now. A product removed from the catalog ' +
    'stays with its history (`product.deleted`; its variants are `variant.deleted`). Sorted by ' +
    '`sortBy` (revenue by default; `name` is the name of the variant) and `sortOrder`, a page ' +
    'at a time with `nextCursor` (a cursor of the report by product is CURSOR_INVALID here). ' +
    CSV_TEXT +
    ' The totals are its last line. This operation is restricted to privileged users.',

  querystring: {
    $ref: 'adminReportProductsQuerySchema#',
    examples: [
      { from: '2026-10-01T00:00:00.000Z', productIds: '10', sortBy: 'revenue', sortOrder: 'desc' },
    ],
  },

  response: {
    200: {
      description: 'The variants of the page and the totals; a csv file with format=csv.',
      content: {
        'application/json': { schema: { $ref: 'adminReportVariantsResponseSchema#' } },
        'text/csv': { schema: CSV_FILE_SCHEMA },
      },
    },
    ...reportErrors('the report by variant', { ids: true }),
  },
} satisfies FastifySchema;

// Schema for the money of each category
const getAccountingCategoriesSchema = {
  operationId: 'getAccountingCategories',
  summary: 'Get the accounting by category',
  description:
    'The money of each category of a period, the sum of the variants of its products: by ' +
    'default with its whole branch, so a parent has the money of its children in it and the rows ' +
    'are not added up; `branch=false` counts the own products of each category only. ' +
    '`categoryId` gives that one category. ' +
    MONEY_TEXT +
    'And what the batches have left now. Every category, with nothing in the period too, sorted ' +
    'by `sortBy` and `sortOrder`. ' +
    CSV_TEXT +
    ' This operation is restricted to privileged users.',

  querystring: {
    $ref: 'adminReportCategoriesQuerySchema#',
    examples: [{ from: '2026-10-01T00:00:00.000Z', sortBy: 'revenue' }],
  },

  response: {
    200: {
      description: 'The categories; a csv file with format=csv.',
      content: {
        'application/json': { schema: { $ref: 'adminReportCategoriesResponseSchema#' } },
        'text/csv': { schema: CSV_FILE_SCHEMA },
      },
    },
    ...reportErrors('the report by category', { cursor: false }),
  },
} satisfies FastifySchema;

// Schema for the money of each step of time
const getAccountingTimelineSchema = {
  operationId: 'getAccountingTimeline',
  summary: 'Get the accounting by day, week or month',
  description:
    'The money of a period step by step: the days, the weeks from monday or the months of the ' +
    'calendar of the shop (`timeZone`, SHOP_TIME_ZONE), the first and the last step cut to the ' +
    'period, up to 400 steps (REPORT_PERIOD_TOO_LONG, `details.maxSteps`). Without `from` the ' +
    'period is the step of `to` and the eleven before it. ' +
    MONEY_TEXT +
    'Each step in the order of time, or by `sortBy`; the sum of the variants of `productIds` ' +
    '(the products), of `variantIds` or of a category. The `delivery` of each step is of all ' +
    'orders, and none (null) with `productIds`, `variantIds` or `categoryId`; the csv has its ' +
    'columns empty then. `summary` of each step is its income, ' +
    'its expenses and its margins, as in the report of the period. ' +
    CSV_TEXT +
    ' This operation is restricted to privileged users.',

  querystring: {
    $ref: 'adminReportTimelineQuerySchema#',
    examples: [{ from: '2026-01-01T00:00:00.000Z', step: 'month' }],
  },

  response: {
    200: {
      description: 'The steps of the period; a csv file with format=csv.',
      content: {
        'application/json': { schema: { $ref: 'adminReportTimelineResponseSchema#' } },
        'text/csv': { schema: CSV_FILE_SCHEMA },
      },
    },
    ...reportErrors('the report by time', { cursor: false }),
    400: {
      description:
        'Invalid query: a wrong field (VALIDATION_ERROR), a period that ends before it starts ' +
        '(INVALID_STATS_PERIOD), more than 400 steps (REPORT_PERIOD_TOO_LONG), ids that are ' +
        'too many or too large (PRODUCT_IDS_INVALID, VARIANT_IDS_INVALID).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// period: the list is filtered by from and to; expiresBy: by the last good day of a batch
const stockErrors = (what: string, filter: 'period' | 'expiresBy') => ({
  400: {
    description:
      'Invalid query: a wrong field (VALIDATION_ERROR), ' +
      (filter === 'period'
        ? 'a period that ends before it starts or a date of the year 0 (INVALID_STATS_PERIOD), '
        : 'a last day of the year 0 (EXPIRES_BY_INVALID), ') +
      'a cursor of another order or past the ids (CURSOR_INVALID).',
    $ref: 'errorResponseSchema#',
  },
  401: {
    description: `Authentication is required to read ${what}.`,
    $ref: 'errorResponseSchema#',
  },
  403: {
    description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
    $ref: 'errorResponseSchema#',
  },
  500: {
    description: `Unexpected server error while reading ${what}.`,
    $ref: 'errorResponseSchema#',
  },
});

// Schema for the batches of the stock
const getStockBatchesSchema = {
  operationId: 'getStockBatches',
  summary: 'List the batches of the stock',
  description:
    'Each batch of a variant (`variant`, with its `product`) with what it came in with ' +
    '(`quantity`, `unitCost`), what is left of it ' +
    '(`remaining`, `value` at its cost), the units of the paid orders (`sold`, a return puts ' +
    'them back) and the units written off; the delivery it came with (`deliveryId`, the ' +
    'supplier, the invoice, the note and the admin who took it in); `expired` when its last ' +
    'good day is behind the day of the shop (SHOP_TIME_ZONE): such units are not sold and wait ' +
    'for a write-off. `productId` keeps the batches of all the variants of a product, ' +
    '`variantId` those of one variant. A page at a time, newest first unless sorted ' +
    'otherwise. This operation is restricted to privileged users.',

  querystring: {
    $ref: 'adminStockBatchesQuerySchema#',
    examples: [{ inStock: true, sortBy: 'expiresAt', sortOrder: 'asc' }],
  },

  response: {
    200: { description: 'A page of batches.', $ref: 'adminStockBatchesResponseSchema#' },
    ...stockErrors('the batches', 'expiresBy'),
  },
} satisfies FastifySchema;

// Schema for the journal of the stock
const getStockMovementsSchema = {
  operationId: 'getStockMovements',
  summary: 'List the steps of the stock',
  description:
    'Every step of the stock of a variant (`variant`, with its `product`) in one list: a ' +
    'delivery and a write-off (a line for each variant, with the admin), a sale (the units a ' +
    'paid order took, at the payment), a return (the units that came back with a statement of ' +
    'return, also the cancel of a paid order, back in the same batches) and a return write-off ' +
    '(the units of a return that went out at once, written off or lost). ' +
    '`quantity` and `value` are the change: in above 0, out below; `batches` are the batches ' +
    'in the order the units were taken. `productId` keeps the steps of all the variants of a ' +
    'product, `variantId` those of one variant. Newest first unless asked; a page at a time. ' +
    'This operation is restricted to privileged users.',

  querystring: {
    $ref: 'adminStockMovementsQuerySchema#',
    examples: [{ productId: 10, kind: 'delivery,writeOff' }],
  },

  response: {
    200: { description: 'A page of steps.', $ref: 'adminStockMovementsResponseSchema#' },
    ...stockErrors('the journal of the stock', 'period'),
  },
} satisfies FastifySchema;

// Group admin routes under the admin Swagger tag
// Schema for the admin log
const getAuditLogSchema = {
  operationId: 'getAdminAuditLog',
  summary: 'Get the admin log',
  description:
    'The lines of the admin log, the newest first unless sorted: who did what to what, the ' +
    'changes, the address and the browser of the request (none for the work of the server ' +
    'alone), and the `event` that made the line, finer than the action (`product.update_batch`, ' +
    '`order.ship_bulk`; GET /api/admin/log-events lists them). Filters: the account ' +
    '(`actorId`), the role it wrote with (`actorRole`), the thing (`entityType`, `entityId`), ' +
    'the actions (`actions`), a field among the changes (`field`), the events (`events`), the ' +
    'period (`from` taken in, `to` left out). `sortBy` takes any simple column, `columns` the ' +
    'columns of the answer and of the csv. `format=csv` gives every line of the filters as a ' +
    'file, without pages. Admin and root read the same lines with the same filters; for an ' +
    'admin the data of root (who, the address, the browser, the things and changes about its ' +
    'account) are left out, only its role is there. The newsletters write lines of their own: ' +
    'root giving an admin the right to run them or taking it away (the thing is the account, ' +
    'action `NEWSLETTER_MANAGER_CHANGE`), a newsletter made, changed, planned, stopped and so on ' +
    '(`newsletter_campaign`, `NEWSLETTER_CAMPAIGN_CHANGE`), a subscriber erased by an admin ' +
    '(the address made anonymous, `newsletter_subscriber`, `NEWSLETTER_SUBSCRIBER_DELETE`, event ' +
    '`newsletter.subscriber_erased`), an address blocked for the ' +
    'public form added or taken off (`newsletter_block`, `NEWSLETTER_BLOCK_CHANGE`); their ' +
    'events start with `newsletter.`.',

  querystring: { $ref: 'adminAuditLogQuerySchema#' },

  response: {
    200: {
      description: 'The lines of the page; a csv file with format=csv.',
      content: {
        'application/json': { schema: { $ref: 'adminAuditLogResponseSchema#' } },
        'text/csv': { schema: CSV_FILE_SCHEMA },
      },
    },
    400: {
      description:
        'Invalid query: a wrong field (VALIDATION_ERROR), a period that ends before it starts ' +
        '(INVALID_STATS_PERIOD), a column or an event the log has not (LOG_COLUMNS_INVALID, ' +
        'LOG_EVENTS_INVALID, `details.allowed`), a cursor of another list or sort (CURSOR_INVALID).',
      $ref: 'errorResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read the admin log.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the admin log.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// the way the other journals answer: the same errors and the same csv
const journalResponse = (what: string, schemaId: string) => ({
  200: {
    description: 'The lines of the page; a csv file with format=csv.',
    content: {
      'application/json': { schema: { $ref: `${schemaId}#` } },
      'text/csv': { schema: CSV_FILE_SCHEMA },
    },
  },
  400: {
    description:
      'Invalid query: a wrong field (VALIDATION_ERROR), a period that ends before it starts ' +
      '(INVALID_STATS_PERIOD), a column or an event the journal has not (LOG_COLUMNS_INVALID, ' +
      'LOG_EVENTS_INVALID, `details.allowed`), a cursor of another list or sort (CURSOR_INVALID).',
    $ref: 'errorResponseSchema#',
  },
  401: {
    description: `Authentication is required to read ${what}.`,
    $ref: 'errorResponseSchema#',
  },
  403: {
    description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
    $ref: 'errorResponseSchema#',
  },
  500: {
    description: `Unexpected server error while reading ${what}.`,
    $ref: 'errorResponseSchema#',
  },
});

const JOURNAL_TEXT =
  'Sorted by any simple column (`sortBy`, `sortOrder`), within a period (`from` taken in, `to` ' +
  'left out), for the events asked for (`events`, GET /api/admin/log-events lists them), with the ' +
  'columns asked for (`columns`); `format=csv` gives every line of the filters as a file. Admin ' +
  'and root read the same lines with the same filters; for an admin the data of root (who, ' +
  'the address, the browser) are left out, only its role is there.';

// Schema for the log of prices
const getPriceLogSchema = {
  operationId: 'getAdminPriceLog',
  summary: 'Get the log of prices',
  description:
    'Every change of the price of every variant, a line for each variant with its product: the ' +
    'old and the new price, how it was given (`mode`, `value`), who did it and the `event` that ' +
    'made the line (a price of one variant, of many, of a selection, the start of a sale, its ' +
    'end). A line with `endsAt` starts a sale. Filters: `productId`, `variantId`, `actorId`, ' +
    '`mode`. ' +
    JOURNAL_TEXT,
  querystring: {
    $ref: 'adminPriceLogQuerySchema#',
    examples: [{ variantId: 31, events: 'price.set,price.bulk', sortBy: 'newPrice' }],
  },
  response: journalResponse('the log of prices', 'adminPriceLogResponseSchema'),
} satisfies FastifySchema;

// Schema for the stock log
const getStockLogSchema = {
  operationId: 'getAdminStockLog',
  summary: 'Get the stock log',
  description:
    'Every change of the quantity of a variant, a line for each variant for each change: how ' +
    'many units came in (above 0) or went out (below 0), the stock after it (`stockAfter`), the ' +
    '`event` that made it (`stock.delivery`, `stock.write_off`, `stock.sale` at the payment of an ' +
    'order, `stock.return` for the units that came back with a statement of return (also the ' +
    'cancel of a paid order), `stock.return_write_off` for the ones that went out again at ' +
    'once), the operation ' +
    'it belongs to (`deliveryId` of a delivery, `writeOffId` of a write-off, `orderId` of an ' +
    'order: every operation that touched many variants carries one id in all its lines, the same ' +
    'id its answer or the admin log line gives), who did it (none for the sale at a payment, which ' +
    'the system makes), the address and the browser of the request, and what the change was made ' +
    'of (`changes`: the batches with their costs, the reason, the supplier, the invoice, the ' +
    'note). A reserve of units and its release do not change the stock and have no line. For a ' +
    'variant whose stock only moved through the routes of the shop, the sum of its `quantityChange` ' +
    'is its stock and the last `stockAfter` is its stock. Filters: `productId` (all its ' +
    'variants), `variantId`, `deliveryId`, `writeOffId`, `orderId`. ' +
    JOURNAL_TEXT,
  querystring: {
    $ref: 'adminStockLogQuerySchema#',
    examples: [{ variantId: 31, events: 'stock.sale,stock.return', sortBy: 'quantityChange' }],
  },
  response: journalResponse('the stock log', 'adminStockLogResponseSchema'),
} satisfies FastifySchema;

// Schema for the log of logins
const getLoginLogSchema = {
  operationId: 'getAdminLoginLog',
  summary: 'Get the log of logins',
  description:
    'Who came in, with which role and how (`event`: a password, Google, GitHub or LinkedIn), ' +
    'from which address and browser. Filters: `userId`, `roles`, `email` (a part of it). A ' +
    'person reads their own logins in their sessions and in their export. ' +
    JOURNAL_TEXT,
  querystring: {
    $ref: 'adminLoginLogQuerySchema#',
    examples: [{ roles: 'ADMIN,ROOT', events: 'login.password', sortBy: 'ipAddress' }],
  },
  response: journalResponse('the log of logins', 'adminLoginLogResponseSchema'),
} satisfies FastifySchema;

// Schema for the log of consents
const getConsentLogSchema = {
  operationId: 'getAdminConsentLog',
  summary: 'Get the log of consents',
  description:
    'Who agreed to which version of the terms and of the contract, and where (`event`: the ' +
    'registration, a login, an account made through a provider, the agreement a customer gives ' +
    'by itself, an order), from which address and browser. Filters: `userId`, `documentId`, ' +
    '`orderId`, `kind`. ' +
    JOURNAL_TEXT,
  querystring: {
    $ref: 'adminConsentLogQuerySchema#',
    examples: [{ kind: 'terms', events: 'consent.order', orderId: 42 }],
  },
  response: journalResponse('the log of consents', 'adminConsentLogResponseSchema'),
} satisfies FastifySchema;

// Schema for the events of the journals
const getLogEventsSchema = {
  operationId: 'getAdminLogEvents',
  summary: 'Get the events of the journals',
  description:
    'The events every journal writes (the admin log, the log of prices, of logins, of consents ' +
    'and the stock log): what the checkboxes of a page of a journal list. A line from before the ' +
    'events has `legacy.unknown` (the stock log has none: it began with its events).',
  response: {
    200: {
      description: 'The events of each journal.',
      $ref: 'adminLogEventsResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read the events.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the alerts of an admin
const getAlertsSchema = {
  operationId: 'getAdminAlerts',
  summary: 'Get the alerts',
  description:
    'What waits for the work of an admin, each kind of the zone of the actor with how many ' +
    'cases wait now, counted with the thresholds of the actor (GET ' +
    '/api/admin/alerts/subscriptions): paid orders to ship (`paid_orders_waiting`), orders sent ' +
    'by hand and not delivered for some days (`shipped_orders_waiting`), pickups ready and not ' +
    'collected for some days (`pickup_not_collected`), sends whose cost the shop has not ' +
    'written for some days (`shipped_without_cost`), orders shipped by hand whose send has no ' +
    'tracking number for some days (`shipped_without_tracking`), statements of return: ' +
    'a transfer of the money that failed (`failed_refunds`), a statement made without the code ' +
    'that waits for a check (`returns_manual_check`), a proof of the parcel told and not ' +
    'confirmed for some days (`returns_proof_waiting`), no goods and no word of the parcel ' +
    'some days after the statement (`returns_goods_not_sent`), the money due and not back some ' +
    'days after the statement (`returns_money_late`), the money back and the goods not in ' +
    'some days later (`returns_goods_late`), products of the catalog with no free ' +
    'units (`out_of_stock`) or with a few (`low_stock`), variants that lack the weight or the ' +
    'sizes (`products_without_shipping_data`), variants that lack a characteristic their ' +
    'category requires (`variants_missing_required`), products of the catalog a buyer sees none ' +
    'of the variants of (`products_hidden_from_buyers`; a product removed on purpose is not ' +
    'one), batches whose last good ' +
    'day is in some days (`expiring_batches`) or over with units left (`expired_batches`), ' +
    'chats with a message no admin has read (`chats_waiting`), late payments given back in ' +
    'some last days (`refunded_payments`), a reservation worker that has not run for some ' +
    'seconds (`worker_stalled`), the fields of the data of the shop root has not set yet ' +
    '(`shop_settings_incomplete`; how many, the ones GET /api/admin/shop-settings/missing ' +
    'names), the language of the shop with no dictionary any more ' +
    '(`shop_locale_missing`; 1 while it is gone, 0 once it is set to one that has one). Root, ' +
    'and an admin root allowed to run the newsletters (the right is read from the database at ' +
    'every request, so an admin who loses it stops seeing these kinds at once, and one who gets ' +
    'it starts seeing them), also get the newsletters: campaigns whose mails did not arrive ' +
    '(`newsletter_undelivered`) or were not taken by the mail provider (`newsletter_rejected`) ' +
    'over some per cent, or were marked as spam (`newsletter_complaints`) over some in a ' +
    'thousand (per mille, unit `permille`: a complaint is rare, 3 is 0.3%; a share is judged ' +
    'on the mails already answered for, when there are at least 20, for the campaigns that go ' +
    'out and the ones that started in the last 14 days), a campaign that has been going out ' +
    'for some days (`newsletter_running_long`), a campaign scheduled to start in some ' +
    'hours, or whose time has passed and that nothing started yet ' +
    '(`newsletter_starting_soon`), a campaign the limit of the campaigns of the shop called ' +
    'off when its time came, in some last days (`newsletter_cancelled_by_limit`: copy the ' +
    'campaign and schedule the copy for a time that fits) and the stop of the sending worker ' +
    '(`newsletter_sending_halted`: 1 from the moment the worker stopped on a problem of the ' +
    'whole stream, such as a key the mail provider refuses, until a pass goes through; ' +
    '`occurredAt` is the time of the last stop; no threshold, no list, nothing to put ' +
    'aside); the cases of the others are campaigns, their lists are the list of the ' +
    'campaigns with the filters. Root also gets the lines the admins wrote in some last hours ' +
    '(`admin_actions`). Each kind names the request to the list of the app with its cases ' +
    '(`list`): the page of an admin shows a few of its rows and sorts them the way that list ' +
    'sorts, a click leads to the list or to a case. The cases the actor put aside are left out ' +
    'of `count` and counted in `dismissed`. The frontend asks again at the interval the admin ' +
    'chose and notifies when the counts changed.',

  querystring: { $ref: 'adminAlertsQuerySchema#' },

  response: {
    200: {
      description: 'The alerts of the actor.',
      $ref: 'adminAlertsResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read the alerts.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the alerts.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

// Schema for the settings of the kinds of alerts of an actor
const getAlertSubscriptionsSchema = {
  operationId: 'getAdminAlertSubscriptions',
  summary: 'Get the settings of the alerts',
  description:
    'Each kind of alerts of the actor: whether they follow it and its threshold (the one they ' +
    'set or the one the server gives, its bounds and unit; null for a kind without one). Every ' +
    'kind is followed until the actor turns it off. Each admin and each root has their own. The ' +
    'kinds of the newsletters are listed for root and for an admin root allowed to run the ' +
    'newsletters only (the right is read from the database at every request).',

  response: {
    200: {
      description: 'The kinds of the actor.',
      $ref: 'adminAlertSubscriptionsResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read the settings.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the settings.',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const alertSubscriptionSchema = (on: boolean) =>
  ({
    operationId: on ? 'subscribeAdminAlert' : 'unsubscribeAdminAlert',
    summary: on ? 'Follow a kind of alerts' : 'Stop following a kind of alerts',
    description: on
      ? 'The actor follows the kind again: GET /api/admin/alerts?subscribed=true names it. Its ' +
        'threshold stays. One followed stays so.'
      : 'The actor alone stops following the kind: GET /api/admin/alerts?subscribed=true leaves ' +
        'it out, GET /api/admin/alerts still names it. Its threshold stays. One not followed ' +
        'stays so.',

    params: { $ref: 'adminAlertKindParamsSchema#' },

    response: {
      200: {
        description: 'The setting of the kind now.',
        $ref: 'adminAlertSubscriptionSchema#',
      },
      400: {
        description: 'A kind that is not a name of a kind (VALIDATION_ERROR).',
        $ref: 'errorResponseSchema#',
      },
      401: {
        description: 'Authentication is required to change the settings.',
        $ref: 'errorResponseSchema#',
      },
      403: {
        description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
        $ref: 'errorResponseSchema#',
      },
      404: {
        description:
          'No such kind for the actor (ALERT_KIND_NOT_FOUND): admin_actions is a kind of root, ' +
          'the newsletter_* kinds are for root and for an admin root allowed to run the newsletters.',
        $ref: 'errorResponseSchema#',
      },
      500: {
        description: 'Unexpected server error while changing the setting.',
        $ref: 'errorResponseSchema#',
      },
    },
  }) satisfies FastifySchema;

const putAlertSubscriptionSchema = alertSubscriptionSchema(true);
const deleteAlertSubscriptionSchema = alertSubscriptionSchema(false);

const alertThresholdSchema = (set: boolean) =>
  ({
    operationId: set ? 'setAdminAlertThreshold' : 'resetAdminAlertThreshold',
    summary: set ? 'Set the threshold of a kind of alerts' : 'Give the threshold back',
    description: set
      ? 'Sets the threshold of the kind for the actor only, within the bounds of the kind (GET ' +
        '/api/admin/alerts/subscriptions names them): the alerts count with it and its list is ' +
        'asked with it. Whether the actor follows the kind stays.'
      : 'The kind is counted with the threshold the server gives again, for the actor only. ' +
        'Whether the actor follows the kind stays.',

    params: { $ref: 'adminAlertKindParamsSchema#' },
    ...(set ? { body: { $ref: 'adminAlertThresholdBodySchema#' } } : {}),

    response: {
      200: {
        description: 'The setting of the kind now.',
        $ref: 'adminAlertSubscriptionSchema#',
      },
      400: {
        description: set
          ? 'A kind that is not a name of a kind, a threshold that is not a whole number from 1 ' +
            '(VALIDATION_ERROR); a threshold out of the bounds of the kind ' +
            '(ALERT_THRESHOLD_INVALID, details.min and details.max).'
          : 'A kind that is not a name of a kind (VALIDATION_ERROR).',
        $ref: 'errorResponseSchema#',
      },
      401: {
        description: 'Authentication is required to change the settings.',
        $ref: 'errorResponseSchema#',
      },
      403: {
        description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
        $ref: 'errorResponseSchema#',
      },
      404: {
        description:
          'No such kind for the actor (ALERT_KIND_NOT_FOUND): admin_actions is a kind of root, ' +
          'the newsletter_* kinds are for root and for an admin root allowed to run the ' +
          'newsletters; a kind without a threshold (ALERT_THRESHOLD_NOT_FOUND).',
        $ref: 'errorResponseSchema#',
      },
      500: {
        description: 'Unexpected server error while changing the setting.',
        $ref: 'errorResponseSchema#',
      },
    },
  }) satisfies FastifySchema;

const putAlertThresholdSchema = alertThresholdSchema(true);
const deleteAlertThresholdSchema = alertThresholdSchema(false);

// Schema for the cases an actor put aside
const getAlertDismissalsSchema = {
  operationId: 'getAdminAlertDismissals',
  summary: 'Get the cases put aside',
  description:
    'The cases of the alerts the actor put aside that still wait, the latest first. A case ' +
    'that is over (the order shipped, the chat read, the batch written off) is no longer aside: ' +
    'it alerts again if it comes back. They live in Redis.',

  response: {
    200: {
      description: 'The cases the actor put aside.',
      $ref: 'adminAlertDismissalsResponseSchema#',
    },
    401: {
      description: 'Authentication is required to read the cases put aside.',
      $ref: 'errorResponseSchema#',
    },
    403: {
      description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
      $ref: 'errorResponseSchema#',
    },
    500: {
      description: 'Unexpected server error while reading the cases put aside.',
      $ref: 'errorResponseSchema#',
    },
    503: {
      description: 'Redis is down (REDIS_UNAVAILABLE).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const alertDismissalSchema = (on: boolean) =>
  ({
    operationId: on ? 'dismissAdminAlertCase' : 'restoreAdminAlertCase',
    summary: on ? 'Put a case of an alert aside' : 'Take a case of an alert back',
    description: on
      ? 'Puts one case that waits aside for the actor only: it leaves `count` of its kind and ' +
        'is counted in `dismissed`. It stays aside until the actor takes it back or the case is ' +
        'over. One put aside stays aside.'
      : 'Takes a case put aside back for the actor: it alerts again. One that is not aside ' +
        'stays so.',

    params: { $ref: 'adminAlertDismissalParamsSchema#' },

    response: {
      200: {
        description: 'The case and whether it is aside now.',
        $ref: 'adminAlertDismissalSchema#',
      },
      400: {
        description: 'A kind or an id that is not a name or an id (VALIDATION_ERROR).',
        $ref: 'errorResponseSchema#',
      },
      401: {
        description: 'Authentication is required to put a case aside.',
        $ref: 'errorResponseSchema#',
      },
      403: {
        description: 'The current actor is not admin or root (INSUFFICIENT_ROLE).',
        $ref: 'errorResponseSchema#',
      },
      404: {
        description: on
          ? 'No such kind with cases for the actor (ALERT_KIND_NOT_FOUND): worker_stalled, ' +
            'shop_settings_incomplete and shop_locale_missing have no cases, admin_actions is a ' +
            'kind of root, the newsletter_* kinds are for root and for an admin root allowed to ' +
            'run the newsletters; no case of the kind waits with the id (ALERT_ITEM_NOT_FOUND).'
          : 'No such kind with cases for the actor (ALERT_KIND_NOT_FOUND): worker_stalled, ' +
            'shop_settings_incomplete and shop_locale_missing have no cases, admin_actions is a ' +
            'kind of root, the newsletter_* kinds are for root and for an admin root allowed to ' +
            'run the newsletters.',
        $ref: 'errorResponseSchema#',
      },
      500: {
        description: 'Unexpected server error while changing the case.',
        $ref: 'errorResponseSchema#',
      },
      503: {
        description: 'Redis is down (REDIS_UNAVAILABLE).',
        $ref: 'errorResponseSchema#',
      },
    },
  }) satisfies FastifySchema;

const putAlertDismissalSchema = alertDismissalSchema(true);
const deleteAlertDismissalSchema = alertDismissalSchema(false);

const taggedAdminSchema = withOpenApiTag(
  {
    getStatsSchema,
    getAccountingReportSchema,
    getAccountingProductsSchema,
    getAccountingVariantsSchema,
    getAccountingCategoriesSchema,
    getAccountingTimelineSchema,
    getStockBatchesSchema,
    getStockMovementsSchema,
    getAuditLogSchema,
    getStockLogSchema,
    getPriceLogSchema,
    getLoginLogSchema,
    getConsentLogSchema,
    getLogEventsSchema,
    getAlertsSchema,
    getAlertSubscriptionsSchema,
    putAlertSubscriptionSchema,
    deleteAlertSubscriptionSchema,
    putAlertThresholdSchema,
    deleteAlertThresholdSchema,
    getAlertDismissalsSchema,
    putAlertDismissalSchema,
    deleteAlertDismissalSchema,
  },
  'admin',
);

// Add access token security to all admin routes
export const adminSchema = withOpenApiSecurity(
  taggedAdminSchema,
  openApiSecurity.accessTokenCookie,
);
