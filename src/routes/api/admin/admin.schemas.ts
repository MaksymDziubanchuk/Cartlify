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
  description:
    'Returns aggregated dashboard statistics for users, orders, products and reviews. The period ' +
    'is [from, to), all time until now unless given: the money, the units sold, the average order ' +
    'and the tops count the orders paid in it (paidAt), the reviews and the users the ones made in ' +
    'it. The users are the accounts of buyers, admins and root are left out.',

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

// Schema for the accounting report
const getAccountingReportSchema = {
  operationId: 'getAccountingReport',
  summary: 'Get the accounting report',
  description:
    'The money of a period, from `from` (taken in) to `to` (left out), in the money of the ' +
    'shop: the sales of the orders paid in it at the prices they were paid with, their cost at ' +
    'the costs of the batches they took and the margin; the paid orders cancelled in it, whose ' +
    'money went back; the net of both; the batches taken in during it by source; the units ' +
    'written off in it by reason, at the costs of their batches; and what the batches have left ' +
    'now. A sale cancelled later stays a sale of its period, its cancel counts in the period of ' +
    'the cancel. `productIds` keeps only these products, `categoryId` the products of a category, with its whole branch unless `branch=false`. All of it comes from one snapshot. ' +
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
          cancellations: { orders: 1, units: 2, revenue: 100, cost: 60 },
          net: { revenue: 1400, cost: 840, margin: 560 },
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
            },
          },
          stock: { units: 120, value: 3600 },
        },
      ],
    },
    400: {
      description:
        'Invalid query: a date that is not a date or product ids that are not ids ' +
        '(VALIDATION_ERROR), a period that ends before it starts (INVALID_STATS_PERIOD), an id ' +
        'past the largest or more than 100 ids (PRODUCT_IDS_INVALID).',
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

const reportErrors = (what: string) => ({
  400: {
    description:
      'Invalid query: a wrong field (VALIDATION_ERROR), a period that ends before it starts ' +
      '(INVALID_STATS_PERIOD), a cursor of another sort (CURSOR_INVALID).',
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
  'For each row: the sales of the orders paid in the period at their prices and the costs of ' +
  'the batches they took, with the margin; the paid orders cancelled in it; the net of both, ' +
  'with the margin as a percent of the revenue (none without a revenue); the units written off ' +
  'and taken in, at their costs. The margin is of the sales, the write-offs are apart. ';

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
    'written off or taken in during it, or has stock left. ' +
    MONEY_TEXT +
    'And what the batches of the product have left now. A product removed from the catalog ' +
    'stays with its history (`deleted`). `categoryId` keeps a category, with its whole ' +
    'branch unless `branch=false`. Sorted by `sortBy` (revenue by default) and `sortOrder`, a ' +
    'page at a time with `nextCursor`; `totals` are of every product of the filter. ' +
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
    ...reportErrors('the report by product'),
  },
} satisfies FastifySchema;

// Schema for the money of each category
const getAccountingCategoriesSchema = {
  operationId: 'getAccountingCategories',
  summary: 'Get the accounting by category',
  description:
    'The money of each category of a period: by default with its whole branch, so a parent has ' +
    'the money of its children in it and the rows are not added up; `branch=false` counts the ' +
    'own products of each category only. `categoryId` gives that one category. ' +
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
    ...reportErrors('the report by category'),
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
    'Each step in the order of time, or by `sortBy`; the products of `productIds` or of a ' +
    'category. ' +
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
    ...reportErrors('the report by time'),
    400: {
      description:
        'Invalid query: a wrong field (VALIDATION_ERROR), a period that ends before it starts ' +
        '(INVALID_STATS_PERIOD), more than 400 steps (REPORT_PERIOD_TOO_LONG), ids that are ' +
        'too many or too large (PRODUCT_IDS_INVALID).',
      $ref: 'errorResponseSchema#',
    },
  },
} satisfies FastifySchema;

const stockErrors = (what: string) => ({
  400: {
    description:
      'Invalid query: a wrong field (VALIDATION_ERROR), a period that ends before it starts or a ' +
      'date of the year 0 (INVALID_STATS_PERIOD), a last day of the year 0 (EXPIRES_BY_INVALID), a ' +
      'cursor of another order or past the ids (CURSOR_INVALID).',
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
    'Each batch with what it came in with (`quantity`, `unitCost`), what is left of it ' +
    '(`remaining`, `value` at its cost), the units of the paid orders (`sold`, a cancel puts ' +
    'them back) and the units written off; the delivery it came with (`deliveryId`, the ' +
    'supplier, the invoice, the note and the admin who took it in); `expired` when its last ' +
    'good day is behind the day of the shop (SHOP_TIME_ZONE): such units are not sold and wait ' +
    'for a write-off. A page at a time, newest first unless sorted otherwise. This operation is ' +
    'restricted to privileged users.',

  querystring: {
    $ref: 'adminStockBatchesQuerySchema#',
    examples: [{ inStock: true, sortBy: 'expiresAt', sortOrder: 'asc' }],
  },

  response: {
    200: { description: 'A page of batches.', $ref: 'adminStockBatchesResponseSchema#' },
    ...stockErrors('the batches'),
  },
} satisfies FastifySchema;

// Schema for the journal of the stock
const getStockMovementsSchema = {
  operationId: 'getStockMovements',
  summary: 'List the steps of the stock',
  description:
    'Every step of the stock of a product in one list: a delivery and a write-off (a line ' +
    'for each product, with the admin), a sale (the units a paid order took, at the payment) ' +
    'and a cancel (the same units back in the same batches, at the cancel of the paid order). ' +
    '`quantity` and `value` are the change: in above 0, out below; `batches` are the batches ' +
    'in the order the units were taken. Newest first unless asked; a page at a time. This ' +
    'operation is restricted to privileged users.',

  querystring: {
    $ref: 'adminStockMovementsQuerySchema#',
    examples: [{ productId: 10, kind: 'delivery,writeOff' }],
  },

  response: {
    200: { description: 'A page of steps.', $ref: 'adminStockMovementsResponseSchema#' },
    ...stockErrors('the journal of the stock'),
  },
} satisfies FastifySchema;

// Group admin routes under the admin Swagger tag
// Schema for the admin log
const getAuditLogSchema = {
  operationId: 'getAdminAuditLog',
  summary: 'Get the admin log',
  description:
    'The lines of the admin log, the newest first: who did what to what, the changes, the ' +
    'address and the browser of the request (none for the work of the server alone). Filters: ' +
    'the account (`actorId`), the role it wrote with (`actorRole`), the thing (`entityType`, ' +
    '`entityId`), the actions (`actions`), a field among the changes (`field`), the period ' +
    '(`from` taken in, `to` left out). `format=csv` gives every line of the filters ' +
    'as a file, without pages. Admin and root read every line.',

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
        '(INVALID_STATS_PERIOD), a cursor of another list (CURSOR_INVALID).',
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

// Schema for the alerts of an admin
const getAlertsSchema = {
  operationId: 'getAdminAlerts',
  summary: 'Get the alerts',
  description:
    'What waits for the work of an admin, each kind of the zone of the actor with how many ' +
    'cases wait now, counted with the thresholds of the actor (GET ' +
    '/api/admin/alerts/subscriptions): paid orders to ship (`paid_orders_waiting`), shipped ' +
    'orders not delivered for some days (`shipped_orders_waiting`), products of the catalog ' +
    'with no free units (`out_of_stock`) or with a few (`low_stock`), batches whose last good ' +
    'day is in some days (`expiring_batches`) or over with units left (`expired_batches`), ' +
    'chats with a message no admin has read (`chats_waiting`), late payments given back in ' +
    'some last days (`refunded_payments`), a reservation worker that has not run for some ' +
    'seconds (`worker_stalled`). Root also gets the lines the admins wrote in some last hours ' +
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
    'kind is followed until the actor turns it off. Each admin and each root has their own.',

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
          'No such kind for the actor (ALERT_KIND_NOT_FOUND): admin_actions is a kind of root.',
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
          'No such kind for the actor (ALERT_KIND_NOT_FOUND): admin_actions is a kind of root; ' +
          'a kind without a threshold (ALERT_THRESHOLD_NOT_FOUND).',
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
          ? 'No such kind with cases for the actor (ALERT_KIND_NOT_FOUND): worker_stalled has ' +
            'no cases, admin_actions is a kind of root; no case of the kind waits with the id ' +
            '(ALERT_ITEM_NOT_FOUND).'
          : 'No such kind with cases for the actor (ALERT_KIND_NOT_FOUND): worker_stalled has ' +
            'no cases, admin_actions is a kind of root.',
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
    getAccountingCategoriesSchema,
    getAccountingTimelineSchema,
    getStockBatchesSchema,
    getStockMovementsSchema,
    getAuditLogSchema,
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
