import {
  AUDIT_EVENTS,
  CONSENT_EVENTS,
  LOGIN_EVENTS,
  MONEY_LOG_EVENTS,
  PRICE_LOG_EVENTS,
  STOCK_LOG_EVENTS,
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
    from: { ...dateTimeSchema, description: 'The start of the period, taken in.' },
    to: { ...dateTimeSchema, description: 'The end of the period, left out.' },
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
    'The totals of the orders paid (cancelled later or not), by the time of the payment. In ' +
    'orders.revenue the delivery is part of the totals, orders.deliveryRevenue is the delivery ' +
    'alone. orders.returned is what went back with the returns (the units and their part of the ' +
    'delivery), by the time the money went back: the same fields, the periods are of that time.',
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
    returned: { $ref: 'adminStatsOrdersRevenueSchema#' },

    averageOrderValue: {
      ...nonNegativeNumberSchema,
      description: 'The average total of the orders paid in the period, cancelled later or not.',
    },
    itemsSold: {
      ...nonNegativeIntegerSchema,
      description: 'The units of the orders paid in the period, cancelled later or not.',
    },
  },
  required: [
    'total',
    'confirmedTotal',
    'pendingCartsTotal',
    'byStatus',
    'revenue',
    'deliveryRevenue',
    'returned',
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
    outOfStockTotal: {
      ...nonNegativeIntegerSchema,
      description:
        'The products of the catalog none of whose variants in sale has a free unit (the stock ' +
        'less the reserve and the units of batches that are over); the variants taken out of ' +
        'sale are not counted.',
    },

    topProductsByRevenue: {
      type: 'array',
      description:
        'The 5 products of the most money paid in the period; a product is the sum of all ' +
        'its variants.',
      items: { $ref: 'adminTopProductRevenueSchema#' },
    },

    topVariantsByRevenue: {
      type: 'array',
      description:
        'The 5 variants of the most money paid in the period, each with its product. The ' +
        'product that sold in two variants is one line of topProductsByRevenue (the sales of ' +
        'its variants together) and two lines here.',
      items: { $ref: 'adminTopVariantRevenueSchema#' },
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
    'topVariantsByRevenue',
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
    'The money of the period: what came in, what went out, what each income left, read from the ' +
    'money journal by the time its lines were written. The orders are the ones paid in the ' +
    'period; what goes back later (a return) is in the period its money was written, and never ' +
    'changes the period the order was paid in.',
  properties: {
    income: {
      type: 'object',
      additionalProperties: false,
      description:
        'The items of the orders paid in the period less the returns of it, their delivery less ' +
        'what went back, together.',
      properties: { items: { type: 'number' }, delivery: nullableMoney, total: { type: 'number' } },
      required: ['items', 'delivery', 'total'],
    },
    expenses: {
      type: 'object',
      additionalProperties: false,
      description:
        'What the items kept cost (the batches they took, less the units that came back), the ' +
        'units written off in the period, the sends and the parcels back the shop owes the ' +
        'carriers for, what the disputes, the refunds made by hand and the compensations cost ' +
        'past the returns (otherRefunds: what the bank kept and what went out by hand, less what ' +
        'the decisions gave the goods, which the returns of the products count, and less what ' +
        'statements took of it for the delivery; with the compensations, less what carriers paid ' +
        'the shop), together. A payment the order could not take is the money of the buyer, never ' +
        'an income.',
      properties: {
        costOfGoods: { type: 'number' },
        writeOffs: { type: 'number' },
        shipping: nullableMoney,
        otherRefunds: nullableMoney,
        total: { type: 'number' },
      },
      required: ['costOfGoods', 'writeOffs', 'shipping', 'otherRefunds', 'total'],
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
        'Only the variants of these products, ids through commas, up to 100 ' +
        '(PRODUCT_IDS_INVALID); every product without it.',
    },
    variantIds: {
      type: 'string',
      pattern: '^[1-9][0-9]*(,[1-9][0-9]*)*$',
      description:
        'Only these variants, ids through commas, up to 100 (VARIANT_IDS_INVALID); with ' +
        'productIds, the variants of those products that are among these; every variant ' +
        'without it.',
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
    'The delivery of all orders in the period, apart from the products, read from the money ' +
    'journal. Null when the report is of some products or of a category: the delivery belongs ' +
    'to no product.',
  properties: {
    income: {
      type: 'object',
      additionalProperties: false,
      description:
        'What the payments written in the period, cancelled later or not, paid for the ' +
        'delivery; orders counts the ones that paid for it (a delivery that cost nothing is none).',
      properties: { orders: nonNegativeIntegerSchema, revenue: { type: 'number' } },
      required: ['orders', 'revenue'],
    },
    refunded: {
      type: 'object',
      additionalProperties: false,
      description:
        'The delivery that went back with the money of the statements written in the period ' +
        '(the transfers and the money sent outside the app, less their failures); orders counts ' +
        'the ones whose delivery went back. The income of the period the order was paid in keeps ' +
        'it.',
      properties: { orders: nonNegativeIntegerSchema, revenue: { type: 'number' } },
      required: ['orders', 'revenue'],
    },
    shipping: {
      type: 'object',
      additionalProperties: false,
      description:
        'The sends the shop owes the carriers for, by the time they were sent (shippedAt): a ' +
        'send taken back with its cost kept counts, one the carrier was not paid for does not. ' +
        'withoutCost counts the sends of them that have no cost (none written, or 0).',
      properties: {
        sends: nonNegativeIntegerSchema,
        cost: {
          type: 'number',
          description:
            'The costs of the sends the shop owes for, written in the period, with the ' +
            'corrections in theirs, to the cent.',
        },
        withoutCost: nonNegativeIntegerSchema,
      },
      required: ['sends', 'cost', 'withoutCost'],
    },
    returnShipping: {
      type: 'object',
      additionalProperties: false,
      description:
        'The parcels the shop paid to carry goods back from buyers (recorded by an admin on a ' +
        'statement of return), by the time they were sent (the time the admin gave). ' +
        'withoutCost counts the ones that have no cost (none written, or 0).',
      properties: {
        sends: nonNegativeIntegerSchema,
        cost: {
          type: 'number',
          description:
            'The costs of the parcels written in the period, with the corrections in theirs, to ' +
            'the cent.',
        },
        withoutCost: nonNegativeIntegerSchema,
        deducted: {
          type: 'number',
          description:
            'The cost of the way back the buyers owed, taken off the transfers written in the ' +
            'period (less their failures): an income.',
        },
        reimbursed: {
          type: 'number',
          description:
            'The cost of the way back root paid back to buyers outside the app in the period: ' +
            'spent.',
        },
      },
      required: ['sends', 'cost', 'withoutCost', 'deducted', 'reimbursed'],
    },
    result: {
      type: 'number',
      description:
        'The income less what went back and less what the carriers cost, the parcels back too: ' +
        'what the delivery earned.',
    },
  },
  required: ['income', 'refunded', 'shipping', 'returnShipping', 'result'],
} as const;

const signedMoney = (description: string) => ({ type: 'number', description }) as const;

// the money the payments moved past the statements in a period, of no product: only a report of
// the whole shop has it
const adminPaymentsMoneySchema = {
  type: ['object', 'null'],
  additionalProperties: false,
  description:
    'The money the payments moved past the statements in the period, read from the money ' +
    'journal by the time its lines were written; result is what each left the money of the ' +
    'shop, below 0 the shop is without it. Null when the report is of some products or of a ' +
    'category: it belongs to no product.',
  properties: {
    disputes: {
      type: 'object',
      additionalProperties: false,
      description: 'The disputes at the bank of the payments of orders.',
      properties: {
        withdrawn: signedMoney('What the bank took (the fee of the dispute apart).'),
        reinstated: signedMoney('What the bank gave back.'),
        used: signedMoney(
          'What the transfers of statements took of the money of lost disputes as money the ' +
            'buyer had back (the returns count it), less their failures.',
        ),
        undecided: signedMoney(
          'Of withdrawn, what the bank took for a dispute lost that root has not said what it was ' +
            'for yet (in the period of the line; known once decided).',
        ),
        result: signedMoney('reinstated - withdrawn + used.'),
      },
      required: ['withdrawn', 'reinstated', 'used', 'undecided', 'result'],
    },
    handRefunds: {
      type: 'object',
      additionalProperties: false,
      description:
        'The refunds made by hand in the dashboard of the provider for the payments of orders, ' +
        'less their failures and with the money sent outside the app after one, by what root or ' +
        'the system decided they were (as decided now; refunded stays as it was).',
      properties: {
        refunded: signedMoney('What went out by hand: compensations + coverage + undecided.'),
        compensations: signedMoney('Given for what the app does not follow, such as a gesture.'),
        coverage: signedMoney('Counted for what a statement of the order owes the buyer.'),
        undecided: signedMoney('Not decided by root yet.'),
        used: signedMoney(
          'What the transfers of statements took of them as money the buyer had back (the ' +
            'returns count it), less their failures.',
        ),
        result: signedMoney('used - refunded.'),
      },
      required: ['refunded', 'compensations', 'coverage', 'undecided', 'used', 'result'],
    },
    latePayments: {
      type: 'object',
      additionalProperties: false,
      description:
        'The payments the orders could not take (a second payment, a wrong sum, an order that ' +
        'was gone): the money of the buyers until it goes back, no income.',
      properties: {
        received: signedMoney('What came in.'),
        refunded: signedMoney(
          'What of them went back in any way: the refunds of the app and by hand (less their ' +
            'failures), the money sent outside the app, what the bank took for a dispute.',
        ),
        result: signedMoney('received - refunded: not 0 is money of buyers still at the shop.'),
      },
      required: ['received', 'refunded', 'result'],
    },
    compensations: {
      type: 'object',
      additionalProperties: false,
      description:
        'The compensations root gave by the button of the app (POST /api/payments/compensations), ' +
        'less their failures, with the money sent outside the app after one.',
      properties: {
        given: signedMoney('What went out.'),
        result: signedMoney('- given.'),
      },
      required: ['given', 'result'],
    },
    received: {
      type: 'object',
      additionalProperties: false,
      description:
        'The money the shop got back outside the app: from buyers for rows of statements (the ' +
        'returns of the products take it off), from carriers for the sends they lost.',
      properties: {
        buyers: signedMoney('From buyers.'),
        carriers: signedMoney('From carriers.'),
        result: signedMoney('buyers + carriers.'),
      },
      required: ['buyers', 'carriers', 'result'],
    },
  },
  required: ['disputes', 'handRefunds', 'latePayments', 'compensations', 'received'],
} as const;

const adminReturnKindSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    units: {
      type: 'integer',
      description: 'Below 0 in a period whose failures of transfers gave back more than went.',
    },
    revenue: { type: 'number', description: 'The money of the units that went back.' },
    cost: { type: 'number', description: 'What the units that came back cost (their batches).' },
  },
  required: ['units', 'revenue', 'cost'],
} as const;

const RETURN_KIND_NAMES = [
  'withdrawal',
  'refused',
  'defect',
  'wrong_item',
  'damaged',
  'goodwill',
  'shop_cancel',
  'other',
] as const;

const adminNetSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'The sales less the returns: what the items of the period earned. The percent of the margin ' +
    'is of the revenue, none without one.',
  properties: {
    units: { type: 'integer' },
    revenue: { type: 'number' },
    cost: { type: 'number' },
    margin: { type: 'number' },
    marginPercent: { type: ['number', 'null'] },
  },
  required: ['units', 'revenue', 'cost', 'margin', 'marginPercent'],
} as const;

const stockLineField = (description: string) => ({ ...adminUnitsValueSchema, description });

// the stock of a report, from the stock log (db/05): where it was, what came in and went out, where
// it is, and the goods on their way back
const adminStockTurnoverSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'The stock at its costs, read from the stock log, so a past period never changes: opening ' +
    '+ received - left = closing.',
  properties: {
    opening: stockLineField('The stock at the start of the period.'),
    received: stockLineField('Came in during the period: deliveries and units that came back.'),
    left: stockLineField(
      'Went out during the period: sales, write-offs and units that came back and were written ' +
        'off at once.',
    ),
    closing: stockLineField('The stock at the end of the period.'),
    onTheWayBack: stockLineField(
      'Units sold that a statement of return named and whose goods were not in at the end of ' +
        'the period: not in the stock, shown apart (at the cost of the order).',
    ),
  },
  required: ['opening', 'received', 'left', 'closing', 'onTheWayBack'],
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
        'The orders paid in the period (by paidAt), cancelled later or not: a return never ' +
        'takes an order out of the period it was paid in.',
    },
    returns: {
      type: 'object',
      additionalProperties: false,
      description:
        'The rows of the statements of return whose money was written in the period (the ' +
        'transfers and the money sent outside the app; a failure of a transfer gives its money ' +
        'back in the period the failure came, below 0): the money of the units, and what the ' +
        'units that came back cost, booked when the money and the goods are both back. orders ' +
        'counts the orders of the statements whose money went back in the period, less what ' +
        'failed in it. byKind tells the right of withdrawal from the reasons an admin gave.',
      properties: {
        orders: nonNegativeIntegerSchema,
        units: { type: 'integer' },
        revenue: { type: 'number' },
        cost: { type: 'number' },
        byKind: {
          type: 'object',
          additionalProperties: false,
          properties: Object.fromEntries(
            RETURN_KIND_NAMES.map((kind) => [kind, adminReturnKindSchema]),
          ),
          required: [...RETURN_KIND_NAMES],
        },
      },
      required: ['orders', 'units', 'revenue', 'cost', 'byKind'],
    },
    net: adminNetSchema,
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
      description:
        'The units written off in the period, by reason; customer_return is the goods that came ' +
        'back with a statement and went out of the stock at once.',
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
            customer_return: adminUnitsValueSchema,
          },
          required: [
            'damaged',
            'defective',
            'expired',
            'shortage',
            'returned_to_supplier',
            'other',
            'customer_return',
          ],
        },
      },
      required: ['units', 'value', 'byReason'],
    },
    stock: adminStockTurnoverSchema,
    delivery: adminDeliveryMoneySchema,
    payments: adminPaymentsMoneySchema,
  },
  required: [
    'period',
    'currency',
    'sales',
    'returns',
    'net',
    'summary',
    'purchases',
    'writeOffs',
    'stock',
    'delivery',
    'payments',
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
    'revenue (the default), margin, marginPercent and units are of the sales (the orders paid ' +
    'in the period); marginAfterWriteOffs is the margin of the net (the sales less the returns) ' +
    'less the write-offs; writeOffs and purchases are their value; stockValue and stockUnits ' +
    'are the stock at the end of the period; rows without a margin percent come last.',
} as const;

// the query of the report by product and of the report by variant
const adminReportProductsQuerySchema = {
  $id: 'adminReportProductsQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    from: adminAccountingQuerySchema.properties.from,
    to: adminAccountingQuerySchema.properties.to,
    productIds: adminAccountingQuerySchema.properties.productIds,
    variantIds: adminAccountingQuerySchema.properties.variantIds,
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
    variantIds: adminAccountingQuerySchema.properties.variantIds,
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
    'The items of the orders paid in the period, cancelled later or not, at their prices and ' +
    'their costs; the percent of the margin is of the revenue.',
  properties: {
    units: { type: 'integer' },
    revenue: moneyNumber,
    cost: moneyNumber,
    margin: moneyNumber,
    marginPercent: { type: ['number', 'null'], description: 'None without a revenue.' },
  },
  required: ['units', 'revenue', 'cost', 'margin', 'marginPercent'],
} as const;

const reportReturnsSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'The items whose money was written in the period (a failure of a transfer gives it back, ' +
    'below 0): the money of the units, and what the units that came back cost, booked when the ' +
    'money and the goods are both back.',
  properties: { units: { type: 'integer' }, revenue: moneyNumber, cost: moneyNumber },
  required: ['units', 'revenue', 'cost'],
} as const;

const reportAfterWriteOffsSchema = {
  type: 'object',
  additionalProperties: false,
  description:
    'The margin of the net (the sales less the returns) less the write-offs of the period; the ' +
    'percent is of the revenue of the net.',
  properties: {
    margin: moneyNumber,
    marginPercent: { type: ['number', 'null'], description: 'None without a revenue.' },
  },
  required: ['margin', 'marginPercent'],
} as const;

const reportMoneyProperties = {
  sales: reportSalesSchema,
  returns: reportReturnsSchema,
  net: adminNetSchema,
  writeOffs: { ...adminUnitsValueSchema, description: 'Written off in the period, at cost.' },
  afterWriteOffs: reportAfterWriteOffsSchema,
  purchases: { ...adminUnitsValueSchema, description: 'Taken in during the period, at cost.' },
} as const;

const reportMoneyRequired = [
  'sales',
  'returns',
  'net',
  'writeOffs',
  'afterWriteOffs',
  'purchases',
] as const;

const reportStockField = adminStockTurnoverSchema;

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

// the variant a line is about, as it is now
const stockVariantSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: positiveIntegerSchema,
    position: positiveIntegerSchema,
    name: { type: 'string' },
    sku: { type: ['string', 'null'] },
    deleted: {
      type: 'boolean',
      description: 'Taken out of sale (so is every variant of a product removed from the catalog).',
    },
  },
  required: ['id', 'position', 'name', 'sku', 'deleted'],
} as const;

// a line of the top of variants of the statistics: the variant and its product, as the accounting
// names them
const adminTopVariantRevenueSchema = {
  $id: 'adminTopVariantRevenueSchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    product: stockProductSchema,
    variant: stockVariantSchema,
    revenue: nonNegativeNumberSchema,
    quantitySold: nonNegativeIntegerSchema,
  },
  required: ['product', 'variant', 'revenue', 'quantitySold'],
} as const;

const reportCategoryRefSchema = {
  type: 'object',
  additionalProperties: false,
  properties: { id: { type: 'integer' }, name: { type: 'string' } },
  required: ['id', 'name'],
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
          product: stockProductSchema,
          category: reportCategoryRefSchema,
          ...reportMoneyProperties,
          stock: reportStockField,
        },
        required: ['product', 'category', ...reportMoneyRequired, 'stock'],
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

const adminReportVariantsResponseSchema = {
  $id: 'adminReportVariantsResponseSchema',
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
          product: stockProductSchema,
          variant: stockVariantSchema,
          category: reportCategoryRefSchema,
          ...reportMoneyProperties,
          stock: reportStockField,
        },
        required: ['product', 'variant', 'category', ...reportMoneyRequired, 'stock'],
      },
    },
    totals: {
      type: 'object',
      additionalProperties: false,
      description:
        'Of every variant of the filter, not only of the page: the totals of the report by ' +
        'product for the same filter.',
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
          payments: adminPaymentsMoneySchema,
          summary: moneySummarySchema,
        },
        required: ['label', 'period', ...reportMoneyRequired, 'delivery', 'payments', 'summary'],
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
export const STOCK_MOVEMENT_KINDS = [
  'delivery',
  'writeOff',
  'sale',
  'return',
  'returnWriteOff',
] as const;
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
    productId: stockIdQueryField('batches of the variants of this product'),
    variantId: stockIdQueryField('batches of this variant'),
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
          variant: stockVariantSchema,
          unitCost: nonNegativeNumberSchema,
          quantity: positiveIntegerSchema,
          remaining: nonNegativeIntegerSchema,
          sold: {
            ...nonNegativeIntegerSchema,
            description:
              'The units of the paid orders less the units their statements of return brought back (a unit written off or lost on its way back counts as written off).',
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
          'variant',
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
    productId: stockIdQueryField('steps of the variants of this product'),
    variantId: stockIdQueryField('steps of this variant'),
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
          variant: stockVariantSchema,
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
          'variant',
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

// the filters of the columns of the journals (journal.helper.ts, ColumnFilter)
const logIdFilter = (what: string) =>
  ({
    type: 'integer',
    minimum: 1,
    maximum: MAX_ID,
    description: `Only the lines ${what}.`,
  }) as const;
const logTextFilter = (what: string) =>
  ({
    type: 'string',
    minLength: 1,
    maxLength: 255,
    description: `Only the lines ${what}.`,
  }) as const;
const logEnumFilter = (values: readonly string[], what: string) =>
  ({ type: 'string', enum: [...values], description: `Only the lines ${what}.` }) as const;
const logBoundFilter = (what: string) =>
  ({ type: 'number', minimum: -99_999_999.99, maximum: 99_999_999.99, description: what }) as const;
const logTimeFilter = (what: string) => ({ ...dateTimeSchema, description: what }) as const;
const LOG_ROLES = ['USER', 'ADMIN', 'ROOT'] as const;

// the address and the browser of the request of a line, the lines of root never for an admin
const logRequestFilters = {
  ip: logTextFilter(
    'written from this address, as it is (for an admin, never the lines of root, whose address is hidden)',
  ),
  userAgent: logTextFilter(
    'whose browser has this text, in any case (for an admin, never the lines of root)',
  ),
} as const;

// the pages of the groups of a journal: up to three keys through commas, a sort, a page by an
// offset; the period, the events and the filters of the journal narrow the lines
const groupsQueryFields = (keys: readonly string[], sums: readonly string[]) =>
  ({
    groupBy: {
      type: 'string',
      pattern: `^(${keys.join('|')})(,(${keys.join('|')})){0,2}$`,
      description:
        `The keys the lines are taken together by, one to three through commas: ${keys.join(', ')} ` +
        '(day, week and month: of the time of the line, in utc; the week from its Monday). For an ' +
        'admin the account of root is one group of the id 0.',
    },
    sortBy: {
      type: 'string',
      pattern: `^(${[...keys, 'count', ...sums].join('|')})$`,
      description:
        `A key of groupBy, count or a sum (${sums.join(', ')}); count unless given ` +
        '(LOG_SORT_INVALID for a key not in groupBy).',
    },
    sortOrder: {
      type: 'string',
      enum: ['asc', 'desc'],
      description: 'desc (the largest first) unless given; the keys break ties.',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      description: 'The groups of a page, 100 unless given.',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      maximum: 1_000_000,
      description: 'The groups skipped before the page, 0 unless given.',
    },
    from: { ...dateTimeSchema, description: 'The start of the period, taken in.' },
    to: { ...dateTimeSchema, description: 'The end of the period, left out.' },
    events: {
      type: 'string',
      pattern: '^[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*(,[a-z][a-z0-9_]*[.][a-z][a-z0-9_]*)*$',
      description: 'Only the lines of these events, through commas (LOG_EVENTS_INVALID).',
    },
    format: {
      type: 'string',
      enum: ['json', 'csv'],
      description: 'csv gives every group of the filters as a file, without pages.',
    },
  }) as const;

// a page of the groups of a journal: each group has the keys asked for, the count and the sums
const groupsPageSchema = (
  id: string,
  keys: Record<string, unknown>,
  sums: Record<string, unknown>,
  what: string,
) =>
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
          description: `${what} The keys of groupBy, how many lines and the sums.`,
          properties: { ...keys, count: { type: 'integer' }, ...sums },
          required: ['count', ...Object.keys(sums)],
        },
      },
      total: { type: 'integer', description: 'The groups of the filters.' },
      limit: { type: 'integer' },
      offset: { type: 'integer' },
    },
    required: ['items', 'total', 'limit', 'offset'],
  }) as const;

const groupNumberKey = { type: ['integer', 'null'] } as const;
const groupTextKey = { type: ['string', 'null'] } as const;

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
  'NEWSLETTER_MANAGER_CHANGE',
  'MONEY_MANAGER_CHANGE',
  'NEWSLETTER_CAMPAIGN_CHANGE',
  'NEWSLETTER_SUBSCRIBER_DELETE',
  'NEWSLETTER_BLOCK_CHANGE',
  'OTHER',
] as const;
const AUDIT_ENTITY_TYPES = [
  'product',
  'variant',
  'user',
  'category',
  'order',
  'review',
  'party',
  'document',
  'attribute',
  'newsletter_campaign',
  'newsletter_subscriber',
  'newsletter_block',
  'other',
] as const;
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
    entityType: {
      type: 'string',
      enum: AUDIT_ENTITY_TYPES,
      description: 'Only the lines about this kind of thing.',
    },
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
    ...logRequestFilters,
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
  'variantId',
  'variant',
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
  'variantId',
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
    productId: {
      ...positiveIntegerSchema,
      description: 'Only the changes of the variants of this product.',
    },
    variantId: { ...positiveIntegerSchema, description: 'Only the changes of this variant.' },
    actorId: {
      ...positiveIntegerSchema,
      description: 'Only the changes of this account.',
    },
    mode: {
      type: 'string',
      enum: ['fixed', 'percent'],
      description: 'Only the changes given this way: by an amount of money or by a percent.',
    },
    oldPriceFrom: logBoundFilter('Only the lines whose price before is at least this.'),
    oldPriceTo: logBoundFilter('Only the lines whose price before is at most this.'),
    newPriceFrom: logBoundFilter('Only the lines whose new price is at least this.'),
    newPriceTo: logBoundFilter('Only the lines whose new price is at most this.'),
    endsFrom: logTimeFilter('Only the sales that end at this time or later.'),
    endsTo: logTimeFilter('Only the sales that end before this time.'),
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
    variantId: { type: 'integer' },
    variant: {
      type: 'object',
      additionalProperties: false,
      description: 'The variant whose price changed, as it is now.',
      properties: {
        id: { type: 'integer' },
        position: { type: 'integer' },
        name: { type: 'string' },
        sku: { type: ['string', 'null'] },
      },
      required: ['id', 'position', 'name', 'sku'],
    },
    actorId: { type: ['integer', 'null'] },
    actor: logAccountSchema,
    event: logEventSchema(
      PRICE_LOG_EVENTS,
      'What made the line: a price of one variant, of many, of a selection, the start of a sale, its end.',
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
  'A line of the log of prices: one variant.',
);

// the stock log
const STOCK_LOG_COLUMNS = [
  'id',
  'createdAt',
  'actorId',
  'actor',
  'actorRole',
  'productId',
  'product',
  'variantId',
  'variant',
  'event',
  'quantityChange',
  'stockAfter',
  'deliveryId',
  'writeOffId',
  'orderId',
  'returnItemId',
  'ip',
  'userAgent',
  'changes',
] as const;
const STOCK_LOG_SORTS = [
  'id',
  'createdAt',
  'actorId',
  'actorRole',
  'productId',
  'variantId',
  'event',
  'quantityChange',
  'stockAfter',
  'deliveryId',
  'writeOffId',
  'orderId',
  'returnItemId',
  'ip',
  'userAgent',
] as const;

const adminStockLogQuerySchema = {
  $id: 'adminStockLogQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    productId: stockIdQueryField('lines of the variants of this product'),
    variantId: stockIdQueryField('lines of this variant'),
    deliveryId: {
      type: 'string',
      format: 'uuid',
      description: 'Only the lines of this delivery (the deliveryId its response gave).',
    },
    writeOffId: {
      type: 'string',
      format: 'uuid',
      description: 'Only the lines of this write-off (the writeOffId its response gave).',
    },
    orderId: stockIdQueryField('lines of this order: the sale at its payment and the units back'),
    actorId: logIdFilter('of this account (for an admin, root is never found by its id)'),
    actorRole: logEnumFilter(LOG_ROLES, 'written by an account of this role then'),
    returnId: stockIdQueryField('lines of the units of this statement of return'),
    returnItemId: stockIdQueryField('lines of the units of this row of a statement'),
    categoryId: stockIdQueryField('lines of the products of this category (not of its children)'),
    quantityFrom: logBoundFilter('Only the lines whose change is at least this (1: what came in).'),
    quantityTo: logBoundFilter('Only the lines whose change is at most this (-1: what went out).'),
    stockAfterFrom: logBoundFilter('Only the lines whose stock after the change is at least this.'),
    stockAfterTo: logBoundFilter('Only the lines whose stock after the change is at most this.'),
    ...logRequestFilters,
    ...journalQueryFields(STOCK_LOG_SORTS, STOCK_LOG_COLUMNS, STOCK_LOG_EVENTS),
  },
} as const;

const adminStockLogPageSchema = journalPageSchema(
  'adminStockLogResponseSchema',
  {
    id: { type: 'integer' },
    createdAt: dateTimeSchema,
    actorId: {
      type: ['integer', 'null'],
      description:
        'The id of the account that did it; none for the work of the system (the sale at the ' +
        'payment of an order); 0 for an admin where it is root.',
    },
    actor: {
      anyOf: [logAccountSchema, { type: 'null' }],
      description: 'The account that did it; none for the work of the system.',
    },
    actorRole: {
      type: ['string', 'null'],
      enum: ['USER', 'ADMIN', 'ROOT', null],
      description: 'The role it had when it did it; none for the work of the system.',
    },
    productId: { type: 'integer' },
    product: {
      type: 'object',
      additionalProperties: false,
      properties: { id: { type: 'integer' }, name: { type: 'string' } },
      required: ['id', 'name'],
    },
    variantId: { type: 'integer' },
    variant: {
      type: 'object',
      additionalProperties: false,
      description: 'The variant whose stock changed, as it is now.',
      properties: {
        id: { type: 'integer' },
        position: { type: 'integer' },
        name: { type: 'string' },
        sku: { type: ['string', 'null'] },
      },
      required: ['id', 'position', 'name', 'sku'],
    },
    event: logEventSchema(
      STOCK_LOG_EVENTS,
      'What made the line: a delivery, a write-off, a sale at the payment of an order, the units ' +
        'back at the cancel of a paid order.',
    ),
    quantityChange: {
      type: 'integer',
      description: 'The change of the stock: units in above 0, units out below 0.',
    },
    stockAfter: { type: 'integer', description: 'The stock of the variant after the change.' },
    deliveryId: {
      type: ['string', 'null'],
      format: 'uuid',
      description: 'The delivery of a delivery line; all its lines carry the same id.',
    },
    writeOffId: {
      type: ['string', 'null'],
      format: 'uuid',
      description: 'The write-off of a write-off line; all its lines carry the same id.',
    },
    orderId: {
      type: ['integer', 'null'],
      description: 'The order of a sale line and of a line of units back.',
    },
    returnItemId: {
      type: ['integer', 'null'],
      description:
        'The row of the statement of return the units came back with (stock.return, ' +
        'stock.return_write_off); the statement is in the card of the order.',
    },
    ip: logIpSchema,
    userAgent: logUserAgentSchema,
    changes: {
      type: 'array',
      description:
        'What the change was made of, each field with its value before and after: the batches ' +
        'with their units and costs, the reason of a write-off, the source, the supplier, the ' +
        'invoice and the note of a delivery.',
      items: {
        type: 'object',
        properties: { field: { type: 'string' }, old: {}, new: {} },
        required: ['field'],
      },
    },
  },
  'A line of the stock log: one variant, one change.',
);

// the money log
const MONEY_PURPOSES = [
  'order',
  'return',
  'late_payment',
  'hand',
  'dispute',
  'shipping',
  'compensation',
] as const;
const MONEY_PARTS = ['goods', 'delivery', 'deduction', 'way_back', 'covered', 'whole'] as const;
const MONEY_STATES = ['in_transit', 'sent'] as const;
const MONEY_FAILURES = [
  'card_unavailable',
  'shop_balance',
  'disputed',
  'already_refunded',
  'unknown',
] as const;
const MONEY_METHODS = ['bank_transfer', 'cash', 'other'] as const;
const MONEY_USES = ['goods', 'compensation', 'loss'] as const;
const MONEY_PROVIDERS = ['stripe'] as const;

const MONEY_LOG_COLUMNS = [
  'id',
  'createdAt',
  'actorId',
  'actor',
  'actorRole',
  'event',
  'purpose',
  'part',
  'amount',
  'currency',
  'orderId',
  'userId',
  'user',
  'returnId',
  'orderShipmentId',
  'disputeId',
  'coversId',
  'provider',
  'paymentId',
  'refundId',
  'transferKey',
  'stripeTxId',
  'bankReference',
  'byDashboard',
  'state',
  'stateAt',
  'failure',
  'failureText',
  'method',
  'note',
  'happenedAt',
  'moneyUse',
  'ip',
  'userAgent',
  'meta',
] as const;
const MONEY_LOG_SORTS = MONEY_LOG_COLUMNS.filter(
  (column) => column !== 'actor' && column !== 'user' && column !== 'meta',
);

const adminMoneyLogQuerySchema = {
  $id: 'adminMoneyLogQuerySchema',
  type: 'object',
  additionalProperties: false,
  properties: {
    orderId: stockIdQueryField('lines of this order'),
    userId: stockIdQueryField('lines of the money of this buyer, whatever order'),
    returnId: stockIdQueryField(
      'lines of this statement of return: its transfers, their failures, the money sent outside ' +
        'the app, the way back paid, the parcels back, the money by hand or of the bank it took',
    ),
    disputeId: stockIdQueryField('lines of this dispute: what the bank took and gave back'),
    paymentId: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      description: 'Only the lines of this payment at the provider (its id there, as it is).',
    },
    purpose: {
      type: 'string',
      enum: [...MONEY_PURPOSES],
      description:
        'Only the lines of this purpose: order (the payment of an order), return (the money of a ' +
        'statement to the buyer), late_payment (a payment the order could not take and what went ' +
        'back of it), hand (a refund made by hand in the dashboard of the provider), dispute (what ' +
        'the bank took and gave back), shipping (what the shop paid a carrier).',
    },
    state: {
      type: 'string',
      enum: [...MONEY_STATES],
      description:
        'Only the refunds that stand here: in_transit (asked of the provider, not told sent yet; ' +
        'a refund that failed stays here, its failure is a line of its own) or sent.',
    },
    actorId: logIdFilter('of this account (for an admin, root is never found by its id)'),
    actorRole: logEnumFilter(LOG_ROLES, 'written by an account of this role then'),
    part: logEnumFilter(MONEY_PARTS, 'of this part of a movement'),
    currency: logTextFilter('of this currency, as the provider writes it (eur)'),
    amountFrom: logBoundFilter(
      'Only the lines whose sum with its sign is at least this (0.01: what came in).',
    ),
    amountTo: logBoundFilter(
      'Only the lines whose sum with its sign is at most this (-0.01: what went out).',
    ),
    orderShipmentId: logIdFilter('of this send or parcel'),
    coversId: logIdFilter(
      'that name this line: its failure, the money sent another way, a part covered',
    ),
    provider: logEnumFilter(MONEY_PROVIDERS, 'of this provider'),
    refundId: logTextFilter('of this refund at the provider (its id there, as it is)'),
    transferKey: logTextFilter('of this transfer of the app (its key, as it is)'),
    stripeTxId: logTextFilter('of this transaction of the balance of the provider (a dispute)'),
    bankReference: logTextFilter('whose reference of the bank has this text, in any case'),
    byDashboard: {
      type: 'boolean',
      description: 'Only the refunds made in the dashboard of the provider (true) or not.',
    },
    failure: logEnumFilter(MONEY_FAILURES, 'of a failure of this reason'),
    method: logEnumFilter(MONEY_METHODS, 'of money that moved outside the app this way'),
    moneyUse: logEnumFilter(
      MONEY_USES,
      'of money given back by hand or taken by a bank decided so',
    ),
    note: logTextFilter('whose note has this text, in any case'),
    stateFrom: logTimeFilter('Only the refunds whose state is of this time or later.'),
    stateTo: logTimeFilter('Only the refunds whose state is of before this time.'),
    happenedFrom: logTimeFilter(
      'Only the money that really moved on this day or later (outside the app).',
    ),
    happenedTo: logTimeFilter(
      'Only the money that really moved before this time (outside the app).',
    ),
    ...logRequestFilters,
    ...journalQueryFields(MONEY_LOG_SORTS, MONEY_LOG_COLUMNS, MONEY_LOG_EVENTS),
  },
} as const;

const nullableDateTime = (description: string) =>
  ({ anyOf: [dateTimeSchema, { type: 'null' }], description }) as const;

const nullableEnum = (values: readonly string[], description: string) =>
  ({ type: ['string', 'null'], enum: [...values, null], description }) as const;

const adminMoneyLogPageSchema = journalPageSchema(
  'adminMoneyLogResponseSchema',
  {
    id: { type: 'integer' },
    createdAt: {
      ...dateTimeSchema,
      description: 'The time of the database the line was written at; the reports go by it.',
    },
    actorId: {
      type: ['integer', 'null'],
      description:
        'The id of the account that did it; none for the work of the system (the webhook, the ' +
        'worker); 0 for an admin where it is root.',
    },
    actor: {
      anyOf: [logAccountSchema, { type: 'null' }],
      description: 'The account that did it; none for the work of the system.',
    },
    actorRole: {
      type: ['string', 'null'],
      enum: ['USER', 'ADMIN', 'ROOT', null],
      description: 'The role it had when it did it; none for the work of the system.',
    },
    event: logEventSchema(
      MONEY_LOG_EVENTS,
      'What moved the money: a payment, a late payment, a refund, its failure, money sent ' +
        'outside the app, the way back paid to the buyer, the cost of a parcel back or of a send, ' +
        'what a dispute took or gave back, a correction of a sum.',
    ),
    purpose: {
      type: 'string',
      enum: [...MONEY_PURPOSES],
      description: 'What the money is for (see the filter purpose).',
    },
    part: {
      type: 'string',
      enum: [...MONEY_PARTS],
      description:
        'The part of the movement: goods and delivery of a payment or of a transfer, deduction ' +
        '(kept of a transfer for the way back, above 0), covered (the part of a transfer money ' +
        'by hand or of the bank already gave the buyer, above 0), whole (a movement without parts).',
    },
    amount: {
      type: 'number',
      description: 'The sum, to the cent: above 0 to the shop, below 0 from it, never 0.',
    },
    currency: { type: ['string', 'null'], description: 'The currency, when the line names one.' },
    orderId: {
      type: ['integer', 'null'],
      description: 'The order; none only when its row is gone (the number is then in meta).',
    },
    userId: {
      type: ['integer', 'null'],
      description: 'The buyer the money is of; 0 for an admin where it is root.',
    },
    user: {
      anyOf: [logUserSchema, { type: 'null' }],
      description: 'The buyer the money is of, as the account is now.',
    },
    returnId: { type: ['integer', 'null'], description: 'The statement of return.' },
    orderShipmentId: {
      type: ['integer', 'null'],
      description:
        'The parcel whose cost the line is: a send of an order, or a parcel of a statement (then the line names the statement too).',
    },
    disputeId: { type: ['integer', 'null'], description: 'The dispute at the bank.' },
    coversId: {
      type: ['integer', 'null'],
      description:
        'Another line: the one a failure reverses, a correction corrects, a covered part uses.',
    },
    provider: nullableEnum(MONEY_PROVIDERS, 'Who took the money.'),
    paymentId: { type: ['string', 'null'], description: 'The payment at the provider.' },
    refundId: {
      type: ['string', 'null'],
      description: 'The refund at the provider, once the provider gave it.',
    },
    transferKey: {
      type: ['string', 'null'],
      description:
        'Our key of the request to the provider, the same in every part of one transfer; kept in ' +
        'the refund at the provider.',
    },
    stripeTxId: {
      type: ['string', 'null'],
      description: 'The balance transaction of a dispute at the provider.',
    },
    bankReference: {
      type: ['string', 'null'],
      description: 'The number the bank gives to follow a refund.',
    },
    byDashboard: {
      type: 'boolean',
      description: 'The refund was made in the dashboard of the provider, not by this server.',
    },
    state: nullableEnum(
      MONEY_STATES,
      'Where a refund stands (lines of money.refund only); none for the others.',
    ),
    stateAt: nullableDateTime('Since when the refund stands where it is.'),
    failure: nullableEnum(
      MONEY_FAILURES,
      'Why a refund failed (lines of money.refund_failed): the card is gone, the balance of the ' +
        'shop is short, the buyer disputes the payment, the money went back already, unknown.',
    ),
    failureText: { type: ['string', 'null'], description: 'The words of the provider.' },
    method: nullableEnum(MONEY_METHODS, 'How money outside the app was sent.'),
    note: { type: ['string', 'null'], description: 'The note of the person who wrote it.' },
    happenedAt: nullableDateTime(
      'The day money outside the app really moved, as the person wrote it; only shown.',
    ),
    moneyUse: nullableEnum(
      MONEY_USES,
      'What root or the system decided money given back by hand or taken by a bank for a lost ' +
        'dispute was for: goods (all of it went to the items and the delivery of the order, ' +
        'meta), compensation (by hand: the rest the shop gave apart), loss (the bank: the rest the ' +
        'shop lost). Empty while nobody decided, and for any other line.',
    ),
    ip: logIpSchema,
    userAgent: logUserAgentSchema,
    meta: {
      type: 'array',
      description:
        'What the line is made of: for the goods of a transfer the rows of the statement it pays ' +
        '(returnItemId, variantId, amount), for a part covered the row and the item of the order ' +
        'it covers (returnItemId, orderItemId, amount), for money given back by hand or taken by a ' +
        'bank the shares of the decision (orderItemId, productId, variantId, quantity, unitPrice, ' +
        'amount; delivery), for a late payment the reason and the number of the order. Empty for ' +
        'a line without it.',
      items: { type: 'object', additionalProperties: true },
    },
  },
  'A line of the money log: one part of one movement of money.',
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
    ...logRequestFilters,
    ...journalQueryFields(LOGIN_LOG_SORTS, LOGIN_LOG_COLUMNS, LOGIN_EVENTS),
  },
} as const;

const adminStockLogResponseSchema = {
  ...adminStockLogPageSchema,
  properties: {
    ...adminStockLogPageSchema.properties,
    sums: {
      type: 'object',
      additionalProperties: false,
      description: 'The sum of the changes of every line of the filters, not of the page alone.',
      properties: { quantityChange: { type: 'integer' } },
      required: ['quantityChange'],
    },
  },
  required: [...adminStockLogPageSchema.required, 'sums'],
} as const;

const adminMoneyLogResponseSchema = {
  ...adminMoneyLogPageSchema,
  properties: {
    ...adminMoneyLogPageSchema.properties,
    sums: {
      type: 'array',
      description:
        'The sums of every line of the filters, not of the page alone, one for each currency (above ' +
        '0 came to the shop).',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { currency: { type: ['string', 'null'] }, amount: { type: 'number' } },
        required: ['currency', 'amount'],
      },
    },
  },
  required: [...adminMoneyLogPageSchema.required, 'sums'],
} as const;

// the groups of the stock log and of the money log (GET /api/admin/stock-log/groups,
// /money-log/groups): the filters of the journal, the keys and the sums
const STOCK_GROUP_KEYS = [
  'event',
  'actorRole',
  'actorId',
  'productId',
  'variantId',
  'categoryId',
  'orderId',
  'deliveryId',
  'writeOffId',
  'day',
  'week',
  'month',
] as const;
const MONEY_GROUP_KEYS = [
  'event',
  'purpose',
  'part',
  'currency',
  'provider',
  'state',
  'failure',
  'method',
  'moneyUse',
  'actorRole',
  'actorId',
  'userId',
  'orderId',
  'returnId',
  'disputeId',
  'day',
  'week',
  'month',
] as const;

const adminStockLogGroupsQuerySchema = {
  $id: 'adminStockLogGroupsQuerySchema',
  type: 'object',
  additionalProperties: false,
  required: ['groupBy'],
  properties: {
    productId: stockIdQueryField('lines of the variants of this product'),
    variantId: stockIdQueryField('lines of this variant'),
    deliveryId: { type: 'string', format: 'uuid', description: 'Only the lines of this delivery.' },
    writeOffId: {
      type: 'string',
      format: 'uuid',
      description: 'Only the lines of this write-off.',
    },
    orderId: stockIdQueryField('lines of this order'),
    actorId: logIdFilter('of this account (for an admin, root is never found by its id)'),
    actorRole: logEnumFilter(LOG_ROLES, 'written by an account of this role then'),
    returnId: stockIdQueryField('lines of the units of this statement of return'),
    returnItemId: stockIdQueryField('lines of the units of this row of a statement'),
    categoryId: stockIdQueryField('lines of the products of this category (not of its children)'),
    quantityFrom: logBoundFilter('Only the lines whose change is at least this (1: what came in).'),
    quantityTo: logBoundFilter('Only the lines whose change is at most this (-1: what went out).'),
    stockAfterFrom: logBoundFilter('Only the lines whose stock after the change is at least this.'),
    stockAfterTo: logBoundFilter('Only the lines whose stock after the change is at most this.'),
    ...logRequestFilters,
    ...groupsQueryFields(STOCK_GROUP_KEYS, ['quantityChange']),
  },
} as const;

const adminStockLogGroupsResponseSchema = groupsPageSchema(
  'adminStockLogGroupsResponseSchema',
  {
    event: groupTextKey,
    actorRole: groupTextKey,
    actorId: groupNumberKey,
    productId: groupNumberKey,
    variantId: groupNumberKey,
    categoryId: groupNumberKey,
    orderId: groupNumberKey,
    deliveryId: groupTextKey,
    writeOffId: groupTextKey,
    day: groupTextKey,
    week: groupTextKey,
    month: groupTextKey,
  },
  { quantityChange: { type: 'integer', description: 'The sum of the changes of the group.' } },
  'A group of the lines of the stock log.',
);

const adminMoneyLogGroupsQuerySchema = {
  $id: 'adminMoneyLogGroupsQuerySchema',
  type: 'object',
  additionalProperties: false,
  required: ['groupBy'],
  properties: {
    orderId: stockIdQueryField('lines of this order'),
    userId: stockIdQueryField('lines of the money of this buyer'),
    returnId: stockIdQueryField('lines of this statement of return'),
    disputeId: stockIdQueryField('lines of this dispute'),
    paymentId: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      description: 'Only the lines of this payment at the provider.',
    },
    purpose: logEnumFilter(MONEY_PURPOSES, 'of this purpose'),
    state: logEnumFilter(MONEY_STATES, 'of the refunds that stand here'),
    actorId: logIdFilter('of this account (for an admin, root is never found by its id)'),
    actorRole: logEnumFilter(LOG_ROLES, 'written by an account of this role then'),
    part: logEnumFilter(MONEY_PARTS, 'of this part of a movement'),
    currency: logTextFilter('of this currency, as the provider writes it (eur)'),
    amountFrom: logBoundFilter(
      'Only the lines whose sum with its sign is at least this (0.01: what came in).',
    ),
    amountTo: logBoundFilter(
      'Only the lines whose sum with its sign is at most this (-0.01: what went out).',
    ),
    orderShipmentId: logIdFilter('of this send or parcel'),
    coversId: logIdFilter(
      'that name this line: its failure, the money sent another way, a part covered',
    ),
    provider: logEnumFilter(MONEY_PROVIDERS, 'of this provider'),
    refundId: logTextFilter('of this refund at the provider (its id there, as it is)'),
    transferKey: logTextFilter('of this transfer of the app (its key, as it is)'),
    stripeTxId: logTextFilter('of this transaction of the balance of the provider (a dispute)'),
    bankReference: logTextFilter('whose reference of the bank has this text, in any case'),
    byDashboard: {
      type: 'boolean',
      description: 'Only the refunds made in the dashboard of the provider (true) or not.',
    },
    failure: logEnumFilter(MONEY_FAILURES, 'of a failure of this reason'),
    method: logEnumFilter(MONEY_METHODS, 'of money that moved outside the app this way'),
    moneyUse: logEnumFilter(
      MONEY_USES,
      'of money given back by hand or taken by a bank decided so',
    ),
    note: logTextFilter('whose note has this text, in any case'),
    stateFrom: logTimeFilter('Only the refunds whose state is of this time or later.'),
    stateTo: logTimeFilter('Only the refunds whose state is of before this time.'),
    happenedFrom: logTimeFilter(
      'Only the money that really moved on this day or later (outside the app).',
    ),
    happenedTo: logTimeFilter(
      'Only the money that really moved before this time (outside the app).',
    ),
    ...logRequestFilters,
    ...groupsQueryFields(MONEY_GROUP_KEYS, ['amount']),
  },
} as const;

const adminMoneyLogGroupsResponseSchema = groupsPageSchema(
  'adminMoneyLogGroupsResponseSchema',
  {
    event: groupTextKey,
    purpose: groupTextKey,
    part: groupTextKey,
    currency: groupTextKey,
    provider: groupTextKey,
    state: groupTextKey,
    failure: groupTextKey,
    method: groupTextKey,
    moneyUse: groupTextKey,
    actorRole: groupTextKey,
    actorId: groupNumberKey,
    userId: groupNumberKey,
    orderId: groupNumberKey,
    returnId: groupNumberKey,
    disputeId: groupNumberKey,
    day: groupTextKey,
    week: groupTextKey,
    month: groupTextKey,
  },
  {
    amount: {
      type: 'number',
      description: 'The sum of the group with its sign (above 0 came in).',
    },
  },
  'A group of the lines of the money log.',
);

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
    ...logRequestFilters,
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
    stockLog: { type: 'array', items: { type: 'string', enum: [...STOCK_LOG_EVENTS] } },
    moneyLog: { type: 'array', items: { type: 'string', enum: [...MONEY_LOG_EVENTS] } },
  },
  required: ['auditLog', 'priceLog', 'loginLog', 'consentLog', 'stockLog', 'moneyLog'],
} as const;

// the alerts of an admin
const ALERT_KINDS = [
  'paid_orders_waiting',
  'shipped_orders_waiting',
  'pickup_not_collected',
  'shipped_without_cost',
  'shipped_without_tracking',
  'out_of_stock',
  'low_stock',
  'products_without_shipping_data',
  'variants_missing_required',
  'products_hidden_from_buyers',
  'expiring_batches',
  'expired_batches',
  'chats_waiting',
  'late_refunds',
  'late_refunds_in_transit',
  'late_refunds_failed',
  'return_refunds_in_transit',
  'return_refunds_failed',
  'hand_refunds_in_transit',
  'hand_refunds_failed',
  'compensation_refunds_in_transit',
  'compensation_refunds_failed',
  'dispute_refunds_in_transit',
  'dispute_refunds_failed',
  'bank_money_to_decide',
  'disputes_to_answer',
  'disputes_lost',
  'returns_manual_check',
  'returns_proof_waiting',
  'returns_goods_not_sent',
  'returns_money_late',
  'returns_goods_late',
  'returns_money_short',
  'returns_money_overpaid',
  'worker_stalled',
  'shop_settings_incomplete',
  'shop_locale_missing',
  'newsletter_undelivered',
  'newsletter_rejected',
  'newsletter_complaints',
  'newsletter_running_long',
  'newsletter_starting_soon',
  'newsletter_cancelled_by_limit',
  'newsletter_sending_halted',
  'hand_refunds_to_explain',
  'hand_refunds_to_decide',
  'fraud_warnings',
  'fraud_warnings_shipped',
  'payment_reviews',
  'admin_actions',
] as const;

const ALERT_THRESHOLD_UNITS = ['days', 'units', 'seconds', 'hours', 'percent', 'permille'] as const;

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
    kinds: {
      type: 'string',
      pattern: `^(${ALERT_KINDS.join('|')})(,(${ALERT_KINDS.join('|')}))*$`,
      description:
        'Only these kinds, through commas (a page that shows one alert counts only it); a kind ' +
        'outside the zone of the actor is left out. Every kind of the zone unless given.',
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
              'for the worker and for the stop of the sending worker.',
          },
          occurredAt: {
            anyOf: [dateTimeSchema, { type: 'null' }],
            description:
              'When the thing the alert tells of last happened, for a kind that is an event: ' +
              'the time of the last stop of the sending worker of the newsletters (it stops ' +
              'when the whole stream has a problem, and the alert goes out when a pass goes ' +
              'through). null for every other kind, and for this one while it has not stopped.',
          },
        },
        required: ['kind', 'subscribed', 'count', 'dismissed', 'threshold', 'list', 'occurredAt'],
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
    kind: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-z_]+$',
      description: 'The kind of the alert, one of those GET /api/admin/alerts lists.',
    },
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
    kind: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[a-z_]+$',
      description: 'The kind of the alert, one of those GET /api/admin/alerts lists.',
    },
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z0-9_-]+$',
      description:
        'The id of the case in the list of its kind: an order, a product, a batch, a chat, a ' +
        'statement of return, a newsletter campaign, a line of the admin log or the id of a refund ' +
        'at the payment provider (re_..., the failed and the unsent refunds).',
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
  adminTopVariantRevenueSchema,
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
  adminReportVariantsResponseSchema,
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
  adminStockLogQuerySchema,
  adminStockLogResponseSchema,
  adminMoneyLogQuerySchema,
  adminMoneyLogResponseSchema,
  adminStockLogGroupsQuerySchema,
  adminStockLogGroupsResponseSchema,
  adminMoneyLogGroupsQuerySchema,
  adminMoneyLogGroupsResponseSchema,
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
